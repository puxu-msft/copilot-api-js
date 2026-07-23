/**
 * http2-client unit tests against a local cleartext h2c server (no TLS — the
 * production TLS+keepalive connection is injected away via
 * setHttp2SessionFactoryForTests). Covers the Response adapter (status /
 * headers / json / text), streaming body (hand-built ReadableStream — the
 * Readable.toWeb path throws ERR_STREAM_PREMATURE_CLOSE under Bun), and
 * mid-stream RST → ReadableStream error (NOT a silent truncation).
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import http2 from "node:http2"
import net from "node:net"

import { setUpstreamTransportConfig } from "~/lib/state"
import {
  //
  closeHttp2Sessions,
  getH2SessionStatusSnapshot,
  http2Fetch,
  setConnectTimeoutForTests,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

import { waitUntil } from "../helpers/wait-until"

let server: http2.Http2Server
let url: string
const serverSessions = new Set<http2.ServerHttp2Session>()

type Handler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void
let handler: Handler

beforeEach(async () => {
  server = http2.createServer()
  server.on("session", (s) => serverSessions.add(s))
  server.on("stream", (stream, headers) => handler(stream, headers))
  server.on("sessionError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  url = `http://127.0.0.1:${port}`
  // Inject a cleartext h2c session to the test server in place of the prod TLS factory.
  setHttp2SessionFactoryForTests(() => http2.connect(url))
})

afterEach(async () => {
  setHttp2SessionFactoryForTests(undefined)
  closeHttp2Sessions()
  // Force-destroy any server sessions (a drop test may leave a half-open one)
  // so server.close() does not hang waiting for them.
  for (const s of serverSessions) {
    try {
      s.destroy()
    } catch {
      /* already gone */
    }
  }
  serverSessions.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("http2-client", () => {
  test("adapts an h2 response into a WHATWG Response (status/headers/json)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200, "content-type": "application/json", etag: "W/abc" })
      stream.end(JSON.stringify({ hello: "h2", n: [1, 2] }))
    }
    const res = await http2Fetch(`${url}/x`, { headers: { authorization: "Bearer t" } })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(res.headers.get("etag")).toBe("W/abc")
    expect(await res.json()).toEqual({ hello: "h2", n: [1, 2] })
  })

  test("non-2xx is reflected in status/ok, body still readable via text()", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 404 })
      stream.end("not found")
    }
    const res = await http2Fetch(`${url}/missing`, {})
    expect(res.status).toBe(404)
    expect(res.ok).toBe(false)
    expect(await res.text()).toBe("not found")
  })

  test("streams the body incrementally via response.body (ReadableStream)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200, "content-type": "text/event-stream" })
      stream.write("event: a\n\n")
      stream.write("event: b\n\n")
      setTimeout(() => stream.end("event: c\n\n"), 5)
    }
    const res = await http2Fetch(`${url}/stream`, {})
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let text = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += value
    }
    expect(text).toBe("event: a\n\nevent: b\n\nevent: c\n\n")
  })

  test("body cancel resolves after the owned h2 stream closes while a sibling keeps using the pooled session", async () => {
    let localStreamClosed = false
    handler = (stream, headers) => {
      if (headers[":path"] === "/cancel") {
        stream.respond({ ":status": 200, "content-type": "text/event-stream" })
        stream.write("data: first\n\n")
        return
      }
      stream.respond({ ":status": 200 })
      stream.end("sibling-ok")
    }

    const cancelled = await http2Fetch(`${url}/cancel`, { onStreamClosed: () => (localStreamClosed = true) })
    const sibling = await http2Fetch(`${url}/sibling`, {})
    expect(await sibling.text()).toBe("sibling-ok")

    await cancelled.body!.cancel("test disposal")

    expect(localStreamClosed).toBe(true)
    // A new sibling still succeeds on the pool after the owned stream was cancelled.
    const after = await http2Fetch(`${url}/sibling`, {})
    expect(await after.text()).toBe("sibling-ok")
  })

  test("POST sends the request body", async () => {
    handler = (stream) => {
      let body = ""
      stream.on("data", (d: Buffer) => (body += d.toString()))
      stream.on("end", () => {
        stream.respond({ ":status": 200, "content-type": "application/json" })
        stream.end(JSON.stringify({ echo: body }))
      })
    }
    const res = await http2Fetch(`${url}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) })
    expect(await res.json()).toEqual({ echo: '{"a":1}' })
  })

  test("forces accept-encoding: identity even when the caller supplies it (transport-owned, non-overridable)", async () => {
    handler = (stream, headers) => {
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ ae: headers["accept-encoding"] }))
    }
    // A passed-through client `accept-encoding: gzip` must NOT override identity —
    // node:http2 doesn't decompress, so a compressed body would break SSE parsing.
    const res = await http2Fetch(`${url}/ae`, { headers: { "accept-encoding": "gzip, br", "x-keep": "1" } })
    expect(await res.json()).toEqual({ ae: "identity" })
  })

  // NOTE: mid-stream truncation detection is NOT unit-testable under Bun.
  // Bun's node:http2 client delivers `response → data → end → close` (rstCode=0)
  // for ANY mid-stream termination — clean server RST_STREAM AND full
  // connection drop alike (verified, exp/upstream-models-hang/) — i.e. a
  // synthetic clean `end`. The adapter's `error` / `close-before-end` backstops
  // still fire under Node (the compat runtime) and on any genuine `req` error,
  // but under Bun a truncated upstream body reads as complete. The app-layer
  // backstop is the missing terminal SSE event (message_stop / [DONE]) detected
  // downstream. This is strictly better than the undici path it replaces, which
  // HANGS forever under Bun on these hosts rather than truncating.

  test("a pre-aborted signal rejects without opening a stream", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    const res = http2Fetch(`${url}/x`, { signal: AbortSignal.abort() })
    await expect(res).rejects.toThrow(/abort/i)
  })

  test("pre-response abort rejects only after the owned h2 stream close callback", async () => {
    handler = () => {
      // Accept the request but never send response headers.
    }
    const abort = new AbortController()
    let localStreamClosed = false
    const pending = http2Fetch(`${url}/pending-headers`, {
      signal: abort.signal,
      onStreamClosed: () => {
        localStreamClosed = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    abort.abort()

    await expect(pending).rejects.toThrow(/abort/i)
    expect(localStreamClosed).toBe(true)
  })

  // Crash-safety: a pre-response abort on an ORPHANED fetch promise (the caller
  // stopped awaiting it — e.g. its await chain settled via another route) must
  // NOT surface as a process-level unhandledRejection. Without the defensive
  // rejection observer in http2Fetch, this rejection reaches
  // process.on("unhandledRejection") → exit(1) in main.ts, turning one cancelled
  // in-flight request into a whole-server crash (production incident: stale
  // reaper force-fail at 911s). The awaited path still rejects normally.
  test("an abandoned (no-awaiter) promise aborted pre-response does NOT emit a process unhandledRejection", async () => {
    // Silent handler: accept the stream but never respond — a pre-response stall.
    handler = () => {
      /* never respond */
    }
    const seen: Array<unknown> = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const ac = new AbortController()
      // Orphan the promise: no await, no .catch by the caller. Hold a ref so GC
      // doesn't collect it (GC'd unhandled rejections behave differently).
      const orphan = http2Fetch(`${url}/stall`, { method: "POST", body: "{}", signal: ac.signal })
      void orphan
      // Fire the abort after the stream is open but before any response.
      await new Promise((r) => setTimeout(r, 30))
      ac.abort()
      // Let the rejection + any (absent) unhandled-rejection microtask flush.
      await new Promise((r) => setTimeout(r, 80))
      expect(seen).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  // The observer must NOT consume the rejection — a real awaiter still sees it.
  test("the defensive observer does not swallow the rejection from a real awaiter", async () => {
    handler = () => {
      /* never respond */
    }
    const ac = new AbortController()
    const p = http2Fetch(`${url}/stall`, { method: "POST", body: "{}", signal: ac.signal })
    setTimeout(() => ac.abort(), 30)
    await expect(p).rejects.toThrow(/abort/i)
  })

  test("captures HTTP/2 response trailers via onTrailers (after body, before end)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200, "content-type": "application/json" }, { waitForTrailers: true })
      stream.on("wantTrailers", () => {
        stream.sendTrailers({ "x-upstream-status": "ok", "grpc-status": "0" })
      })
      stream.end(JSON.stringify({ hi: 1 }))
    }
    const captured: { trailers: Record<string, string> | null } = { trailers: null }
    const res = await http2Fetch(`${url}/t`, { onTrailers: (t) => (captured.trailers = t) })
    expect(await res.json()).toEqual({ hi: 1 })
    await new Promise((r) => setTimeout(r, 20))
    expect(captured.trailers).toEqual({ "x-upstream-status": "ok", "grpc-status": "0" })
  })

  test("no trailers → onTrailers is never called", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    let called = false
    const res = await http2Fetch(`${url}/n`, { onTrailers: () => (called = true) })
    await res.text()
    await new Promise((r) => setTimeout(r, 20))
    expect(called).toBe(false)
  })

  // Crash-safety: a TLS connect that TIMES OUT must reject the fetch promise
  // WITHOUT crashing the process. awaitH2Handshake's onTimeout calls
  // settle(new Error(...)): it removes its own 'error' listener, then tears the
  // socket down. The timeout error is the socket's FIRST-EVER 'error' emission, so
  // if teardown re-emits it with no listener attached, Node RE-THROWS it as an
  // uncaughtException → main.ts process.exit(1) — one connect timeout crashes the
  // whole server (production incident: "[http2] TLS connect timeout after
  // 10000ms"). NB: the onError path canNOT reproduce this (its socket already
  // emitted 'error', so destroy wouldn't re-emit) — only this timeout path (and the
  // ALPN-downgrade path, which shares settle's fresh-error branch) does. The guard:
  // createSession wraps every socket in withErrorSink (crash-safety.ts), whose
  // permanent inert 'error' listener survives the teardown. This test drives the
  // real createSession path so it exercises that guard; the primitive itself is
  // unit-tested in crash-safety.unit.test.ts.
  test("a TLS connect timeout rejects WITHOUT a process uncaughtException", async () => {
    // A raw TCP server that accepts the connection but never speaks TLS — the
    // upstream handshake stalls until the (shortened) connect deadline fires.
    // Bind on `localhost` (not "127.0.0.1"): the client dials `https://localhost`
    // below, and binding the server to the SAME hostname makes both resolve to the
    // same address family — otherwise a `localhost`→::1 environment would dial ::1
    // while the server listens on 127.0.0.1 → ECONNREFUSED → the onError path, not
    // the timeout path we're locking (flaky red, not a false green).
    const blackhole = net.createServer(() => {
      /* accept, then never respond — no ServerHello, no RST */
    })
    await new Promise<void>((resolve) => blackhole.listen(0, "localhost", resolve))
    const port = (blackhole.address() as AddressInfo).port

    const seen: Array<unknown> = []
    const onUncaught = (err: unknown): void => {
      seen.push(err)
    }
    process.on("uncaughtException", onUncaught)
    // Use the real prod TLS factory (createSession/awaitH2Handshake), NOT the
    // injected h2c one which bypasses the handshake entirely; shorten the deadline.
    setHttp2SessionFactoryForTests(undefined)
    setConnectTimeoutForTests(150)
    try {
      // `localhost` (a hostname), not an IP literal — TLS SNI forbids IP servernames;
      // the blackhole above binds the same hostname so the address family agrees.
      await expect(http2Fetch(`https://localhost:${port}/x`, {})).rejects.toThrow(/connect timeout/)
      // Let any orphaned socket 'error' re-emit flush before asserting.
      await new Promise((r) => setTimeout(r, 80))
      expect(seen).toHaveLength(0)
    } finally {
      process.off("uncaughtException", onUncaught)
      setConnectTimeoutForTests(undefined)
      closeHttp2Sessions()
      await new Promise<void>((resolve) => blackhole.close(() => resolve()))
    }
  })

  // Crash-safety, SESSION leg: a session discarded by the shutdown-drain race
  // (closeHttp2Sessions() bumps poolEpoch while a session is being established) is
  // closed WITHOUT the normal-branch `drop` 'error' listener — its ONLY 'error'
  // listener is the withErrorSink getSession applies at the ownership point. If that
  // sink is absent, a later session 'error' (a socket RST during/after close) is
  // unheard → uncaughtException → process.exit(1). This is the site the first
  // point-fix missed; here the sink is the SOLE guard, so this test locks it
  // (positive control: drop getSession's withErrorSink → this test reds).
  test("a session discarded by the shutdown-drain race is crash-safe (sink is sole guard)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    // Gated factory: getSession awaits this, letting us bump poolEpoch mid-establish.
    let releaseSession!: (s: http2.ClientHttp2Session) => void
    const gate = new Promise<http2.ClientHttp2Session>((resolve) => {
      releaseSession = resolve
    })
    setHttp2SessionFactoryForTests(() => gate)

    const seen: Array<unknown> = []
    const onUncaught = (err: unknown): void => void seen.push(err)
    process.on("uncaughtException", onUncaught)
    try {
      const fetchP = http2Fetch(`${url}/race`, {})
      fetchP.catch(() => {}) // it rejects (session discarded) — observe so it isn't unhandled
      await new Promise((r) => setTimeout(r, 20)) // let getSession reach `await sessionFactory`
      closeHttp2Sessions() // bump poolEpoch → the in-flight creation lands in the race branch
      // Resolve the factory with a REAL session; getSession sinks it, then the race
      // branch closes + returns it WITHOUT attaching `drop`.
      const discarded = http2.connect(url)
      releaseSession(discarded)
      await new Promise((r) => setTimeout(r, 20))
      // The discarded session's only 'error' listener is the withErrorSink. Emit an
      // 'error' — without the sink this is unheard and crashes the process.
      discarded.emit("error", new Error("late session RST"))
      await new Promise((r) => setTimeout(r, 20))
      expect(seen).toHaveLength(0)
      await fetchP.catch(() => {})
    } finally {
      process.off("uncaughtException", onUncaught)
      setHttp2SessionFactoryForTests(undefined)
      closeHttp2Sessions()
    }
  })
})

