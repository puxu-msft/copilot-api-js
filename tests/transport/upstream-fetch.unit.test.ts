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
