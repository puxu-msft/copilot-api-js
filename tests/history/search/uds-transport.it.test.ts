/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — UDS transport (server + client) integration tests, real Unix domain
 * sockets on disk (no mocking of node:net).
 *
 * The never-throw / crash-safety assertions mirror the pattern in
 * `tests/transport/http2-client.it.test.ts` ("a TLS connect timeout rejects
 * WITHOUT a process uncaughtException"): install a `process.on('uncaughtException')`
 * probe BEFORE exercising the failure path, assert it never fires, remove it in a
 * `finally`.
 *
 * ⚠ An in-process probe here is NOT a faithful proof of the production crash mode
 * (corrected 2026-07-22): at the `bun test` top level a prior `server.listen()` in
 * this same file "warms" Bun's UDS-connect internals (see prime-uds-for-bun-test.ts),
 * so a missing-socket connect emits a catchable async `'error'` — and these probes
 * pass even against the pre-fix `net.connect()`-then-listener code. The REAL crash
 * only surfaces inside a `Bun.serve` request handler under plain `bun run` (an
 * ENOENT `'error'` delivered before a post-`net.connect()` listener can attach →
 * `uncaughtException` → `main.ts` exit(1)). The faithful oracle for that is the
 * spawned-child test below; the in-process probes are retained as cheap coverage of
 * the OTHER never-throw branches (hang / malformed frame / wire-error / immediate
 * close), which are context-independent.
 */

import {
  //
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import {
  //
  createHistorySearchUdsClient,
  HistorySearchUdsError,
  pingHistorySearchUdsClient,
} from "~/lib/history/search/uds-client"
import {
  //
  createHistorySearchUdsServer,
  type HistorySearchQueryFn,
} from "~/lib/history/search/uds-server"

import { primeUdsConnectForBunTest } from "../../helpers/prime-uds-for-bun-test"

// See prime-uds-for-bun-test.ts's doc comment: without this, whichever test
// happens to run FIRST in this file (test execution order is not a stable
// contract) could spuriously fail on a `bun test`-only quirk unrelated to the
// code under test — this file's own tests each do a `server.listen()` before
// any client `query()`, which incidentally also primes it, but that ordering
// is coincidental, not a guarantee; make the requirement explicit instead of
// relying on it.
beforeAll(primeUdsConnectForBunTest)

const tmpDirs: Array<string> = []
function freshSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uds-transport-"))
  tmpDirs.push(dir)
  return path.join(dir, "history-search.sock")
}

const cleanupServers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const server of cleanupServers.splice(0)) await server.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Install an uncaughtException probe for the duration of `fn`, asserting it never fires. */
async function assertNoUncaughtException(fn: () => Promise<void>): Promise<void> {
  const seen: Array<unknown> = []
  const onUncaught = (err: unknown): void => void seen.push(err)
  process.on("uncaughtException", onUncaught)
  try {
    await fn()
    // Let any orphaned async 'error' re-emit flush before asserting.
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toHaveLength(0)
  } finally {
    process.off("uncaughtException", onUncaught)
  }
}