// C2 pool-refactor invariants under N=0 (unlimited) — locks the BYTE-EQUIVALENT
// behavior: one shared session per origin, reservation released exactly once. N=0
// is set explicitly because the shipped default is now 1 (C3).
describe("http2-client pool (N=0 unlimited — byte-equivalent multiplex)", () => {
  beforeEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 0 }))
  afterEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1 }))

  test("N=0 concurrent cold-start converges on exactly ONE session (byte-equivalent)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    // Count how many client sessions the factory actually opens.
    let opened = 0
    setHttp2SessionFactoryForTests(() => {
      opened += 1
      return http2.connect(url)
    })
    try {
      // Fire concurrently BEFORE any session exists — both miss the live lookup;
      // the capacity-aware `pending` (N=0) must make the second JOIN the first's
      // connect rather than opening a second session.
      const [a, b] = await Promise.all([http2Fetch(`${url}/x`, {}), http2Fetch(`${url}/y`, {})])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      await Promise.all([a.text(), b.text()])
      expect(opened).toBe(1)
      // Exactly one pooled session for the origin.
      expect(getH2SessionStatusSnapshot()).toHaveLength(1)
    } finally {
      setHttp2SessionFactoryForTests(undefined)
      closeHttp2Sessions()
    }
  })

  test("reservation is released exactly once — activeStreamCount returns to 0 after a normal request (PATH 1)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    const res = await http2Fetch(`${url}/x`, {})
    await res.text() // drain to completion → stream close
    // Give the `close` event a tick to fire.
    await new Promise((r) => setTimeout(r, 20))
    const rows = getH2SessionStatusSnapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.activeStreamCount).toBe(0)
  })

  test("reservation is released on a pre-request abort (PATH 2) — no leaked slot", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    // Prime one live session so the aborted request takes the synchronous reuse path.
    const warm = await http2Fetch(`${url}/warm`, {})
    await warm.text()
    await new Promise((r) => setTimeout(r, 20))

    const ac = new AbortController()
    ac.abort()
    await expect(http2Fetch(`${url}/x`, { signal: ac.signal })).rejects.toThrow(/aborted/i)
    await new Promise((r) => setTimeout(r, 20))
    // The reused session's reservation taken synchronously must have been handed
    // back — count is 0, not a leaked 1.
    const rows = getH2SessionStatusSnapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.activeStreamCount).toBe(0)
  })
})

