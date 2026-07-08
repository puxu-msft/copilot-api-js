import type { ModelFilters } from "@/lib/model-filters"

import { FilterSelect } from "@/components/shared/FilterSelect"
import { RangeSlider } from "@/components/shared/RangeSlider"

const CAPABILITY_OPTIONS = [
  { value: "vision", label: "Vision" },
  { value: "toolCalls", label: "Tools" },
  { value: "parallelToolCalls", label: "Parallel" },
  { value: "structuredOutputs", label: "Structured" },
  { value: "streaming", label: "Streaming" },
  { value: "thinking", label: "Thinking" },
] as const

interface FilterOptions {
  vendors: Array<string>
  types: Array<string>
  endpoints: Array<string>
  restrictedTo: Array<string>
  policyStates: Array<string>
}

interface ModelsFilterBarProps {
  filters: ModelFilters
  onChange: (patch: Partial<ModelFilters>) => void
  options: FilterOptions
  billingBounds: [number, number]
}

/** Encode a tri-state boolean filter as a Select string value (null = any). */
function triToValue(v: boolean | null): string | null {
  if (v === null) return null
  return v ? "yes" : "no"
}
function valueToTri(v: string | null): boolean | null {
  return v === null ? null : v === "yes"
}

export function ModelsFilterBar({ filters, onChange, options, billingBounds }: ModelsFilterBarProps) {
  const toggleCapability = (value: string) => {
    const has = filters.capabilities.includes(value)
    onChange({ capabilities: has ? filters.capabilities.filter((c) => c !== value) : [...filters.capabilities, value] })
  }
  const toggleRestricted = (value: string) => {
    const has = filters.restrictedTo.includes(value)
    onChange({ restrictedTo: has ? filters.restrictedTo.filter((p) => p !== value) : [...filters.restrictedTo, value] })
  }

  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-2 py-2 text-[12px]">
      <input
        type="text"
        value={filters.search}
        placeholder="search id / name"
        aria-label="Search models"
        className="mono border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)]"
        onChange={(e) => onChange({ search: e.target.value })}
      />
      <FilterSelect
        label="Vendor"
        value={filters.vendor}
        onChange={(v) => onChange({ vendor: v })}
        allLabel="all vendors"
        options={options.vendors.map((v) => ({ value: v, label: v }))}
      />
      <FilterSelect
        label="Type"
        value={filters.type}
        onChange={(v) => onChange({ type: v })}
        allLabel="all types"
        options={options.types.map((t) => ({ value: t, label: t }))}
      />
      <FilterSelect
        label="Endpoint"
        value={filters.endpoint}
        onChange={(v) => onChange({ endpoint: v })}
        allLabel="all endpoints"
        options={options.endpoints.map((e) => ({ value: e, label: e }))}
      />
      <FilterSelect
        label="Premium"
        value={triToValue(filters.premium)}
        onChange={(v) => onChange({ premium: valueToTri(v) })}
        allLabel="premium: any"
        options={[
          { value: "yes", label: "premium" },
          { value: "no", label: "standard" },
        ]}
      />
      <FilterSelect
        label="Policy state"
        value={filters.policyState}
        onChange={(v) => onChange({ policyState: v })}
        allLabel="all policies"
        options={options.policyStates.map((p) => ({ value: p, label: p }))}
      />
      <FilterSelect
        label="Has telemetry"
        value={triToValue(filters.hasTelemetry)}
        onChange={(v) => onChange({ hasTelemetry: valueToTri(v) })}
        allLabel="telemetry: any"
        options={[
          { value: "yes", label: "has traffic" },
          { value: "no", label: "no traffic" },
        ]}
      />

      {options.restrictedTo.length > 0 ?
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase text-[var(--color-muted)]">plan:</span>
          {options.restrictedTo.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => toggleRestricted(p)}
              className={`border px-1.5 py-0.5 text-[11px] ${filters.restrictedTo.includes(p) ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[#999]"}`}
            >
              {p}
            </button>
          ))}
        </div>
      : null}

      {billingBounds[1] > billingBounds[0] ?
        <RangeSlider
          label="$×"
          min={billingBounds[0]}
          max={billingBounds[1]}
          value={filters.billingRange}
          onChange={(v) => onChange({ billingRange: v })}
        />
      : null}

      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase text-[var(--color-muted)]">caps:</span>
        {CAPABILITY_OPTIONS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => toggleCapability(c.value)}
            className={`border px-1.5 py-0.5 text-[11px] ${filters.capabilities.includes(c.value) ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[#999]"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