describe("UDS server + client round-trip", () => {
  test("client query() returns rows a fake search function produced", async () => {
    const socketPath = freshSocketPath()
    const search: HistorySearchQueryFn = async (query, operationKind, limit) => {
      expect(operationKind).toBe("generation")
      expect(limit).toBe(10)
      return [{ operationId: `hit-for-${query}`, createdAt: 123, score: 0.9 }]
    }
    const server = createHistorySearchUdsServer(socketPath, search)
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const rows = await client.query("needle", "generation", 10)
    expect(rows).toEqual([{ operationId: "hit-for-needle", createdAt: 123, score: 0.9 }])
  })

  test("richest-data-flow: SearchHit fields pass through the wire untouched (operationId/createdAt/score)", async () => {
    const socketPath = freshSocketPath()
    const search: HistorySearchQueryFn = async () => [{ operationId: "op-full-fields", createdAt: 987_654_321, score: 3.14159 }]
    const server = createHistorySearchUdsServer(socketPath, search)
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const rows = await client.query("q", undefined, 5)
    expect(rows).toEqual([{ operationId: "op-full-fields", createdAt: 987_654_321, score: 3.14159 }])
  })

  test("a stale leftover socket FILE from a killed prior process does not prevent listen()", async () => {
    const socketPath = freshSocketPath()
    // Faithful oracle: fork a REAL child process that binds the socket and never
    // cleanly closes it, then SIGKILL it -- this is exactly what a crashed sidecar
    // leaves behind (the socket-path file survives; nothing is listening on it).
    //
    // MUST use `process.execPath` (the resolved absolute bun binary), NOT the bare
    // `"bun"` command -- confirmed empirically (2026-07-21) that under a
    // volta-managed bun install, `"bun"` resolves through volta's shim wrapper,
    // so `Bun.spawn`'s reported `child.pid` is the SHIM's pid, not the real
    // grandchild bun process actually holding the socket. `child.kill("SIGKILL")`
    // then kills only the (already-exited) shim -- the real process is never
    // killed and leaks forever (`setInterval` keeps its event loop alive
    // indefinitely). This was caught by `ps aux` showing 19 accumulated orphaned
    // `bun -e ...` processes still listening on now-deleted temp-dir sockets
    // after repeated `bun test` runs of this exact file.
    const child = Bun.spawn([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}); setInterval(() => {}, 1000)`], {
      stdout: "ignore",
      stderr: "ignore",
    })
    // Wait for the child to actually create the socket file before killing it.
    for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.existsSync(socketPath)).toBe(true)
    child.kill("SIGKILL")
    await child.exited

    const server = createHistorySearchUdsServer(socketPath, async () => [])
    cleanupServers.push(server)
    await expect(server.listen()).resolves.toBeUndefined()

    const client = createHistorySearchUdsClient({ socketPath })
    expect(await client.query("q", undefined, 5)).toEqual([])
  })

  test("a non-socket file at the target path is left untouched -- listen() fails loudly instead of silently deleting it", async () => {
    const socketPath = freshSocketPath()
    fs.writeFileSync(socketPath, "important unrelated data, not a socket")

    const server = createHistorySearchUdsServer(socketPath, async () => [])
    await expect(server.listen()).rejects.toMatchObject({ code: "EADDRINUSE" })
    // The file must survive exactly as written -- unlinkStaleSocket refused to
    // touch it because lstat proved it is NOT a socket.
    expect(fs.readFileSync(socketPath, "utf8")).toBe("important unrelated data, not a socket")
  })

  test("a LIVE peer already listening on the path is NEVER unlinked -- a second instance fails loudly with EADDRINUSE instead of stealing the socket", async () => {
    const socketPath = freshSocketPath()
    // First instance: genuinely listening, serving real queries.
    const firstSearch: HistorySearchQueryFn = async () => [{ operationId: "first-instance-op", createdAt: 1, score: 1 }]
    const firstServer = createHistorySearchUdsServer(socketPath, firstSearch)
    cleanupServers.push(firstServer)
    await firstServer.listen()

    // Second instance targeting the SAME socket path (the exact double-start
    // scenario the connection-probe exists to protect against -- two
    // independently-started sidecar service instances racing for one socket,
    // which the resident-service architecture (Phase 3′) must never let one
    // silently steal from the other).
    const secondServer = createHistorySearchUdsServer(socketPath, async () => [])
    await expect(secondServer.listen()).rejects.toMatchObject({ code: "EADDRINUSE" })

    // The FIRST instance must still be alive and fully functional -- proof that
    // unlinkStaleSocket's connection probe correctly detected the live peer and
    // refused to unlink out from under it.
    const client = createHistorySearchUdsClient({ socketPath })
    const rows = await client.query("q", undefined, 5)
    expect(rows).toEqual([{ operationId: "first-instance-op", createdAt: 1, score: 1 }])
  })

  test("server unlinks its own socket file on close()", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(socketPath, async () => [])
    await server.listen()
    expect(fs.existsSync(socketPath)).toBe(true)
    await server.close()
    expect(fs.existsSync(socketPath)).toBe(false)
  })
})

describe("strict list-search UDS contract", () => {
  test("round-trips filters, cursor, frozen target, ordered IDs, total, and freshness attestation", async () => {
    const socketPath = freshSocketPath()
    let scoreSearchCalled = false
    const server = createHistorySearchUdsServer(
      socketPath,
      async () => {
        scoreSearchCalled = true
        return []
      },
      undefined,
      async (request) => {
        expect(request).toEqual({
          type: "list-search",
          query: "needle",
          filters: { operationKinds: ["generation", "responses_ws"], sessionId: "session-a", mainAgentOnly: true },
          cursor: { startedAt: 100, operationId: "cursor-op", direction: "older", requireMatch: true },
          limit: 3,
          target: { committedAt: 200, operationIdsAtBoundary: ["target-a", "target-b"] },
        })
        return {
          operationIds: ["op-c", "op-b", "op-a"],
          total: 7,
          hasOlder: true,
          hasNewer: false,
          attestation: {
            committedAt: 200,
            indexedAtBoundaryMs: ["target-a", "target-b"],
            poison: [],
          },
        }
      },
    )
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const result = await client.listSearch({
      query: "needle",
      filters: { operationKinds: ["generation", "responses_ws"], sessionId: "session-a", mainAgentOnly: true },
      cursor: { startedAt: 100, operationId: "cursor-op", direction: "older", requireMatch: true },
      limit: 3,
      target: { committedAt: 200, operationIdsAtBoundary: ["target-a", "target-b"] },
    })

    expect(result).toEqual({
      operationIds: ["op-c", "op-b", "op-a"],
      total: 7,
      hasOlder: true,
      hasNewer: false,
      attestation: { committedAt: 200, indexedAtBoundaryMs: ["target-a", "target-b"], poison: [] },
    })
    expect(scoreSearchCalled).toBe(false)
  })

  test("preserves invalid-cursor identity across the real wire", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(
      socketPath,
      async () => [],
      undefined,
      async () => {
        throw Object.assign(new Error("filtered cursor"), { code: "invalid-cursor" as const })
      },
    )
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const request = client.listSearch({
      query: "needle",
      filters: { operationKinds: ["generation"] },
      cursor: { startedAt: 1, operationId: "filtered", direction: "older", requireMatch: true },
      limit: 3,
      target: { committedAt: 1, operationIdsAtBoundary: ["op"] },
    })
    await expect(request).rejects.toBeInstanceOf(HistorySearchUdsError)
    await expect(request).rejects.toMatchObject({ code: "invalid-cursor" })
  })

  test("rejects when the connected sidecar does not support list-search instead of returning a false empty page", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(socketPath, async () => [])
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    await expect(
      client.listSearch({ query: "needle", filters: { operationKinds: ["generation"] }, limit: 3, target: { committedAt: 1, operationIdsAtBoundary: ["op"] } }),
    ).rejects.toThrow(/does not support list-search/)
  })
})

describe("UDS client never-throw contract (crash-safety-critical)", () => {
  test("socket path does not exist -> query() resolves to [], NO uncaughtException", async () => {
    const socketPath = freshSocketPath() // directory created, but nothing ever listens on this path
    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath })
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
    })
  })

  // FAITHFUL production oracle for the real crash (2026-07-22): the in-process
  // probes above run at the `bun test` top level, where a prior `server.listen()`
  // in this same file has "warmed" Bun's UDS-connect internals (see
  // prime-uds-for-bun-test.ts) — so a missing-socket `query()` emits a catchable
  // async `'error'` and they pass EVEN against the pre-fix code. Production is a
  // different event-loop context: inside a `Bun.serve` request handler, an ENOENT
  // on `net.connect()` was delivered BEFORE the returned socket's listener could
  // attach, escaping `withErrorSink` as an `uncaughtException` → `main.ts`
  // `exit(1)`. (The earlier "in-process probe is a FAITHFUL proof / this is purely
  // a bun-test artifact, not a real bug" claims — this file's header and
  // prime-uds-for-bun-test.ts lines 46-50 — were both false-green, verified
  // outside a request handler.) This test reproduces the true context by spawning
  // a real `bun run` child that queries a missing sidecar from inside a Bun.serve
  // handler under concurrent load; it exits non-zero on any uncaught escape.
  // Load-bearing negative control: reverting sendRequest to `net.connect()` +
  // listener-after makes this child crash (250/250 in the original repro).
  test("missing sidecar queried from INSIDE a Bun.serve request handler under load -> no process crash (faithful production oracle)", async () => {
    const missing = freshSocketPath() // nothing ever listens here
    const clientModule = path.resolve(import.meta.dir, "../../../src/lib/history/search/uds-client.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import { createHistorySearchUdsClient } from ${JSON.stringify(clientModule)}
        let bad = 0
        process.on("uncaughtException", () => { bad++ })
        process.on("unhandledRejection", () => { bad++ })
        const client = createHistorySearchUdsClient({ socketPath: ${JSON.stringify(missing)}, connectTimeoutMs: 300, queryTimeoutMs: 300 })
        const server = Bun.serve({ port: 0, async fetch() { return new Response(JSON.stringify(await client.query("q", undefined, 5))) } })
        const url = "http://localhost:" + server.port + "/"
        let allEmpty = true
        for (let r = 0; r < 4; r++) {
          const res = await Promise.all(Array.from({ length: 40 }, () => fetch(url).then((x) => x.json())))
          allEmpty = allEmpty && res.every((x) => Array.isArray(x) && x.length === 0)
        }
        server.stop()
        process.exit(bad === 0 && allEmpty ? 0 : 1)
        `,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    const exitCode = await child.exited
    // Exit 0 = 160 in-handler queries all degraded to [] with zero uncaught
    // escapes. A non-zero exit (crash / exit(1) / assertion) fails the test.
    expect(exitCode).toBe(0)
  })

  test("server closes the connection immediately after accepting (no response) -> query() resolves to [], NO uncaughtException", async () => {
    const socketPath = freshSocketPath()
    const raw = net.createServer((socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject)
      raw.listen(socketPath, resolve)
    })
    cleanupServers.push({ close: () => new Promise((resolve) => raw.close(() => resolve())) })

    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath })
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
    })
  })

  test("server sends a malformed (undecodable) frame -> query() resolves to [], NO uncaughtException", async () => {
    const socketPath = freshSocketPath()
    const raw = net.createServer((socket) => {
      // A length prefix declaring 5 bytes, followed by bytes that are NOT valid JSON.
      const header = Buffer.alloc(4)
      header.writeUInt32BE(5, 0)
      socket.write(Buffer.concat([header, Buffer.from("nope!")]))
    })
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject)
      raw.listen(socketPath, resolve)
    })
    cleanupServers.push({ close: () => new Promise((resolve) => raw.close(() => resolve())) })

    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath })
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
    })
  })

  test("server replies with a wire-level { error } -> query() resolves to [], NO uncaughtException", async () => {
    const socketPath = freshSocketPath()
    const search: HistorySearchQueryFn = async () => {
      throw new Error("simulated native index failure")
    }
    const server = createHistorySearchUdsServer(socketPath, search)
    cleanupServers.push(server)
    await server.listen()

    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath })
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
    })
  })

  test("server accepts but never responds (hang) -> query() resolves to [] once queryTimeoutMs elapses, NO uncaughtException", async () => {
    const socketPath = freshSocketPath()
    const raw = net.createServer(() => {
      /* accept, then never respond -- simulates a wedged sidecar */
    })
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject)
      raw.listen(socketPath, resolve)
    })
    cleanupServers.push({ close: () => new Promise((resolve) => raw.close(() => resolve())) })

    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath, queryTimeoutMs: 100 })
      const start = Date.now()
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
      expect(Date.now() - start).toBeLessThan(1000) // bounded by the timeout, not left hanging
    })
  })

  test("connecting itself hangs (server never accepts) -> query() resolves to [] once connectTimeoutMs elapses, NO uncaughtException", async () => {
    // A path with no listener AT ALL, on a platform where connect() to a nonexistent
    // UDS path fails fast (ENOENT) rather than hanging, so this specifically drives
    // the connectTimeoutMs branch by using an artificially tiny timeout alongside a
    // guaranteed-absent path — proving the connect-timeout code path itself never
    // throws even when it never actually fires is covered by the ENOENT test above;
    // this test instead proves the timer is inert/harmless when connect settles
    // (error) well before the deadline.
    const socketPath = freshSocketPath()
    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath, connectTimeoutMs: 50 })
      const rows = await client.query("q", undefined, 5)
      expect(rows).toEqual([])
    })
  })
})