// C3: the shipped default N=1 — one concurrent stream per session, so a
// session-level teardown takes down at most one in-flight request.
describe("http2-client pool (N=1 cap — one stream per session, shipped default)", () => {
  beforeEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1 }))
  afterEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1 }))

  test("N=1 concurrent requests to one origin open SEPARATE sessions (peak activeStreamCount ≤ 1)", async () => {
    // Hold every stream open until we release it, so all requests are in-flight
    // simultaneously and the cap is actually exercised (not serialized).
    const openStreams: Array<http2.ServerHttp2Stream> = []
    let release!: () => void
    const releaseGate = new Promise<void>((r) => (release = r))
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      openStreams.push(stream)
      void releaseGate.then(() => stream.end("ok"))
    }
    let opened = 0
    setHttp2SessionFactoryForTests(() => {
      opened += 1
      return http2.connect(url)
    })
    try {
      const reqs = [http2Fetch(`${url}/a`, {}), http2Fetch(`${url}/b`, {}), http2Fetch(`${url}/c`, {})]
      // Wait until all three streams have reached the server (all in-flight).
      await waitUntil(() => openStreams.length === 3)
      // Peak: three concurrent streams, N=1 ⇒ three separate sessions, none over cap.
      const rows = getH2SessionStatusSnapshot()
      expect(rows).toHaveLength(3)
      expect(Math.max(...rows.map((r) => r.activeStreamCount))).toBeLessThanOrEqual(1)
      expect(opened).toBe(3)
      release()
      const settled = await Promise.all(reqs)
      await Promise.all(settled.map((r) => r.text()))
    } finally {
      release() // idempotent-safe: releaseGate already resolved
      setHttp2SessionFactoryForTests(undefined)
      closeHttp2Sessions()
    }
  })

  test("N=1: a single session teardown fails only its own stream — siblings survive", async () => {
    const openStreams: Array<http2.ServerHttp2Stream> = []
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      openStreams.push(stream)
      // leave open; the test decides which to destroy vs finish
    }
    try {
      const victim = http2Fetch(`${url}/victim`, {})
      const survivor = http2Fetch(`${url}/survivor`, {})
      await waitUntil(() => openStreams.length === 2)
      // Two separate sessions under N=1.
      expect(getH2SessionStatusSnapshot()).toHaveLength(2)
      // Destroy the FIRST stream's whole session (simulating an upstream
      // session-level teardown); the second is on a DIFFERENT session (N=1).
      openStreams[0]?.session?.destroy(new Error("simulated upstream teardown"))
      // The survivor finishes cleanly — the blast radius did NOT reach it.
      openStreams[1]?.end("ok")
      const res = await survivor
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("ok")
      // Best-effort drain the victim (under Bun a server session.destroy() can be
      // delivered to the client as a clean end rather than a stream error — the
      // documented Bun RST caveat — so we don't assert it throws; the isolation
      // oracle is the survivor above + the pool dropping the dead session below).
      await victim.then((r) => r.text()).catch(() => {})
      // The destroyed session is removed from the pool; the survivor's remains.
      await waitUntil(() => getH2SessionStatusSnapshot().length === 1)
    } finally {
      setHttp2SessionFactoryForTests(undefined)
      closeHttp2Sessions()
    }
  })
})

