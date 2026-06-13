import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  computed,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue"

import { api } from "@/api/http"
import { getEffectiveEndpoints } from "@/utils/model-endpoints"

/** Authoritative raw model shape (single source — no local `Record<string,any>`). */
export type ModelData = Model

/** Derived boolean capabilities exposed as multi-select (AND) filter chips. */
export const CAPABILITY_FILTERS = [
  { value: "vision", title: "Vision" },
  { value: "toolCalls", title: "Tools" },
  { value: "parallelToolCalls", title: "Parallel" },
  { value: "structuredOutputs", title: "Structured" },
  { value: "streaming", title: "Streaming" },
  { value: "thinking", title: "Thinking" },
] as const

export function useModelsCatalog() {
  const models = ref<Array<Model>>([])
  const loading = shallowRef(true)
  const error = shallowRef<string | null>(null)
  const searchQuery = shallowRef("")
  const vendorFilter = shallowRef<string | null>(null)
  const endpointFilter = shallowRef<string | null>(null)
  /** Multi-select capability filter — a model must satisfy ALL selected (AND). */
  const featureFilters = ref<Array<string>>([])
  const typeFilter = shallowRef<string | null>(null)
  const billingRange = ref<[number, number]>([0, 0])
  const rawApiResponse = ref<unknown>(null)

  onMounted(async () => {
    try {
      const result = await api.fetchModels()
      rawApiResponse.value = result
      models.value = result.data as unknown as Array<Model>
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load models"
    } finally {
      loading.value = false
    }
  })

  // Cache derived capabilities per model object (deriveCapabilities is pure).
  const capsCache = new WeakMap<Model, DerivedCapabilities>()
  function caps(model: Model): DerivedCapabilities {
    let c = capsCache.get(model)
    if (!c) {
      c = deriveCapabilities(model)
      capsCache.set(model, c)
    }
    return c
  }

  const vendorOptions = computed(() => [...new Set(models.value.map((m) => m.vendor).filter(Boolean))].sort())

  const endpointOptions = computed(() => {
    const set = new Set<string>()
    for (const model of models.value) for (const endpoint of getEffectiveEndpoints(model)) set.add(endpoint)
    return [...set].sort()
  })

  const featureOptions = CAPABILITY_FILTERS

  const typeOptions = computed(() =>
    [...new Set(models.value.map((m) => m.capabilities?.type).filter((v): v is string => typeof v === "string" && v.length > 0))].sort(),
  )

  const billingBounds = computed(() => {
    const values = models.value.map((m) => m.billing?.multiplier).filter((v): v is number => typeof v === "number")
    if (values.length === 0) return { min: 0, max: 0 }
    return { min: Math.floor(Math.min(...values)), max: Math.ceil(Math.max(...values)) }
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
      if (nextMin !== currentMin || nextMax !== currentMax) billingRange.value = [nextMin, nextMax]
    },
    { immediate: true },
  )

  const filteredModels = computed(() => {
    let result = models.value
    if (vendorFilter.value) result = result.filter((m) => m.vendor === vendorFilter.value)
    const endpoint = endpointFilter.value
    if (endpoint) result = result.filter((m) => getEffectiveEndpoints(m).includes(endpoint))
    // Capability filter: model must satisfy ALL selected derived flags (AND).
    if (featureFilters.value.length > 0) {
      result = result.filter((m) => {
        const c = caps(m) as unknown as Record<string, boolean>
        return featureFilters.value.every((f) => c[f])
      })
    }
    if (typeFilter.value) result = result.filter((m) => m.capabilities?.type === typeFilter.value)
    const [billingMin, billingMax] = billingRange.value
    result = result.filter((m) => {
      const multiplier = typeof m.billing?.multiplier === "number" ? m.billing.multiplier : 0
      return multiplier >= billingMin && multiplier <= billingMax
    })
    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase()
      result = result.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
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

  function fmtNum(n: number | undefined): string {
    if (typeof n !== "number" || !n) return "-"
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  return {
    billingBounds,
    billingRange,
    caps,
    endpointFilter,
    endpointOptions,
    error,
    featureFilters,
    featureOptions,
    filteredModels,
    fmtNum,
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
