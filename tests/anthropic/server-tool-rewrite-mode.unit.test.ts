import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  markServerToolDowngrade,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  resolveServerToolMode,
} from "~/lib/anthropic/server-tool-rewrite-mode"
import {
  //
  setAnthropicBehavior,
} from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

afterEach(() => clearAnthropicFeatureNegotiationForTests())

describe("resolveServerToolMode", () => {
  autoRestoreState()

  test("learned-downgrade model (reactive) → downgrade even when global config is false", () => {
    setAnthropicBehavior({ rewriteServerTools: false })
    markServerToolDowngrade("claude-sonnet-4.6")
    expect(resolveServerToolMode("claude-sonnet-4.6")).toBe("downgrade")
  })
  test("non-learned model with global false → false", () => {
    setAnthropicBehavior({ rewriteServerTools: false })
    expect(resolveServerToolMode("claude-opus-4.8")).toBe(false)
  })
  test("global downgrade config → downgrade for any (non-learned) model", () => {
    setAnthropicBehavior({ rewriteServerTools: "downgrade" })
    expect(resolveServerToolMode("claude-opus-4.8")).toBe("downgrade")
  })
})
