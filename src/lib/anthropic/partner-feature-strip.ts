/**
 * The single table that drives BOTH partner-feature strip sites — the reactive
 * rejection strategy (`structured-outputs-rejection-retry`) and the prepare step
 * (`strip-partner-features` in `request-preparation`). Each site iterates /
 * consults this table instead of hardcoding a single feature, so extending
 * coverage to a new partner feature is a DATA change (add a row) rather than a
 * logic change touching two files.
 *
 * Only features with a KNOWN, SAFE strip target belong here: a partner feature
 * whose wire field can be removed while leaving a still-valid request that
 * merely degrades gracefully. Today that is exactly `structured_outputs` →
 * strip `output_config.format` (drops the client's JSON-schema guarantee,
 * degrading to free-form output). Other disallowed partner features
 * (`extended_thinking`, `vision`, …) have no obvious "remove this one field"
 * mapping — stripping the wrong thing would silently change request semantics —
 * so they are deliberately absent (no speculative rows, per RFC gap D / O4).
 *
 * The identification half (`parseDisallowedPartnerFeature`) is already
 * feature-agnostic; this table is the remediation half.
 */

/** Wire strip descriptor: which wire field the feature maps to. */
interface PartnerFeatureStripTarget {
  path: "output_config.format"
}

/**
 * Feature name (exactly as the upstream org policy reports it) → wire strip
 * descriptor. Only features with a KNOWN SAFE strip target.
 */
export const PARTNER_FEATURE_STRIP_TARGETS: Readonly<Record<string, PartnerFeatureStripTarget>> = {
  structured_outputs: { path: "output_config.format" },
}

/**
 * Remove `format` from `output_config`, dropping `output_config` entirely if it
 * empties. Sibling keys (e.g. `effort`) are preserved. Reassigns the top-level
 * `output_config` property (never mutates the nested object in place), so a
 * shallow-cloned wire can be stripped without mutating the caller's original.
 * Returns whether the wire actually changed.
 */
function stripOutputConfigFormat(wire: Record<string, unknown>): boolean {
  const outputConfig = wire.output_config as { format?: unknown } | undefined
  if (!outputConfig || outputConfig.format === undefined) return false

  const { format: _format, ...rest } = outputConfig
  if (Object.keys(rest).length > 0) {
    wire.output_config = rest
  } else {
    delete wire.output_config
  }
  return true
}

/**
 * Strip the given partner feature's wire field per {@link PARTNER_FEATURE_STRIP_TARGETS}.
 * No-op returning `false` when the feature has no strip target (not in the table)
 * or its field is already absent; returns `true` when it changed the wire.
 */
export function stripPartnerFeatureFromWire(wire: Record<string, unknown>, feature: string): boolean {
  // Runtime lookup against an arbitrary feature string: `Object.hasOwn` is the
  // real miss branch (the Record index type alone would elide a truthiness check).
  if (!Object.hasOwn(PARTNER_FEATURE_STRIP_TARGETS, feature)) return false
  return STRIP_BY_PATH[PARTNER_FEATURE_STRIP_TARGETS[feature].path](wire)
}

/**
 * Exhaustive dispatch from a strip path to its wire mutator. Keyed by the
 * `path` union, so adding a new path variant to {@link PartnerFeatureStripTarget}
 * forces a matching entry here (the Record type won't compile otherwise) — the
 * type system routes each new feature to a real strip implementation.
 */
const STRIP_BY_PATH: Record<PartnerFeatureStripTarget["path"], (wire: Record<string, unknown>) => boolean> = {
  "output_config.format": stripOutputConfigFormat,
}
