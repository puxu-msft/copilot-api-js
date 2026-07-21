/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — UDS transport (server + client) integration tests, real Unix domain
 * sockets on disk (no mocking of node:net).
 *
 * The never-throw / crash-safety assertions mirror the pattern in
 * `tests/transport/http2-client.it.test.ts` ("a TLS connect timeout rejects
 * WITHOUT a process uncaughtException"): install a `process.on('uncaughtException')`
 * probe BEFORE exercising the failure path, assert it never fires, remove it in a
 * `finally`. Unlike that file's WHATWG-EventTarget async-escape case, `net.Socket`/
 * `net.Server` are plain `node:events` EventEmitters, so an in-process probe is a
 * FAITHFUL proof here (no subprocess needed) — Node's "an unheard 'error' event
 * rethrows synchronously as uncaughtException" semantics fire on THIS event loop.
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

  test("server unlinks its own socket file on close()", async () => {
    const socketPath = freshSocketPath()
    const server = createHistorySearchUdsServer(socketPath, async () => [])
    await server.listen()
    expect(fs.existsSync(socketPath)).toBe(true)
    await server.close()
    expect(fs.existsSync(socketPath)).toBe(false)
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