// C4: idle-session reaping — surplus sessions from a subsided burst are closed
// after `h2IdleSessionTimeout`; busy sessions are never reaped.
describe("http2-client pool (C4: idle-session reaping)", () => {
  afterEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, h2IdleSessionTimeout: 300 }))

  test("an idle session is reaped after the idle timeout", async () => {
    setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, h2IdleSessionTimeout: 0.05 }) // 50ms
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    const res = await http2Fetch(`${url}/x`, {})
    await res.text()
    // The session goes idle (activeStreamCount → 0) and is pooled.
    await waitUntil(() => getH2SessionStatusSnapshot().length === 1)
    // After the idle timeout it is proactively closed and removed from the pool.
    await waitUntil(() => getH2SessionStatusSnapshot().length === 0, { timeout: 1000, label: "idle reap" })
  })

  test("a busy session is NOT reaped while its stream is in-flight", async () => {
    setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, h2IdleSessionTimeout: 0.05 }) // 50ms
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      void gate.then(() => stream.end("ok"))
    }
    try {
      const req = http2Fetch(`${url}/x`, {})
      await waitUntil(() => getH2SessionStatusSnapshot().length === 1)
      // Wait well past the idle timeout with the stream still open.
      await new Promise((r) => setTimeout(r, 150))
      // Still pooled — a busy session must never be idle-reaped.
      expect(getH2SessionStatusSnapshot()).toHaveLength(1)
      expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)
      release()
      const res = await req
      await res.text()
    } finally {
      release()
    }
  })

  test("idle timeout 0 disables reaping — the session lingers", async () => {
    setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, h2IdleSessionTimeout: 0 }) // disabled
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    const res = await http2Fetch(`${url}/x`, {})
    await res.text()
    await waitUntil(() => getH2SessionStatusSnapshot().length === 1)
    // No reap timer armed — still pooled after a generous wait.
    await new Promise((r) => setTimeout(r, 150))
    expect(getH2SessionStatusSnapshot()).toHaveLength(1)
  })
})

