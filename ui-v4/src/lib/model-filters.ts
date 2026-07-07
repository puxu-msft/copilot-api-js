import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"

export interface ModelFilters {
  search: string
  vendor: string | null
  type: string | null
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
    if (filters.hasTelemetry !== null && hasTelemetry(m.id) !== filters.hasTelemetry) return false
    return true
  })
}
