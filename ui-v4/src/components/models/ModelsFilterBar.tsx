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

const SELECT_CLASS = "mono border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)]"

/** Parse a select value that encodes tri-state boolean ("" | "yes" | "no"). */
function triValue(v: boolean | null): string {
  return (
    v === null ? ""
    : v ? "yes"
    : "no"
  )
}
function parseTri(s: string): boolean | null {
  return s === "" ? null : s === "yes"
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
        className={SELECT_CLASS}
        onChange={(e) => onChange({ search: e.target.value })}
      />
      <select
        aria-label="Vendor"
        className={SELECT_CLASS}
        value={filters.vendor ?? ""}
        onChange={(e) => onChange({ vendor: e.target.value || null })}
      >
        <option value="">all vendors</option>
        {options.vendors.map((v) => (
          <option
            key={v}
            value={v}
          >
            {v}
          </option>
        ))}
      </select>
      <select
        aria-label="Type"
        className={SELECT_CLASS}
        value={filters.type ?? ""}
        onChange={(e) => onChange({ type: e.target.value || null })}
      >
        <option value="">all types</option>
        {options.types.map((t) => (
          <option
            key={t}
            value={t}
          >
            {t}
          </option>
        ))}
      </select>
      <select
        aria-label="Premium"
        className={SELECT_CLASS}
        value={triValue(filters.premium)}
        onChange={(e) => onChange({ premium: parseTri(e.target.value) })}
      >
        <option value="">premium: any</option>
        <option value="yes">premium</option>
        <option value="no">standard</option>
      </select>
      <select
        aria-label="Policy state"
        className={SELECT_CLASS}
        value={filters.policyState ?? ""}
        onChange={(e) => onChange({ policyState: e.target.value || null })}
      >
        <option value="">all policies</option>
        {options.policyStates.map((p) => (
          <option
            key={p}
            value={p}
          >
            {p}
          </option>
        ))}
      </select>
      <select
        aria-label="Has telemetry"
        className={SELECT_CLASS}
        value={triValue(filters.hasTelemetry)}
        onChange={(e) => onChange({ hasTelemetry: parseTri(e.target.value) })}
      >
        <option value="">telemetry: any</option>
        <option value="yes">has traffic</option>
        <option value="no">no traffic</option>
      </select>

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
