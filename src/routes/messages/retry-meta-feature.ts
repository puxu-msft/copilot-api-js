/**
 * `retryMetaFeature` — decide the single sticky feature tag implied by an
 * accepted retry's `meta` (or `null` for none).
 *
 * Pure + neutral leaf consumed by the v4 driver path (`handler-v4.ts`'s
 * `recordRetryPipelineStateV4`). Lives here (not in the handler) so it stays a
 * dependency-free primitive.
 *
 * The historical inline `else` unconditionally tagged `truncated`,
 * which is only correct for an auto-truncate retry. A beta-strip retry carries
 * `probedBetas`/`strippedBetas`; a truncate retry carries `truncateResult`
 * (passed in as `hasTruncateResult`); every other strategy's meta (server-tool /
 * structured-outputs / body-field / deferred-tool / legacy-thinking / network /
 * token-refresh) maps to NO feature tag.
 */

import type { FeatureKind } from "~/lib/observability"

export function retryMetaFeature(meta: Record<string, unknown>, hasTruncateResult: boolean): { feature: FeatureKind; detail?: Record<string, unknown> } | null {
  const strippedBetas = (meta.probedBetas ?? meta.strippedBetas) as Array<string> | undefined
  if (strippedBetas && strippedBetas.length > 0) return { feature: "beta-stripped", detail: { betas: strippedBetas } }
  if (hasTruncateResult) return { feature: "truncated" }
  return null
}
