import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

const HEADERS = [
  "id",
  "vendor",
  "version",
  "family",
  "type",
  "context",
  "prompt",
  "output",
  "vision",
  "tool_calls",
  "streaming",
  "adaptive_thinking",
  "max_thinking_budget",
  "billing_multiplier",
  "premium",
  "restricted_to",
  "requests_7d",
  "failures_7d",
] as const

/** RFC-4180: wrap in quotes and double inner quotes when the value has , " or newline. */
function esc(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

const s = (value: string | number | boolean | undefined): string => (value === undefined ? "" : String(value))

/** Serialize the given models (typically the filtered view) to a flat CSV string.
 *  Telemetry columns come from the same normalized join used by the table. */
export function modelsToCsv(models: Array<Model>, telemetryFor: (id: string) => JoinedModelTelemetry | null): string {
  const rows = models.map((model) => {
    const c = deriveCapabilities(model)
    const t = telemetryFor(model.id)?.last7d ?? null
    const cells = [
      model.id,
      model.vendor,
      s(model.version),
      s(model.capabilities?.family),
      s(model.capabilities?.type),
      s(c.contextWindow),
      s(c.maxPrompt),
      s(c.maxOutput),
      String(c.vision),
      String(c.toolCalls),
      String(c.streaming),
      // Full-fidelity export (richest-data-flow): the granular adaptive flag + raw
      // budget preserve the same distinction the table cell shows; `thinking` = OR
      // of these two, so it stays derivable without a lossy boolean column.
      String(c.adaptiveThinking),
      s(c.maxThinkingBudget || undefined),
      s(model.billing?.multiplier),
      s(model.billing?.is_premium),
      (model.billing?.restricted_to ?? []).join(";"),
      s(t?.requestCount),
      s(t?.failureCount),
    ]
    return cells.map((cell) => esc(cell)).join(",")
  })
  return [HEADERS.join(","), ...rows].join("\n")
}
