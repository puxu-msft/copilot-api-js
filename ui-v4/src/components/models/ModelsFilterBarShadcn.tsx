import type { ModelFilters } from "@/lib/model-filters"

import {
  //
  Input,
} from "@/components/ui/input"
import {
  //
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  //
  countActiveFilters,
  EMPTY_FILTERS,
} from "@/lib/model-filters"

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

interface ModelsFilterBarShadcnProps {
  filters: ModelFilters
  onChange: (patch: Partial<ModelFilters>) => void
  options: FilterOptions
  billingBounds: [number, number]
}

/** Radix 无空串 item value;用哨兵映射「all/any」选项。 */
const ALL = "__all__"

/** Encode a tri-state boolean filter as a Select string value (null = any). */
function triToValue(v: boolean | null): string | null {
  if (v === null) return null
  return v ? "yes" : "no"
}
function valueToTri(v: string | null): boolean | null {
  return v === null ? null : v === "yes"
}

/** 单个筛选下拉(shadcn 侧)—— 复用 `ui/select`,ALL 哨兵 ↔ null(镜像 legacy FilterSelect)。 */
function FilterSelectShadcn({
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
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? null : v)}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 复用中性 chip class:选中 = primary 描边/字,未选 = border/muted 字。 */
function chipClass(active: boolean, extra = ""): string {
  return `border px-1.5 py-0.5 text-xs ${active ? "border-primary text-primary" : `border-border text-muted-foreground ${extra}`}`
}

/**
 * Models 七维筛选工具条(shadcn 侧)—— shadcn `Input`(search)+ `Select`(vendor/type/endpoint/premium/
 * policy/telemetry,ALL 哨兵 ↔ null)+ `Slider`(billing range)+ 能力/plan/show 中性 chip toggle。
 * 与 legacy `ModelsFilterBar` 行为逐字同构(复用 `countActiveFilters`/`EMPTY_FILTERS` 数据层),仅中性化呈现。
 * legacy 冻结、Z1 才删。
 */
export function ModelsFilterBarShadcn({ filters, onChange, options, billingBounds }: ModelsFilterBarShadcnProps) {
  const toggleCapability = (value: string) => {
    const has = filters.capabilities.includes(value)
    onChange({ capabilities: has ? filters.capabilities.filter((c) => c !== value) : [...filters.capabilities, value] })
  }
  const toggleRestricted = (value: string) => {
    const has = filters.restrictedTo.includes(value)
    onChange({ restrictedTo: has ? filters.restrictedTo.filter((p) => p !== value) : [...filters.restrictedTo, value] })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2 text-sm">
      <Input
        type="text"
        value={filters.search}
        placeholder="search id / name"
        aria-label="Search models"
        className="h-7 w-40"
        onChange={(e) => onChange({ search: e.target.value })}
      />
      <FilterSelectShadcn
        label="Vendor"
        value={filters.vendor}
        onChange={(v) => onChange({ vendor: v })}
        allLabel="all vendors"
        options={options.vendors.map((v) => ({ value: v, label: v }))}
      />
      <FilterSelectShadcn
        label="Type"
        value={filters.type}
        onChange={(v) => onChange({ type: v })}
        allLabel="all types"
        options={options.types.map((t) => ({ value: t, label: t }))}
      />
      <FilterSelectShadcn
        label="Endpoint"
        value={filters.endpoint}
        onChange={(v) => onChange({ endpoint: v })}
        allLabel="all endpoints"
        options={options.endpoints.map((e) => ({ value: e, label: e }))}
      />
      <FilterSelectShadcn
        label="Premium"
        value={triToValue(filters.premium)}
        onChange={(v) => onChange({ premium: valueToTri(v) })}
        allLabel="premium: any"
        options={[
          { value: "yes", label: "premium" },
          { value: "no", label: "standard" },
        ]}
      />
      <FilterSelectShadcn
        label="Policy state"
        value={filters.policyState}
        onChange={(v) => onChange({ policyState: v })}
        allLabel="all policies"
        options={options.policyStates.map((p) => ({ value: p, label: p }))}
      />
      <FilterSelectShadcn
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
          <span className="text-xs uppercase text-muted-foreground">plan:</span>
          {options.restrictedTo.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={filters.restrictedTo.includes(p)}
              onClick={() => toggleRestricted(p)}
              className={chipClass(filters.restrictedTo.includes(p))}
            >
              {p}
            </button>
          ))}
        </div>
      : null}

      {billingBounds[1] > billingBounds[0] ?
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="uppercase">$×</span>
          <Slider
            className="w-28"
            aria-label="Billing multiplier range"
            min={billingBounds[0]}
            max={billingBounds[1]}
            step={0.5}
            value={filters.billingRange ?? billingBounds}
            onValueChange={(v) => onChange({ billingRange: [v[0], v[1]] })}
          />
          <span className="tabular-nums">
            {(filters.billingRange ?? billingBounds)[0]}–{(filters.billingRange ?? billingBounds)[1]}
          </span>
        </label>
      : null}

      <div className="flex items-center gap-1">
        <span className="text-xs uppercase text-muted-foreground">caps:</span>
        {CAPABILITY_OPTIONS.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={filters.capabilities.includes(c.value)}
            onClick={() => toggleCapability(c.value)}
            className={chipClass(filters.capabilities.includes(c.value))}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div
        role="group"
        aria-label="Show disabled model kinds"
        className="flex items-center gap-1"
      >
        {/* Checkbox affordance:[✓] = shown、[ ] + strike = hidden(消除「高亮=包含」歧义)。 */}
        <span className="text-xs uppercase text-muted-foreground">show:</span>
        <button
          type="button"
          aria-pressed={filters.includeConfigDisabled}
          title={filters.includeConfigDisabled ? "showing config-disabled models — click to hide" : "config-disabled models hidden — click to show"}
          onClick={() => onChange({ includeConfigDisabled: !filters.includeConfigDisabled })}
          className={`inline-flex items-center gap-1 ${filters.includeConfigDisabled ? chipClass(true) : chipClass(false, "line-through")}`}
        >
          <span aria-hidden="true">{filters.includeConfigDisabled ? "[✓]" : "[ ]"}</span>
          config-off
        </button>
        <button
          type="button"
          aria-pressed={filters.includePickerDisabled}
          title={filters.includePickerDisabled ? "showing picker-disabled models — click to hide" : "picker-disabled models hidden — click to show"}
          onClick={() => onChange({ includePickerDisabled: !filters.includePickerDisabled })}
          className={`inline-flex items-center gap-1 ${filters.includePickerDisabled ? chipClass(true) : chipClass(false, "line-through")}`}
        >
          <span aria-hidden="true">{filters.includePickerDisabled ? "[✓]" : "[ ]"}</span>
          picker-off
        </button>
      </div>

      {(() => {
        const active = countActiveFilters(filters, billingBounds)
        if (active === 0) return null
        return (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-primary">{active} active</span>
            <button
              type="button"
              className="border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onChange(EMPTY_FILTERS)}
            >
              clear all
            </button>
          </div>
        )
      })()}
    </div>
  )
}
