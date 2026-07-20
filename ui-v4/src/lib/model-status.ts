import type { Model } from "~backend/lib/models/client"

/** Tri-state model availability from the UI's POV. */
export type ModelStatus = "enabled" | "config-disabled" | "picker-disabled"

/**
 * Classify a model. `config-disabled` (this project's `config.disabled_models`,
 * carried in the `/api/models` envelope `disabled[]`) takes priority over the
 * upstream `model_picker_enabled: false` (`picker-disabled`) — a model that is
 * both shows the more relevant config-disabled state. Priority only decides which
 * label a dual-state model shows; it never hides a row.
 */
export function modelStatus(model: Model, configDisabled: ReadonlySet<string>): ModelStatus {
  if (configDisabled.has(model.id)) return "config-disabled"
  if (!model.model_picker_enabled) return "picker-disabled"
  return "enabled"
}

/** Presentational vocabulary for a status — the SINGLE source shared by the table
 *  status column and the detail-drawer header, so the dot/color/label never drift.
 *  `glyph` is a filled/hollow dot (a non-color shape cue, so color is never the
 *  only signal); `label` is null for `enabled` (the majority default renders
 *  dot-only, no noisy per-row text). Renderers apply `colorVar` to the DOT only and
 *  keep the label in `--color-text` (readable contrast on any row), and expose
 *  `title` as the full accessible name via `role="img"` + `aria-label`. */
export interface ModelStatusMeta {
  glyph: string
  /** CSS color token (a `var(--…)`) for the DOT glyph only — never the label text
   *  (muted tokens fail text contrast; the dot is non-text UI at the 3:1 bar). */
  colorVar: string
  /** Full meaning — the accessible name (`role="img"` + `aria-label`) + the tooltip. */
  title: string
  /** Short scannable label; `null` for enabled (dot-only). */
  label: string | null
}

/** Status → presentational vocabulary. A `Record` keyed by `ModelStatus` so the
 *  type system enforces exhaustiveness (add a status → this must gain a key).
 *  Only `config-disabled` carries a signal color (red) — enabled/picker-disabled
 *  are muted so the genuine exception pops instead of a wall of green dots. */
const STATUS_META: Record<ModelStatus, ModelStatusMeta> = {
  "config-disabled": { glyph: "●", colorVar: "var(--signal-fail)", title: "disabled via config.disabled_models", label: "disabled" },
  "picker-disabled": { glyph: "○", colorVar: "var(--signal-muted)", title: "not shown in model picker (model_picker_enabled: false)", label: "picker-off" },
  enabled: { glyph: "●", colorVar: "var(--signal-muted)", title: "enabled", label: null },
}

export function statusMeta(status: ModelStatus): ModelStatusMeta {
  return STATUS_META[status]
}
