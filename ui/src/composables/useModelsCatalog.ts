import { computed, onMounted, ref, watch } from "vue"

import { api } from "@/api/http"
import { getEffectiveEndpoints } from "@/utils/model-endpoints"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelData = Record<string, any>
export interface PrimaryLimitMetric {
  key: "context" | "prompt" | "output" | "inputs"
  label: string
  value: string
  progress: number
}

export function useModelsCatalog() {
  const models = ref<Array<ModelData>>([])
  const loading = ref(true)
  const searchQuery = ref("")
  const vendorFilter = ref<string | null>(null)
  const endpointFilter = ref<string | null>(null)
  const featureFilter = ref<string | null>(null)
  const typeFilter = ref<string | null>(null)
  const billingRange = ref<[number, number]>([0, 0])
  const rawApiResponse = ref<unknown>(null)

  onMounted(async () => {
    try {
      const result = await api.fetchModels()
      rawApiResponse.value = result
      models.value = (result.data ?? []) as Array<ModelData>
    } catch {
      // Non-critical
    } finally {
      loading.value = false
    }
  })

  const vendorOptions = computed(() => [...new Set(models.value.map((m) => m.vendor as string).filter(Boolean))].sort())

  const endpointOptions = computed(() => {
    const set = new Set<string>()
    for (const model of models.value) {
      for (const endpoint of getEffectiveEndpoints(model)) {
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

  const typeOptions = computed(() =>
    [
      ...new Set(
        models.value
          .map((m) => m.capabilities?.type as string | undefined)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ].sort(),
  )

  const billingBounds = computed(() => {
    const values = models.value
      .map((model) => model.billing?.multiplier)
      .filter((value): value is number => typeof value === "number")

    if (values.length === 0) return { min: 0, max: 0 }

    return {
      min: Math.floor(Math.min(...values)),
      max: Math.ceil(Math.max(...values)),
    }
  })

  watch(
    billingBounds,
    (bounds) => {
      const [currentMin, currentMax] = billingRange.value
      const isUninitialized = currentMin === 0 && currentMax === 0 && bounds.max > 0

      if (isUninitialized) {
        billingRange.value = [bounds.min, bounds.max]
        return
      }

      const nextMin = Math.max(bounds.min, Math.min(currentMin, bounds.max))
      const nextMax = Math.max(nextMin, Math.max(bounds.min, Math.min(currentMax, bounds.max)))

      if (nextMin !== currentMin || nextMax !== currentMax) {
        billingRange.value = [nextMin, nextMax]
      }
    },
    { immediate: true },
  )

  const filteredModels = computed(() => {
    let result = models.value
    if (vendorFilter.value) result = result.filter((m) => m.vendor === vendorFilter.value)
    if (endpointFilter.value) {
      result = result.filter((m) => getEffectiveEndpoints(m).includes(endpointFilter.value!))
    }
    if (featureFilter.value) {
      result = result.filter(
        (m) => (m.capabilities?.supports as Record<string, unknown> | undefined)?.[featureFilter.value!] === true,
      )
    }
    if (typeFilter.value) {
      result = result.filter((m) => m.capabilities?.type === typeFilter.value)
    }
    const [billingMin, billingMax] = billingRange.value
    result = result.filter((m) => {
      const multiplier = typeof m.billing?.multiplier === "number" ? m.billing.multiplier : 0
      return multiplier >= billingMin && multiplier <= billingMax
    })
    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase()
      result = result.filter(
        (m) =>
          (m.id as string).toLowerCase().includes(query)
          || (m.name as string | undefined)?.toLowerCase().includes(query),
      )
    }
    return result
  })

  const limitMaximums = computed(() => {
    let context = 0
    let prompt = 0
    let output = 0
    let inputs = 0

    for (const model of models.value) {
      const limits = model.capabilities?.limits as Record<string, unknown> | undefined
      const contextValue = typeof limits?.max_context_window_tokens === "number" ? limits.max_context_window_tokens : 0
      const promptValue = typeof limits?.max_prompt_tokens === "number" ? limits.max_prompt_tokens : 0
      const outputValue = typeof limits?.max_output_tokens === "number" ? limits.max_output_tokens : 0
      const inputValue = typeof limits?.max_inputs === "number" ? limits.max_inputs : 0

      if (contextValue > context) context = contextValue
      if (promptValue > prompt) prompt = promptValue
      if (outputValue > output) output = outputValue
      if (inputValue > inputs) inputs = inputValue
    }

    return { context, prompt, output, inputs }
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

  function getPrimaryLimits(model: ModelData): Array<PrimaryLimitMetric> {
    const limits = model.capabilities?.limits as Record<string, unknown> | undefined
    const modelType = model.capabilities?.type
    const contextValue = typeof limits?.max_context_window_tokens === "number" ? limits.max_context_window_tokens : 0
    const promptValue = typeof limits?.max_prompt_tokens === "number" ? limits.max_prompt_tokens : 0
    const outputValue = typeof limits?.max_output_tokens === "number" ? limits.max_output_tokens : 0
    const inputValue = typeof limits?.max_inputs === "number" ? limits.max_inputs : 0

    if (modelType === "embeddings") {
      if (inputValue <= 0) return []
      return [
        {
          key: "inputs",
          label: "Max Inputs",
          value: fmtNum(inputValue),
          progress: limitMaximums.value.inputs > 0 ? (inputValue / limitMaximums.value.inputs) * 100 : 0,
        },
      ]
    }

    return [
      {
        key: "context",
        label: "Context Window",
        value: contextValue > 0 ? fmtNum(contextValue) : "-",
        progress: limitMaximums.value.context > 0 ? (contextValue / limitMaximums.value.context) * 100 : 0,
      },
      {
        key: "prompt",
        label: "Max Prompt",
        value: promptValue > 0 ? fmtNum(promptValue) : "-",
        progress: limitMaximums.value.prompt > 0 ? (promptValue / limitMaximums.value.prompt) * 100 : 0,
      },
      {
        key: "output",
        label: "Max Output",
        value: outputValue > 0 ? fmtNum(outputValue) : "-",
        progress: limitMaximums.value.output > 0 ? (outputValue / limitMaximums.value.output) * 100 : 0,
      },
    ]
  }

  function getLimits(model: ModelData): Array<[string, string]> {
    const limits = model.capabilities?.limits as Record<string, unknown> | undefined
    if (!limits) return []
    const result: Array<[string, string]> = []
    if (limits.max_inputs) result.push(["Max Inputs", fmtNum(limits.max_inputs)])
    if (limits.max_context_window_tokens) result.push(["Context Window", fmtNum(limits.max_context_window_tokens)])
    if (limits.max_prompt_tokens) result.push(["Max Prompt", fmtNum(limits.max_prompt_tokens)])
    if (limits.max_output_tokens) result.push(["Max Output", fmtNum(limits.max_output_tokens)])
    if (limits.max_non_streaming_output_tokens)
      result.push(["Non-stream Output", fmtNum(limits.max_non_streaming_output_tokens)])
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
    billingBounds,
    billingRange,
    endpointFilter,
    endpointOptions,
    featureFilter,
    featureOptions,
    filteredModels,
    getCapabilities,
    getLimits,
    getPrimaryLimits,
    getThinkingBudget,
    getVision,
    loading,
    models,
    rawApiResponse,
    searchQuery,
    typeFilter,
    typeOptions,
    vendorColor,
    vendorFilter,
    vendorOptions,
  }
}
