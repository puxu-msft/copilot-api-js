import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import { getEffectiveEndpoints } from "~backend/lib/models/endpoint"

export interface ModelFilters {
  search: string
  vendor: string | null
  type: string | null
  endpoint: string | null
  /** Inclusive [min, max] over billing multipliers; null = no filter. */
  billingRange: [number, number] | null
  /** Derived boolean capability keys the model must ALL satisfy (AND). */
  capabilities: Array<string>
  premium: boolean | null
  restrictedTo: Array<string>
  policyState: string | null
  hasTelemetry: boolean | null
}

export const EMPTY_FILTERS: ModelFilters = {
  search: "",
  vendor: null,
  type: null,
  endpoint: null,
  billingRange: null,
  capabilities: [],
  premium: null,
  restrictedTo: [],
  policyState: null,
  hasTelemetry: null,
}

export function matchesPremium(model: Model, value: boolean | null): boolean {
  return value === null || Boolean(model.billing?.is_premium) === value
}

export function matchesRestrictedTo(model: Model, selected: Array<string>): boolean {
  if (selected.length === 0) return true
  const plans = model.billing?.restricted_to ?? []
  return selected.some((plan) => plans.includes(plan))
}

export function matchesPolicyState(model: Model, value: string | null): boolean {
  return value === null || model.policy?.state === value
}

export function matchesEndpoint(model: Model, value: string | null): boolean {
  if (value === null) return true
  return getEffectiveEndpoints(model)?.includes(value) ?? false
}

/** Vue 语义：无 multiplier 视为 0（下界抬离 0 会排除这些模型）。 */
function billingMultiplier(model: Model): number {
  return typeof model.billing?.multiplier === "number" ? model.billing.multiplier : 0
}

export function matchesBilling(model: Model, range: [number, number] | null): boolean {
  if (range === null) return true
  const v = billingMultiplier(model)
  return v >= range[0] && v <= range[1]
}

/** 目录内 multiplier 的 [min, max]（缺失当 0）。空目录返回 [0, 0]。 */
export function modelBillingBounds(models: Array<Model>): [number, number] {
  if (models.length === 0) return [0, 0]
  let min = Infinity
  let max = -Infinity
  for (const m of models) {
    const v = billingMultiplier(m)
    if (v < min) min = v
    if (v > max) max = v
  }
  return [min, max]
}

/** Apply all filters. `hasTelemetry(id)` reports whether the model joined any telemetry. */
export function filterModels(models: Array<Model>, filters: ModelFilters, hasTelemetry: (id: string) => boolean): Array<Model> {
  const query = filters.search.trim().toLowerCase()
  return models.filter((m) => {
    if (query && !m.id.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) return false
    if (filters.vendor && m.vendor !== filters.vendor) return false
    if (filters.type && m.capabilities?.type !== filters.type) return false
    if (filters.capabilities.length > 0) {
      const caps = deriveCapabilities(m) as unknown as Record<string, boolean>
      if (!filters.capabilities.every((c) => caps[c])) return false
    }
    if (!matchesPremium(m, filters.premium)) return false
    if (!matchesRestrictedTo(m, filters.restrictedTo)) return false
    if (!matchesPolicyState(m, filters.policyState)) return false
    if (!matchesEndpoint(m, filters.endpoint)) return false
    if (!matchesBilling(m, filters.billingRange)) return false
    if (filters.hasTelemetry !== null && hasTelemetry(m.id) !== filters.hasTelemetry) return false
    return true
  })
}
