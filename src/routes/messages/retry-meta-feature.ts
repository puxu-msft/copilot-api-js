/**
 * `retryMetaFeature` — decide the single sticky feature tag implied by an
 * accepted retry's `meta` (or `null` for none).
 *
 * Pure + neutral leaf so BOTH retry-record sites share one primitive: the v4
 * driver path (`handler-v4.ts`'s `recordRetryPipelineStateV4`) and the legacy
 * web_search-bypass path (`web-search-direct.ts`'s `recordRetryPipelineState`).
 * It lives here (not in either handler) to avoid the import cycle
 * handler-v4 → web-search-handler → web-search-direct.
 *
 * The historical inline `else` in both sites unconditionally tagged `truncated`,
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
