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
  if (model.model_picker_enabled === false) return "picker-disabled"
  return "enabled"
}
