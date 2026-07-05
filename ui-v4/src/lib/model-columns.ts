/** Toggleable columns for the models table. `id`/`name` are always shown (not here). */
export type ModelColumnKey =
  | "vendor"
  | "context"
  | "output"
  | "effort"
  | "vision"
  | "toolCalls"
  | "parallelToolCalls"
  | "structuredOutputs"
  | "streaming"
  | "thinking"
  | "billing"
  | "requests7d"

export const MODEL_COLUMNS: ReadonlyArray<{ key: ModelColumnKey; label: string }> = [
  { key: "vendor", label: "Vendor" },
  { key: "context", label: "Context" },
  { key: "output", label: "Output" },
  { key: "effort", label: "Effort" },
  { key: "vision", label: "Vision" },
  { key: "toolCalls", label: "Tools" },
  { key: "parallelToolCalls", label: "Parallel" },
  { key: "structuredOutputs", label: "Structured" },
  { key: "streaming", label: "Streaming" },
  { key: "thinking", label: "Thinking" },
  { key: "billing", label: "Billing ×" },
  { key: "requests7d", label: "Req 7d" },
]

export type ModelColumnVisibility = Record<ModelColumnKey, boolean>

// requests7d hidden by default so first paint doesn't depend on telemetry.
export const DEFAULT_COLUMN_VISIBILITY: ModelColumnVisibility = Object.fromEntries(
  MODEL_COLUMNS.map((c) => [c.key, c.key !== "requests7d"]),
) as ModelColumnVisibility

/**
 * Merge a persisted visibility blob onto the defaults: unknown/missing keys take
 * their default (retain-on-absence — a blob predating a new column still works),
 * unknown persisted keys are dropped.
 */
export function mergeColumnVisibility(persisted: Partial<ModelColumnVisibility> | null | undefined): ModelColumnVisibility {
  const merged = { ...DEFAULT_COLUMN_VISIBILITY }
  if (persisted && typeof persisted === "object") {
    for (const col of MODEL_COLUMNS) {
      const v = persisted[col.key]
      if (typeof v === "boolean") merged[col.key] = v
    }
  }
  return merged
}