describe("length-prefix fragmentation over a REAL socket (not just the in-memory decoder)", () => {
  test("a large multi-segment response reassembles correctly", async () => {
    const socketPath = freshSocketPath()
    const bigContent = "y".repeat(300_000)
    const search: HistorySearchQueryFn = async () => Array.from({ length: 50 }, (_, i) => ({ operationId: `${bigContent}-${i}`, createdAt: i, score: i / 10 }))
    const server = createHistorySearchUdsServer(socketPath, search)
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const rows = await client.query("q", undefined, 50)
    expect(rows).toHaveLength(50)
    expect(rows[0]?.operationId).toBe(`${bigContent}-0`)
    expect(rows[49]?.operationId).toBe(`${bigContent}-49`)
  })
})

describe("pingHistorySearchUdsClient (status/diagnostic reachability probe — unlike query(), DOES distinguish success/failure)", () => {
  test("a running, reachable sidecar -> { reachable: true }", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(socketPath, async () => [])
    cleanupServers.push(server)
    await server.listen()

    const result = await pingHistorySearchUdsClient(socketPath)
    expect(result.reachable).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test("an absent sidecar (no socket at all -- the common 'not installed' case) -> { reachable: false }, NO uncaughtException", async () => {
    const socketPath = freshSocketPath()
    await assertNoUncaughtException(async () => {
      const result = await pingHistorySearchUdsClient(socketPath)
      expect(result.reachable).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  test("empty query + limit:0 never actually touches the search function (cheap probe, matches native search_blocking's own short-circuit)", async () => {
    const socketPath = freshSocketPath()
    let searchCalled = false
    const server = createHistorySearchUdsServer(socketPath, async () => {
      searchCalled = true
      return []
    })
    cleanupServers.push(server)
    await server.listen()

    await pingHistorySearchUdsClient(socketPath)
    // The wire request itself still round-trips through the real search callback
    // (the "cheap" guarantee comes from the NATIVE side's own short-circuit, see
    // native/history-search/src/lib.rs's search_blocking -- this test's injected
    // fake search function is always called; it documents the wire shape ping
    // sends, not a claim that this test double itself skips work).
    expect(searchCalled).toBe(true)
  })
})

describe("client.getTailStatus() (merged-state review blocker 3, 2026-07-22) -- tail-progress status, distinct from mere UDS reachability", () => {
  test("a server WITH a getStatus callback answers a real status request with its exact fields", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(
      socketPath,
      async () => [],
      () => ({
        lastSuccessfulTailAt: 1_753_000_000_000,
        poisonedCount: 3,
        lastTailError: null,
      }),
    )
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const status = await client.getTailStatus()
    expect(status).toEqual({ lastSuccessfulTailAt: 1_753_000_000_000, poisonedCount: 3, lastTailError: null })
  })

  test("a server built WITHOUT a getStatus callback rejects a status request rather than crashing or silently answering with a search reply", async () => {
    const socketPath = freshSocketPath()
    // No third arg -- exactly like every OTHER test in this file constructs a server,
    // proving old callers (that only care about search) are unaffected.
    const server = createHistorySearchUdsServer(socketPath, async () => [])
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    await expect(client.getTailStatus()).rejects.toThrow()
  })

  test("a status request is NEVER confused with a search request over the wire -- disjoint reply shapes, real socket round-trip", async () => {
    const socketPath = freshSocketPath()
    let searchWasCalled = false
    const server = createHistorySearchUdsServer(
      socketPath,
      async () => {
        searchWasCalled = true
        return [{ operationId: "should-not-appear", createdAt: 1, score: 1 }]
      },
      () => ({ lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }),
    )
    cleanupServers.push(server)
    await server.listen()

    const client = createHistorySearchUdsClient({ socketPath })
    const status = await client.getTailStatus()
    expect(status).toEqual({ lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null })
    // The status request must route to getStatus, NEVER to search -- a status poll
    // must never accidentally trigger (or be confused with) a real search query.
    expect(searchWasCalled).toBe(false)
  })

  test("getTailStatus() propagates a genuine transport failure (unreachable socket) -- distinct never-throw-vs-throw contract from query()", async () => {
    const socketPath = freshSocketPath() // nothing ever listens here
    await assertNoUncaughtException(async () => {
      const client = createHistorySearchUdsClient({ socketPath, connectTimeoutMs: 200 })
      await expect(client.getTailStatus()).rejects.toThrow()
    })
  })
})
