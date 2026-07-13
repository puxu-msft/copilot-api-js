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

import { autoRestoreState } from "../helpers/state-fixture"

afterEach(() => clearAnthropicFeatureNegotiationForTests())

describe("resolveServerToolMode", () => {
  autoRestoreState()

  // The global `server_tool_rewrite` config source was removed with the web_search
  // retirement (2026-07-13); the learned-downgrade set is now the ONLY source.
  test("learned-downgrade model (reactive) → downgrade", () => {
    markServerToolDowngrade("claude-sonnet-4.6")
    expect(resolveServerToolMode("claude-sonnet-4.6")).toBe("downgrade")
  })
  test("non-learned model → false", () => {
    expect(resolveServerToolMode("claude-opus-4.8")).toBe(false)
  })
})
