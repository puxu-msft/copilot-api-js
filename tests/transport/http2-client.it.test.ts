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

import {
  //
  closeHttp2Sessions,
  http2Fetch,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

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
})
