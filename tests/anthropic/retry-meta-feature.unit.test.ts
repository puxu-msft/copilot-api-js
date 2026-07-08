/**
 * `retryMetaFeature` — the sticky-feature-tag decision for an accepted retry's
 * meta (handler-v4). Regression guard for the bug where the inline `else`
 * unconditionally tagged EVERY non-beta retry as `truncated`: only an actual
 * auto-truncate retry (carrying `truncateResult`) may map to `truncated`; the
 * other strategies' metas (server-tool / structured-outputs / body-field /
 * deferred-tool / legacy-thinking / network / token-refresh) map to no tag.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { retryMetaFeature } from "~/routes/messages/retry-meta-feature"

describe("retryMetaFeature", () => {
  test("beta-strip meta (strippedBetas) → beta-stripped with detail", () => {
    expect(retryMetaFeature({ strippedBetas: ["interleaved-thinking-2025-05-14"] }, false)).toEqual({
      feature: "beta-stripped",
      detail: { betas: ["interleaved-thinking-2025-05-14"] },
    })
  })

  test("beta-probe meta (probedBetas) → beta-stripped with detail", () => {
    expect(retryMetaFeature({ probedBetas: ["a", "b"] }, false)).toEqual({ feature: "beta-stripped", detail: { betas: ["a", "b"] } })
  })

  test("auto-truncate retry (hasTruncateResult, no betas) → truncated", () => {
    expect(retryMetaFeature({ truncateResult: {} }, true)).toEqual({ feature: "truncated" })
  })

  test("beta takes precedence over truncate when both present", () => {
    expect(retryMetaFeature({ strippedBetas: ["x"], truncateResult: {} }, true)).toEqual({ feature: "beta-stripped", detail: { betas: ["x"] } })
  })

  // The core regression: none of these may be branded `truncated`.
  test.each([
    ["server-tool", { strippedServerTools: ["web_search_"] }],
    ["structured-outputs", { strippedPartnerFeature: "structured_outputs" }],
    ["body-field", { rejectedField: "context_management" }],
    ["deferred-tool", { undeferredTool: "Read" }],
    ["legacy-thinking", { coercedAdaptiveThinking: true }],
    ["adaptive-thinking-rejection", { coercedEnabledThinking: true }],
    ["network", { networkRetry: true }],
    ["token-refresh", { tokenRefreshed: true }],
    ["empty meta", {}],
    ["empty strippedBetas array", { strippedBetas: [] }],
  ])("%s retry meta → no feature tag (not falsely truncated)", (_label, meta) => {
    expect(retryMetaFeature(meta, false)).toBeNull()
  })
})
