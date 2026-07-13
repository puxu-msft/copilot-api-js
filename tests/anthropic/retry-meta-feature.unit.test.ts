/**
 * `retryMetaFeature` — the sticky-feature-tag decision for an accepted retry's
 * meta (handler-v4). Only a beta-strip retry (carrying `strippedBetas`/`probedBetas`)
 * maps to a feature tag; the other strategies' metas (server-tool / structured-outputs
 * / body-field / deferred-tool / legacy-thinking / network / token-refresh) map to no
 * tag.
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
    expect(retryMetaFeature({ strippedBetas: ["interleaved-thinking-2025-05-14"] })).toEqual({
      feature: "beta-stripped",
      detail: { betas: ["interleaved-thinking-2025-05-14"] },
    })
  })

  test("beta-probe meta (probedBetas) → beta-stripped with detail", () => {
    expect(retryMetaFeature({ probedBetas: ["a", "b"] })).toEqual({ feature: "beta-stripped", detail: { betas: ["a", "b"] } })
  })

  // None of these may be branded with a feature tag.
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
  ])("%s retry meta → no feature tag", (_label, meta) => {
    expect(retryMetaFeature(meta)).toBeNull()
  })
})
