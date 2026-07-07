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
  markServerToolHistoryDowngrade,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  resolveServerToolHistoryMode,
} from "~/lib/anthropic/server-tool-history-mode"
import {
  //
  setAnthropicBehavior,
} from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

afterEach(() => clearAnthropicFeatureNegotiationForTests())

describe("resolveServerToolHistoryMode", () => {
  autoRestoreState()

  test("learned-downgrade model (reactive) → downgrade even when global config is false", () => {
    setAnthropicBehavior({ rewriteHistoryServerTools: false })
    markServerToolHistoryDowngrade("claude-sonnet-4.6")
    expect(resolveServerToolHistoryMode("claude-sonnet-4.6")).toBe("downgrade")
  })
  test("non-learned model with global false → false", () => {
    setAnthropicBehavior({ rewriteHistoryServerTools: false })
    expect(resolveServerToolHistoryMode("claude-opus-4.8")).toBe(false)
  })
  test("global downgrade config → downgrade for any (non-learned) model", () => {
    setAnthropicBehavior({ rewriteHistoryServerTools: "downgrade" })
    expect(resolveServerToolHistoryMode("claude-opus-4.8")).toBe("downgrade")
  })
})
