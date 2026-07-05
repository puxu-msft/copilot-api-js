import { useLocalStorage } from "@vueuse/core"
import { type Ref } from "vue"

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

const ALL_COLUMNS: ReadonlyArray<{ key: ModelColumnKey; label: string }> = [
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
  { key: "requests7d", label: "Requests (7d)" },
]

// requests7d is hidden by default so the first paint doesn't depend on telemetry.
const DEFAULT_VISIBLE = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.key !== "requests7d"])) as Record<ModelColumnKey, boolean>

export interface UseModelColumnsReturn {
  visible: Ref<Record<ModelColumnKey, boolean>>
  isVisible: (key: ModelColumnKey) => boolean
  toggle: (key: ModelColumnKey) => void
  reset: () => void
  ALL_COLUMNS: typeof ALL_COLUMNS
}

/** Column visibility for the models table, persisted to localStorage. */
export function useModelColumns(): UseModelColumnsReturn {
  const stored = useLocalStorage<Record<ModelColumnKey, boolean>>("copilot-api-models-columns", DEFAULT_VISIBLE)
  // retain-on-absence: a persisted blob predating a new column key gets that key's default.
  stored.value = { ...DEFAULT_VISIBLE, ...stored.value }

  return {
    visible: stored,
    isVisible: (key) => stored.value[key],
    toggle: (key) => {
      stored.value = { ...stored.value, [key]: !stored.value[key] }
    },
    reset: () => {
      stored.value = { ...DEFAULT_VISIBLE }
    },
    ALL_COLUMNS,
  }
}
