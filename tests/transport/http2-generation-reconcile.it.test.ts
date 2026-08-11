/**
 * h2 generation-based retire-and-replace — the independent oracle for global
 * constraint #2 (P4 owns reconciling ALREADY-established sessions on config
 * hot-reload; P1-P3 must not pre-empt this) and #4 (a retiring session's
 * keepalive PING timer survives until its in-flight streams drain). Uses a
 * real local h2c server (same harness as http2-client.it.test.ts) — never
 * asserts only on internal state, always on observable behaviour: which real
 * TCP session a NEW request lands on, and whether an IN-FLIGHT stream on the
 * old session keeps receiving bytes.
 */

import type { AddressInfo } from "node:net"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import http2 from "node:http2"

import { setUpstreamTransportConfig } from "~/lib/state"
import {
  //
  closeHttp2Sessions,
  getH2ReconcileStatus,
  getH2SessionStatusSnapshot,
  http2Fetch,
  reconcileH2SessionsForConfigChange,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"

import { autoRestoreState } from "../helpers/state-fixture"

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
  // Fresh h2c connect per call — mirrors production's proxy-agnostic
  // createSession, but cleartext for the test harness.
  setHttp2SessionFactoryForTests(() => http2.connect(url))
})

afterEach(async () => {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a CONDITION, never for a duration. Several cases here need "the request has reached the
 * server" or "the session entry has been published" before they can assert, and none of those has an
 * `await` that covers it — the response is deliberately held open. A fixed `sleep()` in that role is
 * a wall-clock bet that contention loses; one such bet was the root cause of the
 * "test setup: server stream/session missing" flake seen under the 16-shard runner.
 *
 * `label` is what makes a timeout diagnosable: without it a stalled predicate looks identical to the
 * assertion that follows it failing for real.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`test setup: timed out waiting for ${label}`)
    await sleep(5)
  }
}

