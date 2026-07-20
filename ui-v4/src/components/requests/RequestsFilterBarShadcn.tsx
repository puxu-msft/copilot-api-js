import type React from "react"

import {
  //
  useEffect,
  useState,
} from "react"

import type { RequestFilters } from "@/lib/request-filters"

import { DateRangePopoverShadcn } from "@/components/requests/DateRangePopoverShadcn"
import { Input } from "@/components/ui/input"
import {
  //
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback"
import { TERMINAL_STATES } from "@/lib/request-filters"

const ENDPOINT_OPTIONS = [
  { value: "anthropic-messages", label: "anthropic-messages" },
  { value: "openai-chat-completions", label: "openai-chat-completions" },
  { value: "openai-responses", label: "openai-responses" },
  { value: "gemini-generate-content", label: "gemini-generate-content" },
] as const

// state 只列终态(TERMINAL_STATES)——列表是 terminalOnly,非终态会被全滤。
const STATE_OPTIONS = TERMINAL_STATES.map((s) => ({ value: s, label: s }))

/** Radix 无空串 item value;用哨兵映射「all/any」选项(镜像 shared/FilterSelect 的 ALL)。 */
const ALL = "__all__"

/** 单个筛选下拉(shadcn 侧)—— 复用 `ui/select`,ALL 哨兵 ↔ null。 */
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

/**
 * 七维筛选工具条(shadcn 侧)—— 防抖文本 input(search/model/pid,复用 `useDebouncedCallback` A)+
 * shadcn `Select`(endpoint/state,ALL 哨兵 ↔ null)+ `DateRangePopoverShadcn`(from/to)+ 末尾列菜单插槽。
 * 与 legacy `RequestsFilterBar` 行为逐字同构(本地态即时反馈 + 300ms 防抖提交),仅中性化呈现。legacy 冻结、Z1 才删。
 */
export function RequestsFilterBarShadcn({
  filters,
  setFilter,
  setFilters,
  columnMenuSlot,
}: {
  filters: RequestFilters
  setFilter: <K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => void
  setFilters: (patch: Partial<RequestFilters>) => void
  columnMenuSlot?: React.ReactNode
}) {
  const [search, setSearch] = useState(filters.search)
  const [model, setModel] = useState(filters.model)
  const [pid, setPid] = useState(filters.pid === null ? "" : String(filters.pid))

  const debouncedSearch = useDebouncedCallback((v: string) => setFilter("search", v), 300)
  const debouncedModel = useDebouncedCallback((v: string) => setFilter("model", v), 300)
  const debouncedPid = useDebouncedCallback((v: string) => {
    const trimmed = v.trim()
    if (trimmed === "") {
      setFilter("pid", null)
      return
    }
    const n = Number.parseInt(trimmed, 10)
    setFilter("pid", Number.isNaN(n) ? null : n)
  }, 300)

  useEffect(() => {
    setSearch(filters.search)
  }, [filters.search])
  useEffect(() => {
    setModel(filters.model)
  }, [filters.model])
  useEffect(() => {
    setPid(filters.pid === null ? "" : String(filters.pid))
  }, [filters.pid])

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2 text-sm">
      <Input
        type="text"
        value={search}
        placeholder="search text"
        aria-label="Filter by search"
        className="h-7 w-40"
        onChange={(e) => {
          setSearch(e.target.value)
          debouncedSearch(e.target.value)
        }}
      />
      <Input
        type="text"
        value={model}
        placeholder="model"
        aria-label="Filter by model"
        className="h-7 w-32"
        onChange={(e) => {
          setModel(e.target.value)
          debouncedModel(e.target.value)
        }}
      />
      <Input
        type="number"
        value={pid}
        placeholder="pid"
        aria-label="Filter by PID"
        className="h-7 w-24"
        onChange={(e) => {
          setPid(e.target.value)
          debouncedPid(e.target.value)
        }}
      />
      <FilterSelectShadcn
        label="Endpoint"
        value={filters.endpoint}
        onChange={(v) => setFilter("endpoint", v)}
        allLabel="all endpoints"
        options={ENDPOINT_OPTIONS}
      />
      <FilterSelectShadcn
        label="State"
        value={filters.state}
        onChange={(v) => setFilter("state", v)}
        allLabel="all states"
        options={STATE_OPTIONS}
      />
      <DateRangePopoverShadcn
        from={filters.from}
        to={filters.to}
        onChange={(f, t) => setFilters({ from: f, to: t })}
      />
      {columnMenuSlot}
    </div>
  )
}
