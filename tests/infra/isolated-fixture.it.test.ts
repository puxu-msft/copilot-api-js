/**
 * Self-test for the unified isolation fixture (tests/helpers/isolated-fixture.ts).
 *
 * Validates the two behaviors the fixture adds over the existing primitives:
 *   1. the upstream network guard fails loudly on an unmocked call (and a mock,
 *      or `network:"passthrough"`, overrides it)
 *   2. the RESETTERS table actually fires in afterEach — a module-global mutated
 *      in one test is clean in the next (cross-test in-memory leak is killed)
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  isAnthropicFeatureUnsupported,
  markAnthropicFeatureUnsupported,
} from "~/lib/anthropic/feature-negotiation"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { setFetchMock } from "../helpers/mock-fetch"

describe("useIsolatedRuntime — upstream network guard", () => {
  useIsolatedRuntime()

  test("an unmocked upstream fetch throws loudly instead of hitting the network", async () => {
    await expect(upstreamFetch("https://api.example.com/v1/anything", { method: "GET" })).rejects.toThrow(/unmocked upstream/)
  })

  test("installing a mock overrides the guard", async () => {
    setFetchMock(() => new Response("{}", { status: 200 }))
    const res = await upstreamFetch("https://api.example.com/v1/anything", { method: "GET" })
    expect(res.status).toBe(200)
  })
})

describe("useIsolatedRuntime — RESETTERS fire between tests", () => {
  useIsolatedRuntime()

  test("a: mark a negotiation incompatibility", () => {
    markAnthropicFeatureUnsupported("claude-fixture-selftest", "context_management")
    expect(isAnthropicFeatureUnsupported("claude-fixture-selftest", "context_management")).toBe(true)
  })

  test("b: the mark from test 'a' was cleared by the fixture afterEach", () => {
    // If the fixture did not reset the negotiation maps, this would still be true
    // and leak across tests — the exact failure the fixture exists to prevent.
    expect(isAnthropicFeatureUnsupported("claude-fixture-selftest", "context_management")).toBe(false)
  })
})

describe("useIsolatedRuntime — network:'passthrough' opts out of the guard", () => {
  useIsolatedRuntime({ network: "passthrough" })

  test("a mock works under passthrough (no guard interference)", async () => {
    setFetchMock(() => new Response("ok", { status: 201 }))
    const res = await upstreamFetch("https://api.example.com/v1/anything", { method: "POST", body: "{}" })
    expect(res.status).toBe(201)
  })
})