describe("h2 generation-based retire-and-replace", () => {
  autoRestoreState()

  test("reconcile moves the active session to retiring; the NEXT request opens a fresh session", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }

    // First request establishes generation-0 session for this origin.
    await http2Fetch(`${url}/a`, {})
    const before = getH2SessionStatusSnapshot()
    expect(before).toHaveLength(1)
    expect(before[0].lifecycle).toBe("active")
    const generationBefore = before[0].generation

    reconcileH2SessionsForConfigChange()

    // Old session is now retiring (no in-flight stream, so it gets reclaimed
    // synchronously by maybeReclaimRetiringSession — it disappears from the
    // snapshot once its own `close` handler runs, which the h2 stack fires
    // asynchronously; poll briefly for that to settle before asserting).
    for (let i = 0; i < 20 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)

    // The NEXT request must open a brand-new session at the new generation —
    // not reuse the retired one (would be a silent config-hot-reload no-op).
    await http2Fetch(`${url}/b`, {})
    const after = getH2SessionStatusSnapshot()
    expect(after).toHaveLength(1)
    expect(after[0].generation).toBe(generationBefore + 1)
    expect(after[0].lifecycle).toBe("active")
  })

  test("reconcile does NOT disturb an in-flight stream on the old session", async () => {
    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Hold the stream open until the test explicitly releases it, so the
      // request is still in-flight when reconcile runs.
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const responsePromise = http2Fetch(`${url}/slow`, {})
    // (b) same-form bet as row 1, converted: nothing here awaits the response (the handler holds the
    // stream open on purpose), so the snapshot entry has no readiness signal other than this wait.
    await waitUntil(() => getH2SessionStatusSnapshot().length === 1, "the /slow request to reach the server and publish its session entry")

    reconcileH2SessionsForConfigChange()
    const duringDrain = getH2SessionStatusSnapshot()
    expect(duringDrain).toHaveLength(1)
    expect(duringDrain[0].lifecycle).toBe("retiring")
    expect(duringDrain[0].activeStreamCount).toBe(1)

    releaseServerStream?.()
    const res = await responsePromise
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe("first-chunklast-chunk")

    // Once the stream drained, the retiring entry is reclaimed (closed).
    for (let i = 0; i < 20 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)
  })

  test("getH2ReconcileStatus reflects idle -> running -> idle with a bumped lastCompletedGeneration", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    await http2Fetch(`${url}/a`, {})
    const before = getH2ReconcileStatus()
    reconcileH2SessionsForConfigChange()
    const after = getH2ReconcileStatus()
    expect(after.state).toBe("idle")
    expect(after.lastCompletedGeneration).toBe(before.lastCompletedGeneration + 1)
    expect(after.lastError).toBeNull()
  })

  test("a connect racing a reconcile is discarded and retried — the caller never gets a session stamped with a stale generation (HIGH-3)", async () => {
    // Make the h2c handshake itself slow enough to reliably straddle a
    // reconcile call, so this is a real race on the wall clock, not a
    // hand-waved "assume it can happen" comment.
    let connectCount = 0
    setHttp2SessionFactoryForTests(async () => {
      connectCount += 1
      await sleep(30)
      return http2.connect(url)
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }

    const fetchPromise = http2Fetch(`${url}/racing`, {})
    // (b) converted: the condition is literally "the slow connect has started", which `connectCount`
    // exposes directly — no reason to guess at how long that takes.
    await waitUntil(() => connectCount === 1, "the slow connect to start")
    reconcileH2SessionsForConfigChange()
    const generationAfterReconcile = getH2ReconcileStatus().lastCompletedGeneration

    const res = await fetchPromise
    expect(res.ok).toBe(true)

    // The in-flight connect that started under the OLD generation must have
    // been discarded and retried — proven by it actually reconnecting (a
    // second real TCP handshake), not merely by an internal counter.
    expect(connectCount).toBeGreaterThanOrEqual(2)
    const rows = getH2SessionStatusSnapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0].lifecycle).toBe("active")
    expect(rows[0].generation).toBe(generationAfterReconcile)
  })

  test("reconcile reschedules a RETIRING session's PING timer to the freshly configured interval — positive -> 0 stops further pings without closing the session or disturbing the in-flight stream (spec §7 HIGH addition, A3)", async () => {
    setUpstreamTransportConfig({ upstreamH2PingInterval: 0.015 }) // 15ms — state stores SECONDS (getUpstreamH2PingIntervalMs() does sec*1000)
    const pingSpy = mock((cb: () => void) => cb())
    setHttp2SessionFactoryForTests(() => {
      const s = http2.connect(url)
      // Real session, spied `.ping` — scheduleH2KeepalivePing calls session.ping()
      // on its interval, so this observes REAL scheduled invocations, not an
      // internal flag. Mirrors h2-keepalive-ping.unit.test.ts's fake-session
      // pattern, but on a real connected session (this test needs the session
      // to also carry a real in-flight stream).
      s.ping = pingSpy as unknown as typeof s.ping
      return s
    })

    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const responsePromise = http2Fetch(`${url}/reschedule-to-zero`, {})
    // (b) converted: both waits had observable conditions. The first is the published session entry;
    // the second is "enough old-cadence ticks have happened to make the assertion below meaningful",
    // which pingSpy counts directly — sleeping 40ms was a guess at the same thing.
    await waitUntil(() => getH2SessionStatusSnapshot().length === 1, "the request to reach the server and publish its session entry")
    await waitUntil(() => pingSpy.mock.calls.length >= 2, "at least two pings at the old 15ms cadence")
    const callsBeforeReconcile = pingSpy.mock.calls.length
    expect(callsBeforeReconcile).toBeGreaterThanOrEqual(2)

    // Config change: ping interval 15 -> 0 (disable). The production wiring
    // would fire this via the onUpstreamTransportChange subscription; call
    // reconcile directly (as the other tests in this file do) so the
    // assertion is decoupled from that subscription wiring.
    setUpstreamTransportConfig({ upstreamH2PingInterval: 0 })
    reconcileH2SessionsForConfigChange()

    const retiring = getH2SessionStatusSnapshot()
    expect(retiring).toHaveLength(1)
    expect(retiring[0].lifecycle).toBe("retiring")
    expect(retiring[0].effectivePingIntervalMs).toBe(0)
    // The reschedule must NOT close the session or disturb its in-flight
    // stream's accounting — only the ping cadence changes.
    expect(retiring[0].activeStreamCount).toBe(1)

    const callsAtReconcile = pingSpy.mock.calls.length
    await sleep(45) // long enough for several old-cadence ticks if NOT actually cancelled
    expect(pingSpy.mock.calls.length).toBe(callsAtReconcile) // no further pings

    // The in-flight stream must still complete intact through the retiring
    // session — proves reschedule-to-zero didn't close() the session.
    releaseServerStream?.()
    const res = await responsePromise
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe("first-chunklast-chunk")
  })

  test("reconcile reschedules a RETIRING session's PING timer to a NEW positive interval — old cadence stops, new cadence starts, in-flight stream still drains intact (spec §7 HIGH addition, A3)", async () => {
    setUpstreamTransportConfig({ upstreamH2PingInterval: 0.5 })
    const pingSpy = mock((cb: () => void) => cb())
    setHttp2SessionFactoryForTests(() => {
      const s = http2.connect(url)
      s.ping = pingSpy as unknown as typeof s.ping
      return s
    })

    let releaseServerStream: (() => void) | undefined
    const serverStreamReleased = new Promise<void>((resolve) => {
      releaseServerStream = resolve
    })
    const streamOpened = Promise.withResolvers<undefined>()
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      streamOpened.resolve()
      void serverStreamReleased.then(() => stream.end("last-chunk"))
    }

    const setIntervalSpy = spyOn(globalThis, "setInterval")
    const clearIntervalSpy = spyOn(globalThis, "clearInterval")
    let retiring: ReturnType<typeof getH2SessionStatusSnapshot> = []
    let oldCadence: ReturnType<typeof setInterval> | undefined
    let cleared: Array<Parameters<typeof clearInterval>[0]> = []
    let scheduled: Array<Parameters<typeof setInterval>> = []
    try {
      const responsePromise = http2Fetch(`${url}/reschedule-to-new-positive`, {})
      await streamOpened.promise
      oldCadence = setIntervalSpy.mock.results[0]?.value as ReturnType<typeof setInterval> | undefined
      setIntervalSpy.mockClear()
      clearIntervalSpy.mockClear()

      // The production onUpstreamTransportChange subscription performs the
      // reconcile synchronously; do not invoke it a second time in the test.
      setUpstreamTransportConfig({ upstreamH2PingInterval: 0.015 })
      retiring = getH2SessionStatusSnapshot()
      cleared = clearIntervalSpy.mock.calls.map(([timer]) => timer)
      scheduled = [...setIntervalSpy.mock.calls]

      expect(oldCadence).toBeDefined()
      expect(cleared).toEqual([oldCadence])
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0][1]).toBe(15)

      const callsBeforeManualTicks = pingSpy.mock.calls.length
      const newCadence = scheduled[0][0] as () => void
      newCadence()
      newCadence()
      expect(pingSpy.mock.calls.length).toBeGreaterThanOrEqual(callsBeforeManualTicks + 2)

      releaseServerStream?.()
      const res = await responsePromise
      expect(res.ok).toBe(true)
      expect(await res.text()).toBe("first-chunklast-chunk")
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }

    expect(retiring).toHaveLength(1)
    expect(retiring[0].lifecycle).toBe("retiring")
    expect(retiring[0].effectivePingIntervalMs).toBe(15)
    expect(retiring[0].activeStreamCount).toBe(1)
  })

  test("reconcile reschedules each RETIRING session's ping timer exactly ONCE per call, even for a session newly retired in this same call (nit-1 fix: no double clearInterval/setInterval churn)", async () => {
    // Real setInterval/clearInterval spies observe how many times the module
    // actually re-arms the keepalive timer — a session that is newly retired
    // by THIS reconcile call must be visited by exactly one of the two
    // internal loops (the "newly retiring" loop or the "already retiring"
    // loop), never both. Before the fix, the second loop iterated the LIVE
    // `retiringSessions` set (which the first loop had already mutated), so a
    // freshly-retired entry got rescheduled twice in one call.
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.end("ok")
    }
    await http2Fetch(`${url}/reschedule-once`, {})
    expect(getH2SessionStatusSnapshot()).toHaveLength(1) // one active entry, one prior setInterval from creation

    const setIntervalSpy = spyOn(globalThis, "setInterval")
    const clearIntervalSpy = spyOn(globalThis, "clearInterval")
    setIntervalSpy.mockClear()
    clearIntervalSpy.mockClear()

    reconcileH2SessionsForConfigChange()

    // Exactly one entry existed and was newly retired by this call — its ping
    // timer must be rescheduled exactly once (one clear of the old timer, one
    // set of the new one), not twice.
    expect(clearIntervalSpy.mock.calls.length).toBe(1)
    expect(setIntervalSpy.mock.calls.length).toBe(1)

    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })
})

