import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"

const originalState = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(originalState)
})

function basePayload(): MessagesPayload {
  return {
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }
}

function prepare(clientRequestHeaders: Record<string, string>, model = mockModel("claude-opus-4-6")) {
  return prepareAnthropicRequest(basePayload(), { resolvedModel: model, clientRequestHeaders }).headers
}

describe("upstream request header passthrough (anthropic.strict_request_headers)", () => {
  test("default passthrough: forwards custom headers, strips attribution, reserves core", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: ["x-anthropic-billing-header"] })
    const headers = prepare({
      "x-custom": "v",
      "x-anthropic-billing-header": "should-be-stripped",
      authorization: "Bearer CLIENT",
    })
    expect(headers["x-custom"]).toBe("v")
    expect(headers["x-anthropic-billing-header"]).toBeUndefined()
  })

  test("client authorization (case-variant) never joins/overrides the proxy's Authorization", () => {
    // The #1 regression lock: new Headers() comma-JOINS case-variant duplicate keys.
    // selectPassthroughHeaders must drop the client value BEFORE the merge so the proxy
    // core Authorization stays a single value.
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: [] })
    const headers = prepare({ authorization: "Bearer CLIENT", Authorization: "Bearer CLIENT2" })
    // The proxy's core Authorization stays a single value; the client value never
    // leaks in (no comma-join from new Headers() case-variant collision downstream).
    expect(headers["Authorization"]).toMatch(/^Bearer /)
    expect(JSON.stringify(headers)).not.toContain("Bearer CLIENT")
  })

  test("whitelist mode (strict=true): forwards ONLY whitelisted client headers, drops the rest", () => {
    setStateForTests({ strictRequestHeaders: true, requestHeaderWhitelist: ["x-stainless-*", "x-claude-code-*"] })
    const headers = prepare({
      "x-stainless-os": "linux",
      "x-claude-code-agent-id": "sub",
      "x-custom": "v",
      "x-anthropic-billing-header": "x",
    })
    // POSITIVE allow-path samples: whitelisted client headers DO reach the upstream.
    expect(headers["x-stainless-os"]).toBe("linux")
    expect(headers["x-claude-code-agent-id"]).toBe("sub")
    // Non-whitelisted client headers are dropped.
    expect(headers["x-custom"]).toBeUndefined()
    expect(headers["x-anthropic-billing-header"]).toBeUndefined()
    // Core is always present.
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("whitelist mode with empty whitelist forwards nothing (core-only — old strict=true behavior)", () => {
    setStateForTests({ strictRequestHeaders: true, requestHeaderWhitelist: [] })
    const headers = prepare({ "x-stainless-os": "linux", "x-custom": "v" })
    expect(headers["x-stainless-os"]).toBeUndefined()
    expect(headers["x-custom"]).toBeUndefined()
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("whitelist mode: the security floor still strips credentials even with whitelist '*'", () => {
    setStateForTests({ strictRequestHeaders: true, requestHeaderWhitelist: ["*"] })
    const headers = prepare({ authorization: "Bearer CLIENT", cookie: "secret", "x-custom": "v" })
    // Floor removes credentials regardless of the whitelist; core Authorization wins.
    expect(headers["Authorization"]).toMatch(/^Bearer /)
    expect(JSON.stringify(headers)).not.toContain("Bearer CLIENT")
    expect(headers["cookie"]).toBeUndefined()
    // A non-core, non-sensitive header IS forwarded under whitelist '*'.
    expect(headers["x-custom"]).toBe("v")
  })

  test("empty strip list lets attribution pass through (default reversed)", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: [] })
    const headers = prepare({ "x-anthropic-billing-header": "kept" })
    expect(headers["x-anthropic-billing-header"]).toBe("kept")
  })

  test("strip '*' empties passthrough but never harms core/anthropic-beta", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: ["*"] })
    const headers = prepare({ "x-custom": "v" })
    expect(headers["x-custom"]).toBeUndefined()
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["anthropic-beta"]).toBeDefined()
  })

  test("anthropic-beta is core, never stripped even by a matching glob", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: ["anthropic-*"] })
    const headers = prepare({ "x-custom": "v" })
    expect(headers["anthropic-beta"]).toBeDefined()
    expect(headers["x-custom"]).toBe("v")
  })

  test("copilot-vision-request is reserved unconditionally (non-vision request)", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: [] })
    const headers = prepare({ "copilot-vision-request": "true", "x-keep": "1" })
    expect(headers["copilot-vision-request"]).toBeUndefined()
    expect(headers["x-keep"]).toBe("1")
  })

  test("client cannot override a dynamic modelRequestHeaders core key", () => {
    setStateForTests({ strictRequestHeaders: false, requestHeaderBlacklist: [] })
    const model = mockModel("claude-opus-4-6", { request_headers: { "x-foo": "core-val" } })
    const headers = prepare({ "x-foo": "client-val" }, model)
    expect(headers["x-foo"]).toBe("core-val")
  })
})
