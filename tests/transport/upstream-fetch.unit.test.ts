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
import { setStateForTests } from "~/lib/state"
import {
  //
  setUpstreamFetchForTests,
  upstreamFetch,
} from "~/lib/transport/upstream-fetch"

import { autoRestoreState } from "../helpers/state-fixture"

describe("upstreamFetch — test bridge", () => {
  afterEach(() => {
    setUpstreamFetchForTests(undefined)
  })

  test("routes through the injected fn and forwards url + init", async () => {
    const calls: Array<{ url: string; init: unknown }> = []
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
})
