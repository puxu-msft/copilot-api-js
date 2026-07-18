import pc from "picocolors"
import stringWidth from "string-width"

import type {
  //
  ModelCatalogData,
  ModelCatalogEntry,
} from "~/lib/observability"

import { sanitizeTerminalText } from "./sanitize"
import { consolaPrefix } from "./syslog"

/** Legacy label column expressed correctly in terminal display columns. */
const MIN_LABEL_COLUMNS = 45

export type AvailableModelView = ModelCatalogEntry

/** Format limit values as "Xk" or "?" if not available. */
function formatLimit(value?: number): string {
  return value === undefined ? "?" : `${Math.round(value / 1000)}k`
}

/**
 * Format complete model identities into naturally wrapping log lines. Ordinary
 * labels share a minimum display-width column; longer labels remain complete
 * and move only their own limit fields right instead of being ellipsized.
 */
export function formatAvailableModelLines(views: ReadonlyArray<AvailableModelView>, options: { tokenBasedBilling: boolean }): Array<string> {
  return views.map(({ model, disabled }) => {
    const limits = model.capabilities?.limits
    const disabledTag = disabled ? " [disabled]" : ""
    const billingLabel = !options.tokenBasedBilling && model.billing?.multiplier !== undefined ? ` (${model.billing.multiplier}x)` : ""
    const label = sanitizeTerminalText(`${model.id}${billingLabel} (${model.vendor})${disabledTag}`)
    const paddedLabel = `${label}${" ".repeat(Math.max(0, MIN_LABEL_COLUMNS - stringWidth(label)))}`
    const contextK = formatLimit(limits?.max_context_window_tokens)
    const promptK = formatLimit(limits?.max_prompt_tokens)
    const outputK = formatLimit(limits?.max_output_tokens)
    const context = `ctx:${contextK.padStart(5)}`
    const prompt = `prp:${promptK.padStart(5)}`
    const output = `out:${outputK.padStart(5)}`
    const plain = `  - ${paddedLabel} ${context} ${prompt} ${output}`
    if (disabled) return pc.gray(plain)
    const renderedContext = limits?.max_context_window_tokens !== undefined && limits.max_context_window_tokens >= 900_000 ? pc.yellow(context) : context
    const renderedPrompt = limits?.max_prompt_tokens !== undefined && limits.max_prompt_tokens >= 900_000 ? pc.yellow(prompt) : prompt
    return `  - ${paddedLabel} ${renderedContext} ${renderedPrompt} ${output}`
  })
}

export function renderModelCatalogLines(catalog: ModelCatalogData): Array<string> {
  return [`${consolaPrefix("info", new Date(catalog.timeUnixMs))} Available models:`, ...formatAvailableModelLines(catalog.models, catalog)]
}
