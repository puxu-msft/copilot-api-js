/**
 * Shutdown must not kill the requests it promises to drain.
 *
 * Regression lock for the 2026-07-28 incident (History `req_1785234916721_3573`): Step 1 of
 * `gracefulShutdown` used to call `closeHttp2Sessions()`, which bumps `poolEpoch` and makes every
 * IN-FLIGHT h2 session creation throw — so a request that was still completing its TLS/h2 handshake
 * died 539ms in, while Steps 2/3 were still promising it 60s+120s to finish naturally. With
 * `maxConcurrentStreamsPerSession = 1` (the default) that window covers every request that arrives
 * while another is in flight, so this is the common case, not an edge.
 *
 * The pool is torn down in Step 4 / finalize instead, mirroring the upstream-WS `stopNew()` /
 * `closeAll()` split.
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
  _resetShutdownState,
  getShutdownPhase,
  gracefulShutdown,
} from "~/lib/shutdown"
import {
  //
  closeHttp2Sessions,
  getH2SessionStatusSnapshot,
  http2Fetch,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import { waitUntil } from "../helpers/wait-until"

let server: http2.Http2Server
let url: string
const serverSessions = new Set<http2.ServerHttp2Session>()

beforeEach(async () => {
  server = http2.createServer()
  server.on("session", (s) => serverSessions.add(s))
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 })
    stream.end("ok")
  })
  server.on("sessionError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setHttp2SessionFactoryForTests(() => http2.connect(url))
})

afterEach(async () => {
  _resetShutdownState()
  setHttp2SessionFactoryForTests(undefined)
  closeHttp2Sessions()
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

describe("graceful shutdown vs the h2 session pool", () => {
  test("Step 1 leaves an in-flight session creation alone; it completes during the drain, and the pool is closed by finalize", async () => {
    // A factory gated mid-creation: this is EXACTLY the window the incident died in
    // (session connecting, not yet admitted to the pool).
    let factoryCalls = 0
    let releaseFactory!: () => void
    const gateOpened = new Promise<void>((resolve) => {
      releaseFactory = resolve
    })
    setHttp2SessionFactoryForTests(async () => {
      factoryCalls += 1
      await gateOpened
      return http2.connect(url)
    })

    const inFlight = http2Fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })
    let settled: "pending" | "resolved" | "rejected" = "pending"
    const observed = inFlight.then(
      (r) => {
        settled = "resolved"
        return r
      },
      (e: unknown) => {
        settled = "rejected"
        return e
      },
    )
    // Oracle 1: the request really is stuck in the creation window (not already pooled) —
    // without this the test could pass for the wrong reason.
    await waitUntil(() => factoryCalls === 1, { label: "session creation to start" })

    const tracker = createMockTracker([{ status: "streaming" }])
    const shutdownPromise = gracefulShutdown("SIGTERM", {
      tracker,
      server: createMockServer(),
      closeTokenRuntimeFn: async () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      drainPollIntervalMs: 10,
      drainProgressIntervalMs: 50_000,
    })

    // Oracle 2: Step 1 is done and we are draining.
    await waitUntil(() => getShutdownPhase() === "draining", { label: "shutdown to reach the drain phase" })
    // Oracle 3: Step 1 did NOT kill it. (Before the fix this was already rejected — a
    // `pool-closed`/AbortError from the epoch guard.) Snapshotted into a local so the
    // assertion does not narrow `settled` for the later checks.
    const settledAtStep1: string = settled
    expect(settledAtStep1).toBe("pending")

    // Oracle 4: released, it connects and completes normally — a real drain, not a survivor stub.
    releaseFactory()
    const result = await observed
    const settledAtEnd: string = settled
    expect(settledAtEnd).toBe("resolved")
    expect((result as Response).status).toBe(200)
    expect(await (result as Response).text()).toBe("ok")

    // Drain sees the request finish → shutdown proceeds to finalize.
    tracker._clearRequests()
    await shutdownPromise
    // Oracle 5: the pool IS reclaimed, just later (finalize), so nothing leaks.
    expect(getH2SessionStatusSnapshot()).toEqual([])
  })
})
