import type React from "react"

import {
  //
  useEffect,
  useState,
} from "react"

import type { RequestFilters } from "@/lib/request-filters"

import { DateRangePopover } from "@/components/requests/DateRangePopover"
import { FilterSelect } from "@/components/shared/FilterSelect"
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback"
import { TERMINAL_STATES } from "@/lib/request-filters"

const INPUT_CLASS = "mono border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)]"

const ENDPOINT_OPTIONS = [
  { value: "anthropic-messages", label: "anthropic-messages" },
  { value: "openai-chat-completions", label: "openai-chat-completions" },
  { value: "openai-responses", label: "openai-responses" },
  { value: "gemini-generate-content", label: "gemini-generate-content" },
] as const

// state 只列终态(TERMINAL_STATES)——列表是 terminalOnly,非终态(pending/executing/streaming)会被全滤,列出来只会误导。
const STATE_OPTIONS = TERMINAL_STATES.map((s) => ({ value: s, label: s }))

/**
 * 七维筛选工具条:防抖文本 input(search/model/pid)+ shared `FilterSelect`(endpoint/state)+
 * `DateRangePopover`(from/to 时间范围)+ 末尾列菜单插槽。
 *
 * 文本维走**本地态即时反馈 + 防抖提交**(300ms):键入立刻回显、只在停顿后写回 URL(`setFilter`)。
 * `useEffect` 监听对应 `filters.*`,在外部清空(chip 关闭 / clear all)或外部改写时回填本地态。
 * `columnMenuSlot` 由调用方注入(本阶段传 `null`,Phase 3 传列可见性菜单)。
 */
export function RequestsFilterBar({
  filters,
  setFilter,
  columnMenuSlot,
}: {
  filters: RequestFilters
  setFilter: <K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => void
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
    // 空 → null、非数字 → null;仅整数 pid 有意义。
    const n = Number.parseInt(trimmed, 10)
    setFilter("pid", Number.isNaN(n) ? null : n)
  }, 300)

  // 外部清空 / 改写(chip 关闭、clear all、URL 直接变)时回填本地态;
  // 键入的正常回环(本地 → 防抖 setFilter → filters 变)会以相等值触发,幂等无害。
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
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-2 py-2 text-[12px]">
      <input
        type="text"
        value={search}
        placeholder="search text"
        aria-label="Filter by search"
        className={INPUT_CLASS}
        onChange={(e) => {
          setSearch(e.target.value)
          debouncedSearch(e.target.value)
        }}
      />
      <input
        type="text"
        value={model}
        placeholder="model"
        aria-label="Filter by model"
        className={INPUT_CLASS}
        onChange={(e) => {
          setModel(e.target.value)
          debouncedModel(e.target.value)
        }}
      />
      <input
        type="number"
        value={pid}
        placeholder="pid"
        aria-label="Filter by PID"
        className={INPUT_CLASS}
        onChange={(e) => {
          setPid(e.target.value)
          debouncedPid(e.target.value)
        }}
      />
      <FilterSelect
        label="Endpoint"
        value={filters.endpoint}
        onChange={(v) => setFilter("endpoint", v)}
        allLabel="all endpoints"
        options={ENDPOINT_OPTIONS}
      />
      <FilterSelect
        label="State"
        value={filters.state}
        onChange={(v) => setFilter("state", v)}
        allLabel="all states"
        options={STATE_OPTIONS}
      />
      <DateRangePopover
        from={filters.from}
        to={filters.to}
        onChange={(f, t) => {
          setFilter("from", f)
          setFilter("to", t)
        }}
      />
      {columnMenuSlot}
    </div>
  )
}
