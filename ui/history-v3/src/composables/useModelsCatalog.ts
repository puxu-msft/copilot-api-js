import { computed, onMounted, ref } from "vue"

import { api } from "@/api/http"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelData = Record<string, any>

export function useModelsCatalog() {
  const models = ref<Array<ModelData>>([])
  const loading = ref(true)
  const searchQuery = ref("")
  const vendorFilter = ref<string | null>(null)
  const endpointFilter = ref<string | null>(null)
  const featureFilter = ref<string | null>(null)
  const rawApiResponse = ref<unknown>(null)
  const viewSwitch = ref(0)
  const viewModes = ref<Record<string, "parsed" | "raw">>({})

  function getViewMode(id: string): "parsed" | "raw" {
    return viewModes.value[id] ?? "parsed"
  }

  function toggleViewMode(id: string): void {
    viewModes.value = {
      ...viewModes.value,
      [id]: getViewMode(id) === "parsed" ? "raw" : "parsed",
    }
  }

  onMounted(async () => {
    try {
      const result = await api.fetchModels(true)
      rawApiResponse.value = result
      models.value = (result.data ?? []) as Array<ModelData>
    } catch {
      // Non-critical
    } finally {
      loading.value = false
    }
  })

  const vendorOptions = computed(() => [...new Set(models.value.map((m) => m.owned_by as string).filter(Boolean))].sort())

  const endpointOptions = computed(() => {
    const set = new Set<string>()
    for (const model of models.value) {
      for (const endpoint of (model.supported_endpoints as Array<string> | undefined) ?? []) {
        set.add(endpoint)
      }
    }
    return [...set].sort()
  })

  const featureOptions = computed(() => {
    const set = new Set<string>()
    for (const model of models.value) {
      const supports = model.capabilities?.supports as Record<string, unknown> | undefined
      if (!supports) continue
      for (const [key, value] of Object.entries(supports)) {
        if (value === true) set.add(key)
      }
    }
    return [...set].sort().map((feature) => ({ title: feature.replaceAll("_", " "), value: feature }))
  })

  const filteredModels = computed(() => {
    let result = models.value
    if (vendorFilter.value) result = result.filter((m) => m.owned_by === vendorFilter.value)
    if (endpointFilter.value) {
      result = result.filter((m) => ((m.supported_endpoints as Array<string> | undefined) ?? []).includes(endpointFilter.value!))
    }
    if (featureFilter.value) {
      result = result.filter(
        (m) => (m.capabilities?.supports as Record<string, unknown> | undefined)?.[featureFilter.value!] === true,
      )
    }
    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase()
      result = result.filter(
        (m) =>
          (m.id as string).toLowerCase().includes(query)
          || (m.display_name as string | undefined)?.toLowerCase().includes(query),
      )
    }
    return result
  })

  function vendorColor(vendor: string | undefined): string {
    if (!vendor) return "secondary"
    const normalized = vendor.toLowerCase()
    if (normalized.includes("anthropic")) return "purple"
    if (normalized.includes("openai") || normalized.includes("azure")) return "info"
    if (normalized.includes("google")) return "success"
    return "pink"
  }

  function fmtNum(n: unknown): string {
    if (typeof n !== "number" || !n) return "-"
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  function getCapabilities(model: ModelData): Array<string> {
    const supports = model.capabilities?.supports as Record<string, unknown> | undefined
    if (!supports) return []
    return Object.entries(supports)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
  }

  function getLimits(model: ModelData): Array<[string, string]> {
    const limits = model.capabilities?.limits as Record<string, unknown> | undefined
    if (!limits) return []
    const result: Array<[string, string]> = []
    if (limits.max_context_window_tokens) result.push(["Context", fmtNum(limits.max_context_window_tokens)])
    if (limits.max_prompt_tokens) result.push(["Prompt", fmtNum(limits.max_prompt_tokens)])
    if (limits.max_output_tokens) result.push(["Output", fmtNum(limits.max_output_tokens)])
    if (limits.max_non_streaming_output_tokens) result.push(["Non-stream", fmtNum(limits.max_non_streaming_output_tokens)])
    return result
  }

  function getThinkingBudget(model: ModelData): string | null {
    const supports = model.capabilities?.supports as Record<string, unknown> | undefined
    if (!supports?.max_thinking_budget) return null
    return `${fmtNum(supports.min_thinking_budget)} - ${fmtNum(supports.max_thinking_budget)}`
  }

  function getVision(model: ModelData): Array<[string, string]> | null {
    const vision = model.capabilities?.limits?.vision as Record<string, unknown> | undefined
    if (!vision) return null
    const result: Array<[string, string]> = []
    if (vision.max_prompt_images) result.push(["Max images", String(vision.max_prompt_images)])
    if (vision.max_prompt_image_size) result.push(["Max size", fmtNum(vision.max_prompt_image_size)])
    if (vision.supported_media_types) result.push(["Formats", (vision.supported_media_types as Array<string>).join(", ")])
    return result.length > 0 ? result : null
  }

  return {
    endpointFilter,
    endpointOptions,
    featureFilter,
    featureOptions,
    filteredModels,
    getCapabilities,
    getLimits,
    getThinkingBudget,
    getViewMode,
    getVision,
    loading,
    rawApiResponse,
    searchQuery,
    toggleViewMode,
    vendorColor,
    vendorFilter,
    vendorOptions,
    viewSwitch,
  }
}
