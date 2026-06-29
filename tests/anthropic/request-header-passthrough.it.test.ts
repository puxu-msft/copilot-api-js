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
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: ["x-anthropic-billing-header"] })
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
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: [] })
    const headers = prepare({ authorization: "Bearer CLIENT", Authorization: "Bearer CLIENT2" })
    // The proxy's core Authorization stays a single value; the client value never
    // leaks in (no comma-join from new Headers() case-variant collision downstream).
    expect(headers["Authorization"]).toMatch(/^Bearer /)
    expect(JSON.stringify(headers)).not.toContain("Bearer CLIENT")
  })

  test("strict=true sends only the rebuilt allowlist — no passthrough", () => {
    setStateForTests({ strictRequestHeaders: true, stripRequestHeaders: ["x-anthropic-billing-header"] })
    const headers = prepare({ "x-custom": "v", "x-anthropic-billing-header": "x" })
    expect(headers["x-custom"]).toBeUndefined()
    expect(headers["x-anthropic-billing-header"]).toBeUndefined()
  })

  test("empty strip list lets attribution pass through (default reversed)", () => {
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: [] })
    const headers = prepare({ "x-anthropic-billing-header": "kept" })
    expect(headers["x-anthropic-billing-header"]).toBe("kept")
  })

  test("strip '*' empties passthrough but never harms core/anthropic-beta", () => {
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: ["*"] })
    const headers = prepare({ "x-custom": "v" })
    expect(headers["x-custom"]).toBeUndefined()
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["anthropic-beta"]).toBeDefined()
  })

  test("anthropic-beta is core, never stripped even by a matching glob", () => {
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: ["anthropic-*"] })
    const headers = prepare({ "x-custom": "v" })
    expect(headers["anthropic-beta"]).toBeDefined()
    expect(headers["x-custom"]).toBe("v")
  })

  test("copilot-vision-request is reserved unconditionally (non-vision request)", () => {
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: [] })
    const headers = prepare({ "copilot-vision-request": "true", "x-keep": "1" })
    expect(headers["copilot-vision-request"]).toBeUndefined()
    expect(headers["x-keep"]).toBe("1")
  })

  test("client cannot override a dynamic modelRequestHeaders core key", () => {
    setStateForTests({ strictRequestHeaders: false, stripRequestHeaders: [] })
    const model = mockModel("claude-opus-4-6", { request_headers: { "x-foo": "core-val" } })
    const headers = prepare({ "x-foo": "client-val" }, model)
    expect(headers["x-foo"]).toBe("core-val")
  })
})
