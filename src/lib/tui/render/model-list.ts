import stringWidth from "string-width"

import type { Model } from "~/lib/models/client"

/** Legacy label column expressed correctly in terminal display columns. */
const MIN_LABEL_COLUMNS = 45

export interface AvailableModelView {
  model: Model
  disabled: boolean
  /** Precomputed account-aware billing badge, including its leading space. */
  billingLabel: string
}

/** Format limit values as "Xk" or "?" if not available. */
function formatLimit(value?: number): string {
  return value ? `${Math.round(value / 1000)}k` : "?"
}

/**
 * Format complete model identities into naturally wrapping log lines. Ordinary
 * labels share a minimum display-width column; longer labels remain complete
 * and move only their own limit fields right instead of being ellipsized.
 */
export function formatAvailableModelLines(views: ReadonlyArray<AvailableModelView>): Array<string> {
  return views.map(({ model, disabled, billingLabel }) => {
    const limits = model.capabilities?.limits
    const disabledTag = disabled ? " [disabled]" : ""
    const label = `${model.id}${billingLabel} (${model.vendor})${disabledTag}`
    const paddedLabel = `${label}${" ".repeat(Math.max(0, MIN_LABEL_COLUMNS - stringWidth(label)))}`
    const contextK = formatLimit(limits?.max_context_window_tokens)
    const promptK = formatLimit(limits?.max_prompt_tokens)
    const outputK = formatLimit(limits?.max_output_tokens)
    return `  - ${paddedLabel} ctx:${contextK.padStart(5)} prp:${promptK.padStart(5)} out:${outputK.padStart(5)}`
  })
}
