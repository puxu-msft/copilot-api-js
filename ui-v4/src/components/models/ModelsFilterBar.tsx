import { Select } from "radix-ui"

import type { ModelFilters } from "@/lib/model-filters"

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
  restrictedTo: Array<string>
  policyStates: Array<string>
}

interface ModelsFilterBarProps {
  filters: ModelFilters
  onChange: (patch: Partial<ModelFilters>) => void
  options: FilterOptions
}

const TRIGGER_CLASS =
  "mono inline-flex items-center gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none data-[state=open]:text-[var(--color-primary)]"
const ITEM_CLASS =
  "mono cursor-pointer px-2 py-1 text-[12px] text-[var(--color-text)] outline-none data-[highlighted]:bg-[#3a2f1a] data-[highlighted]:text-[var(--color-primary)] data-[state=checked]:text-[var(--color-primary)]"

/** Radix has no empty-string item value; use this sentinel for the "all/any" option. */
const ALL = "__all__"

/**
 * One filter dropdown on Radix `Select` (headless). Maps the "all/any" choice to
 * `null` via a sentinel (Radix forbids empty-string item values). Styled to
 * Terminal Amber (see docs/radix-styling.md).
 */
function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  allLabel: string
  options: ReadonlyArray<{ value: string; label: string }>
}) {
  return (
    <Select.Root
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? null : v)}
    >
      <Select.Trigger
        aria-label={label}
        className={TRIGGER_CLASS}
      >
        <Select.Value />
        <Select.Icon>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="mono z-50 border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Select.Viewport>
            <Select.Item
              value={ALL}
              className={ITEM_CLASS}
            >
              <Select.ItemText>{allLabel}</Select.ItemText>
            </Select.Item>
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className={ITEM_CLASS}
              >
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

/** Encode a tri-state boolean filter as a Select string value (null = any). */
function triToValue(v: boolean | null): string | null {
  if (v === null) return null
  return v ? "yes" : "no"
}
function valueToTri(v: string | null): boolean | null {
  return v === null ? null : v === "yes"
}

export function ModelsFilterBar({ filters, onChange, options }: ModelsFilterBarProps) {
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
