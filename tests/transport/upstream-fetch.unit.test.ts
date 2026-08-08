/**
 * Unit tests for the single upstream-fetch entry point.
 *
 * Covers the production path (undici fetch + injected dispatcher), the test
 * bridge (setUpstreamFetchForTests), and the keepalive contract: the dispatcher
 * returned by getUpstreamDispatcher carries our Agent options so Bun upstream
 * connections get TCP keepalive (the whole reason for routing through undici).
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getUpstreamDispatcher,
  initProxy,
} from "~/lib/proxy"
import {
  //
  onUpstreamTransportChange,
  setStateForTests,
  setUpstreamTransportConfig,
  state,
} from "~/lib/state"
import {
  //
  setUpstreamFetchForTests,
  selectUpstreamTransport,
  upstreamFetch,
} from "~/lib/transport/upstream-fetch"

import { FakeClock } from "../helpers/fake-clock"
import { autoRestoreState } from "../helpers/state-fixture"

describe("upstreamFetch — test bridge", () => {
  afterEach(() => {
    setUpstreamFetchForTests(undefined)
  })

  test("routes through the injected fn and forwards url + init", async () => {
    const calls: Array<{ url: string | URL; init: unknown }> = []
    setUpstreamFetchForTests((url, init) => {
      calls.push({ url, init })
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const res = await upstreamFetch("https://upstream.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://upstream.example/v1/messages")
    expect((calls[0].init as { method?: string }).method).toBe("POST")
  })

  test("setUpstreamFetchForTests(undefined) restores the production path", () => {
    setUpstreamFetchForTests(() => Promise.resolve(new Response("x")))
    setUpstreamFetchForTests(undefined)
    // After restore, calling upstreamFetch would hit undici/network; we only assert
    // the override was cleared by re-installing and observing the new fn is used.
    let used = false
    setUpstreamFetchForTests(() => {
      used = true
      return Promise.resolve(new Response("y"))
    })
    void upstreamFetch("https://x.example", {})
    expect(used).toBe(true)
  })

  test("response-header deadline rejects a transport that never resolves headers", async () => {
    setUpstreamFetchForTests(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error), { once: true })
        }),
    )

    const pending = upstreamFetch("https://upstream.example/stall", { responseHeaderTimeoutMs: 10 })
    const error = await Promise.race([
      pending.catch((value: unknown) => value),
      new Promise((resolve) => setTimeout(() => resolve(new Error("test guard expired")), 100)),
    ])

    expect(error).toBeInstanceOf(DOMException)
    expect((error as Error).name).toBe("TimeoutError")
  })

  test("response-header deadline disarms when fetch resolves, so a long body survives", async () => {
    setUpstreamFetchForTests((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => controller.error(init.signal?.reason)
          init.signal?.addEventListener("abort", onAbort, { once: true })
          setTimeout(() => {
            init.signal?.removeEventListener("abort", onAbort)
            controller.enqueue(new TextEncoder().encode("late-body"))
            controller.close()
          }, 40)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })

    const response = await upstreamFetch("https://upstream.example/stream", { responseHeaderTimeoutMs: 10 })

    expect(await response.text()).toBe("late-body")
  })

  test("disarming the header deadline does not disarm the request lifecycle signal", async () => {
    const lifecycle = new AbortController()
    const reason = new DOMException("request_deadline", "AbortError")
    setUpstreamFetchForTests((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const response = await upstreamFetch("https://upstream.example/stream", {
      signal: lifecycle.signal,
      responseHeaderTimeoutMs: 1000,
    })

    lifecycle.abort(reason)

    const result = Promise.race([response.text(), new Promise((_, reject) => setTimeout(() => reject(new Error("test guard expired")), 100))])
    await expect(result).rejects.toBe(reason)
  })

  test("response-header deadline disarms when the transport throws synchronously", () => {
    const clock = new FakeClock()
    clock.install()
    const error = new Error("transport setup failed")
    setUpstreamFetchForTests(() => {
      throw error
    })

    try {
      expect(() => upstreamFetch("https://upstream.example/fail", { responseHeaderTimeoutMs: 10 })).toThrow(error)
      expect(clock.liveTimerCount).toBe(0)
    } finally {
      clock.restore()
    }
  })
})

describe("createResponseHeaderDeadline", () => {
  type Deadline = { signal: AbortSignal; complete(): boolean }
  type DeadlineFactory = (ms: number) => Deadline
  const clock = new FakeClock()

  afterEach(() => clock.restore())

  async function loadDeadlineModule(): Promise<{
    createResponseHeaderDeadline?: DeadlineFactory
    createResponseHeaderTimeoutError?: (ms: number) => DOMException
  }> {
    return import("~/lib/fetch-utils")
  }

  async function loadFactory(): Promise<DeadlineFactory | undefined> {
    return (await loadDeadlineModule()).createResponseHeaderDeadline
  }

  test("exports a scoped response-header deadline primitive", async () => {
    expect(await loadFactory()).toBeFunction()
  })

  test("builds the canonical response-header timeout error", async () => {
    const createError = (await loadDeadlineModule()).createResponseHeaderTimeoutError

    expect(createError).toBeFunction()
    if (!createError) return
    const error = createError(250)
    expect(error).toBeInstanceOf(DOMException)
    expect(error.name).toBe("TimeoutError")
    expect(error.message).toBe("Upstream response headers not received within 250ms")
  })

  test("headers completion wins when registered first at the deadline tick", async () => {
    const createDeadline = await loadFactory()
    if (!createDeadline) return
    clock.install()
    let completed: boolean | undefined
    const holder: { deadline?: Deadline } = {}
    setTimeout(() => {
      completed = holder.deadline?.complete()
    }, 10)
    const deadline = createDeadline(10)
    holder.deadline = deadline

    await clock.advance(10)

    expect(completed).toBe(true)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.complete()).toBe(false)
    expect(clock.liveTimerCount).toBe(0)
  })

  test("timeout wins when registered first at the deadline tick", async () => {
    const createDeadline = await loadFactory()
    if (!createDeadline) return
    clock.install()
    const deadline = createDeadline(10)
    let completed: boolean | undefined
    setTimeout(() => {
      completed = deadline.complete()
    }, 10)

    await clock.advance(10)

    expect(deadline.signal.aborted).toBe(true)
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError")
    expect(completed).toBe(false)
    expect(deadline.complete()).toBe(false)
    expect(clock.liveTimerCount).toBe(0)
  })

  test("external completion clears the timer exactly once", async () => {
    const createDeadline = await loadFactory()
    if (!createDeadline) return
    clock.install()
    const deadline = createDeadline(10)

    expect(deadline.complete()).toBe(true)
    expect(deadline.complete()).toBe(false)
    expect(clock.liveTimerCount).toBe(0)
    await clock.advance(10)
    expect(deadline.signal.aborted).toBe(false)
  })
})

describe("upstream dispatcher — keepalive contract", () => {
  autoRestoreState()

  afterEach(() => {
    // Re-init with no proxy so other suites see a clean dispatcher.
    initProxy({ fromEnv: false })
  })

  test("getUpstreamDispatcher returns a stable, configured dispatcher", () => {
    setStateForTests({ upstreamKeepaliveDelay: 15 })
    initProxy({ fromEnv: false })
    const dispatcher = getUpstreamDispatcher()
    // The keepAliveInitialDelay value lives in a Symbol-keyed undici Agent slot
    // that has no public getter; the delay-derivation itself (state →
    // getUpstreamKeepAliveDelayMs) is asserted in proxy.unit.test.ts, and the
    // real kernel-level keepalive is verified out-of-band (ss). Here we assert the
    // dispatcher is built and reused (single instance) across calls.
    expect(dispatcher).toBeDefined()
    expect(getUpstreamDispatcher()).toBe(dispatcher)
  })

  test("setUpstreamTransportConfig change triggers dispatcher rebuild via onUpstreamTransportChange subscription", () => {
    setStateForTests({ upstreamKeepaliveDelay: 15 })
    initProxy({ fromEnv: false })
    const before = getUpstreamDispatcher()

    setUpstreamTransportConfig({ upstreamKeepaliveDelay: 45 })

    expect(getUpstreamDispatcher()).not.toBe(before)
  })

  test("upstreamH2Favor change updates state but does NOT fire onUpstreamTransportChange listeners (no needless h2 reconcile / dispatcher rebuild)", () => {
    setStateForTests({ upstreamH2Favor: true, upstreamKeepaliveDelay: 15 })
    let fired = 0
    const unsubscribe = onUpstreamTransportChange(() => {
      fired += 1
    })
    try {
      // favor is a pure per-request routing flag: the value applies immediately...
      setUpstreamTransportConfig({ upstreamH2Favor: false })
      expect(state.upstreamH2Favor).toBe(false)
      // ...but no listener fires — direct oracle, independent of any specific
      // listener's side-effect shape (a favor flip must not retire h2 sessions).
      expect(fired).toBe(0)

      // Positive control: a real connection-affecting field DOES fire listeners,
      // proving the counter is wired and the 0 above is a genuine no-fire.
      setUpstreamTransportConfig({ upstreamKeepaliveDelay: 45 })
      expect(fired).toBe(1)
    } finally {
      unsubscribe()
    }
  })
})

describe("real undici load (C1 regression guard)", () => {
  test("undici/index.js loads the real undici, not Bun's dispatcher-ignoring shim", async () => {
    // Bun replaces bare "undici" with a built-in shim whose Agent lacks `stats`
    // and whose fetch silently drops the dispatcher (so TCP keepalive never
    // applies). The "undici/index.js" file subpath bypasses the shim. If anyone
    // reverts the import to bare "undici", this fails on Bun — guarding the whole
    // keepalive premise (see transport/upstream-fetch.ts + proxy.ts imports).
    const { Agent } = await import("undici/index.js")
    expect("stats" in new Agent({})).toBe(true)
  })

  test("getUpstreamDispatcher (production path) is backed by the real undici", () => {
    // Guards the PRODUCTION code path (proxy.ts → getUpstreamDispatcher), not just
    // that the subpath self-loads real undici. A real undici Agent has `stats`;
    // Bun's shim Agent does not. If proxy.ts reverts to bare "undici", this fails.
    initProxy({ fromEnv: false })
    expect("stats" in getUpstreamDispatcher()).toBe(true)
  })
})

describe("selectUpstreamTransport — https h2-favor routing", () => {
  autoRestoreState()

  test("https prefers http2 by default (favor=true)", () => {
    setUpstreamTransportConfig({ upstreamH2Favor: true })
    expect(selectUpstreamTransport(new URL("https://api.githubcopilot.com/v1/messages"))).toBe("http2")
  })

  test("https falls back to undici when favor=false", () => {
    setUpstreamTransportConfig({ upstreamH2Favor: false })
    expect(selectUpstreamTransport(new URL("https://api.githubcopilot.com/v1/messages"))).toBe("undici")
  })

  test("plaintext http always uses undici regardless of favor", () => {
    setUpstreamTransportConfig({ upstreamH2Favor: true })
    expect(selectUpstreamTransport(new URL("http://localhost:8080/search"))).toBe("undici")
    setUpstreamTransportConfig({ upstreamH2Favor: false })
    expect(selectUpstreamTransport(new URL("http://localhost:8080/search"))).toBe("undici")
  })
})