// per-origin total-session HARD cap: at cap with every session busy, a new
// request BLOCKS (upstream-side) until a stream closes, then proceeds — it is
// never dropped, and never grows the pool past cap. The client-facing keepalive
// is a separate handler-layer concern (delayed-commit), not tested here.
describe("http2-client pool (per-origin session HARD cap — block until a slot frees)", () => {
  afterEach(() => setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, maxSessionsPerOrigin: 0 }))

  test("at cap with all sessions busy, a new request BLOCKS then proceeds when a slot frees", async () => {
    // N=1, cap=2 → at most 2 concurrent in-flight streams for the origin.
    setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, maxSessionsPerOrigin: 2, h2IdleSessionTimeout: 0 })
    const openStreams: Array<http2.ServerHttp2Stream> = []
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      openStreams.push(stream)
      // held open until the test ends each stream explicitly
    }
    try {
      // Two concurrent requests fill the cap (2 sessions, both busy).
      const a = http2Fetch(`${url}/a`, {})
      const b = http2Fetch(`${url}/b`, {})
      await waitUntil(() => openStreams.length === 2)
      expect(getH2SessionStatusSnapshot()).toHaveLength(2)

      // A third request must BLOCK (no server stream opens for it) — pool stays at 2.
      let cThirdResolved = false
      const c = http2Fetch(`${url}/c`, {}).then((r) => {
        cThirdResolved = true
        return r
      })
      await new Promise((r) => setTimeout(r, 100))
      expect(openStreams.length).toBe(2) // still blocked — no 3rd server stream
      expect(cThirdResolved).toBe(false)
      expect(getH2SessionStatusSnapshot().length).toBeLessThanOrEqual(2)

      // Free a slot: finish the first stream. The blocked third now proceeds.
      openStreams[0]?.end("ok")
      await waitUntil(() => openStreams.length === 3, { timeout: 2000, label: "blocked req unblocks" })
      openStreams[1]?.end("ok")
      openStreams[2]?.end("ok")
      const [ra, rb, rc] = await Promise.all([a, b, c])
      await Promise.all([ra.text(), rb.text(), rc.text()])
      expect(cThirdResolved).toBe(true)
      expect(getH2SessionStatusSnapshot().length).toBeLessThanOrEqual(2)
    } finally {
      for (const s of openStreams) {
        try {
          s.end()
        } catch {
          /* already ended */
        }
      }
    }
  })

  test("a blocked over-cap request is released by client abort (not left hanging)", async () => {
    setUpstreamTransportConfig({ maxConcurrentStreamsPerSession: 1, maxSessionsPerOrigin: 1, h2IdleSessionTimeout: 0 })
    const openStreams: Array<http2.ServerHttp2Stream> = []
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      openStreams.push(stream)
    }
    try {
      const held = http2Fetch(`${url}/held`, {})
      await waitUntil(() => openStreams.length === 1)
      // Second request blocks at the cap (1); abort it → must reject promptly.
      const ac = new AbortController()
      const blocked = http2Fetch(`${url}/blocked`, { signal: ac.signal })
      await new Promise((r) => setTimeout(r, 50))
      expect(openStreams.length).toBe(1) // still blocked
      ac.abort()
      await expect(blocked).rejects.toThrow(/abort/i)
      // The holder is unaffected.
      openStreams[0]?.end("ok")
      const r = await held
      await r.text()
    } finally {
      for (const s of openStreams) {
        try {
          s.end()
        } catch {
          /* already ended */
        }
      }
    }
  })
})
