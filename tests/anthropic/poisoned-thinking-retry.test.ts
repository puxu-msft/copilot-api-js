/**
 * L2 reactive strip-all retry — the guarded matcher for the GHC
 * "thinking ... cannot be modified" 400.
 *
 * Only the matcher is asserted here (the reactive fallback's decision gate). It
 * MUST fire on the real rejection body, and it MUST NOT fire on the legacy
 * `thinking.type.enabled` rejection (handled by a separate strategy) or on an
 * unrelated 400 — a false positive would strip thinking from turns the upstream
 * never complained about.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { isThinkingModifiedRejection } from "~/lib/codec/anthropic/poisoned-thinking-retry"

describe("isThinkingModifiedRejection", () => {
  test("正命中真实 body", () => {
    expect(
      isThinkingModifiedRejection(
        "messages.3.content.34: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
      ),
    ).toBe(true)
  })

  test("负命中 legacy thinking.type.enabled", () => {
    expect(isThinkingModifiedRejection('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"')).toBe(false)
  })

  test("负命中无关 400", () => {
    expect(isThinkingModifiedRejection("messages.0: Extra inputs are not permitted")).toBe(false)
  })
})
