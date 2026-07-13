/**
 * `retryMetaFeature` — decide the single sticky feature tag implied by an
 * accepted retry's `meta` (or `null` for none).
 *
 * Pure + neutral leaf consumed by the v4 driver path (`handler-v4.ts`'s
 * `recordRetryPipelineStateV4`). Lives here (not in the handler) so it stays a
 * dependency-free primitive.
 *
 * A beta-strip retry carries `probedBetas`/`strippedBetas`; every other
 * strategy's meta (server-tool / structured-outputs / body-field / deferred-tool /
 * legacy-thinking / network / token-refresh) maps to NO feature tag.
 */

import type { FeatureKind } from "~/lib/observability"

export function retryMetaFeature(meta: Record<string, unknown>): { feature: FeatureKind; detail?: Record<string, unknown> } | null {
  const strippedBetas = (meta.probedBetas ?? meta.strippedBetas) as Array<string> | undefined
  if (strippedBetas && strippedBetas.length > 0) return { feature: "beta-stripped", detail: { betas: strippedBetas } }
  return null
}