// A4（spec 全局约束 #3 + #4 组合）——activeStreamCount 的 exactly-once 递减必须在
// 全部四类真实终止路径下都成立，不能只靠"正常 end()"这一条路径侧面推断。矩阵：
//
// | # | 场景 | 触发方 | 触发点 | http2Fetch 的 Promise |
// |---|------|--------|--------|------------------------|
// | 1 | pre-header `req.error` | 服务端 | 响应头之前，销毁底层会话 | reject |
// | 2 | post-header `body.cancel()` | 客户端 | 收到响应头之后，主动取消 body reader | resolve，之后读体报错/中止 |
// | 3 | RST without `end` | 服务端 | 收到响应头之后，`stream.close(code)` 但从不调 `.end()` | resolve，之后读体报错 |
// | 4 | session close/reset | 服务端 | 收到响应头之后，销毁整个 h2 会话（不只是这一条流） | resolve，之后读体报错 |
//
// 四行的触发时机/触发方结构性不同（行 1 在响应头之前、无法先 `await` 到 Response；
// 行 2-4 都在响应头之后，但行 2 是客户端主动取消、行 3-4 是服务端单方终止），
// 不适合硬套同一个 `test.each` 参数化模板——所以写成四个独立 `test()`，但共享同一
// 个可观测的后置断言：这个会话在 reconcile 后已经是 `retiring`（唯一一条流），无论
// 走哪条终止路径，这条 retiring 的 entry 最终必须从 `getH2SessionStatusSnapshot()`
// 里彻底消失（`activeStreamCount` 精确归零 → `maybeReclaimRetiringSession` 才会真的
// `close()` 它）——如果 Step 4 的 `req.once("close")` 记账在某条路径下没有触发（例如
// Bun 对某种终止的 h2 事件行为与 Node 不同，这正是本文件其它地方已经记录过的已知
// Bun 差异——见 `tests/transport/http2-client.it.test.ts` 里 rstCode=0 的注释），这个
// entry 会永远卡在 `retiringSessions` 里、快照永远非空——测试会在轮询超时后失败，
// 而不是被内部计数器"看起来对了"糊弄过去。
describe("activeStreamCount exactly-once across every real stream-termination path (spec constraint #3 x #4, A4)", () => {
  autoRestoreState()

  const waitForReclaim = async (): Promise<void> => {
    for (let i = 0; i < 40 && getH2SessionStatusSnapshot().length > 0; i++) await sleep(5)
    expect(getH2SessionStatusSnapshot()).toHaveLength(0)
  }

  test("row 1 — pre-header req.error (server destroys the underlying session before any response headers)", async () => {
    let serverStream: http2.ServerHttp2Stream | undefined
    handler = (stream) => {
      serverStream = stream
      // Never respond — this row's client is still waiting for headers when
      // the underlying transport is forced to error out from under it.
    }

    const fetchPromise = http2Fetch(`${url}/matrix-pre-header-error`, {})
    // Wait for the CONDITION, not for a duration. This row is the only one of the four that never
    // awaits a response — the handler deliberately never responds — so it has no natural readiness
    // signal and used to substitute `await sleep(30)`. That is a load-dependent assumption: under
    // the 16-shard runner it has been observed to expire before the server handler ran, surfacing as
    // the "test setup" throw below. (Reproduced deterministically by shortening that sleep to 0.)
    // Both conditions are needed: the server must hold the stream, AND the client-side entry must
    // have appeared in the snapshot, which is published on its own cadence.
    await waitUntil(
      () => Boolean(serverStream?.session) && getH2SessionStatusSnapshot().length === 1,
      "the server to hold the stream and the client entry to appear in the snapshot",
    )

    const before = getH2SessionStatusSnapshot()
    expect(before).toHaveLength(1)
    expect(before[0].activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // Force a genuine pre-header client-side `req` error (not a fabricated
    // event) by destroying the SERVER session's socket — the client's
    // `req.once("error", ...)` at http2-client.ts:484 is what turns this into
    // a rejection, since no `response` was ever received.
    if (!serverStream?.session) throw new Error("test setup: server stream/session missing")
    serverStream.session.destroy(new Error("simulated pre-header transport failure"))

    await expect(fetchPromise).rejects.toThrow()
    await waitForReclaim()
  })

  test("row 2 — post-header body.cancel() (client cancels the response body reader after headers arrive)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Never end() — this row's stream terminates via the CLIENT cancelling
      // the body reader, not via any server-side action.
    }

    const res = await http2Fetch(`${url}/matrix-post-header-cancel`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // The ReadableStream adapter's cancel() calls req.close(NGHTTP2_CANCEL) —
    // http2-client.ts:473-475.
    await res.body!.cancel()
    await waitForReclaim()
  })

  test("row 3 — server RST_STREAM without end() (upstream resets the stream but never finishes it)", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 20)
    }

    const res = await http2Fetch(`${url}/matrix-server-rst`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    // The body adapter's own close-before-end backstop (http2-client.ts:463-471)
    // turns this into a read error for the CONSUMER — this row only cares
    // whether the SEPARATE Step-4 bookkeeping listener also decremented.
    await res.text().catch(() => {
      /* expected: a reset-without-end body surfaces as a read error, not this row's concern */
    })
    await waitForReclaim()
  })

  test("row 4 — whole session destroyed mid-stream (upstream connection drop, not just this stream)", async () => {
    let serverSession: http2.Http2Session | undefined
    handler = (stream) => {
      serverSession = stream.session
      stream.respond({ ":status": 200 })
      stream.write("first-chunk")
      // Never end() — the whole session dies out from under this stream instead.
    }

    const res = await http2Fetch(`${url}/matrix-session-destroy`, {})
    expect(getH2SessionStatusSnapshot()[0]?.activeStreamCount).toBe(1)

    reconcileH2SessionsForConfigChange()
    expect(getH2SessionStatusSnapshot()[0]?.lifecycle).toBe("retiring")

    serverSession?.destroy(new Error("simulated upstream session drop"))

    await res.text().catch(() => {
      /* expected: whole-session teardown surfaces as a read error on the open body */
    })
    await waitForReclaim()
  })
})
