import { useState } from "react"

import type { EntryStatus } from "@/types"

import { LearnedRow } from "@/components/learned/LearnedRow"
import { useLearned } from "@/hooks/useLearned"
import { api } from "@/lib/api"
import { triggerDownload } from "@/lib/export-entry"
import {
  //
  badgeKind,
  CATEGORY_LABELS,
} from "@/lib/learned"

type Filter = "all" | "active" | "expired" | "pinned"

/** 过滤按钮的显示标签（值不变，仅渲染文案本地化 —— 见 spec §4.5）。 */
const FILTER_LABELS: Record<Filter, string> = {
  all: "全部",
  active: "active",
  expired: "已过期",
  pinned: "pinned",
}

function matches(filter: Filter, status: EntryStatus): boolean {
  if (filter === "all") return true
  return badgeKind(status) === filter
}

export function LearnedPage() {
  const actions = useLearned()
  const [filter, setFilter] = useState<Filter>("all")
  const [exporting, setExporting] = useState(false)

  async function onExport() {
    if (exporting) return
    setExporting(true)
    try {
      const blob = await api.getBlob("/api/negotiation/export")
      triggerDownload(blob, "negotiation-states.json")
    } finally {
      setExporting(false)
    }
  }

  if (actions.query.isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const snap = actions.query.data
  const groups = (snap?.categories ?? [])
    .map((g) => ({ ...g, entries: g.entries.filter((e) => matches(filter, e.status)) }))
    .filter((g) => g.entries.length > 0)

  return (
    <div className="mono flex h-full flex-col gap-2 overflow-auto p-2 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">反应式学习记录</div>
        <div className="ml-auto flex items-center gap-1">
          {(["all", "active", "expired", "pinned"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`border px-2 py-0.5 text-[11px] ${filter === f ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted)]"}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
          <button
            type="button"
            className="border border-[var(--color-primary)] px-2 py-0.5 text-[11px] text-[var(--color-primary)] disabled:opacity-50"
            onClick={() => void onExport()}
            disabled={exporting}
          >
            {exporting ? "导出中…" : "整体导出"}
          </button>
        </div>
      </div>
      {groups.length === 0 ?
        <div className="text-[12px] text-[var(--color-muted)]">无记录</div>
      : null}
      {groups.map((g) => (
        <section
          key={g.category}
          className="border border-[var(--color-border)]"
        >
          <div className="flex items-center gap-2 bg-[#15151a] px-2 py-1 text-[12px]">
            <span className="text-[var(--color-primary)]">{CATEGORY_LABELS[g.category]}</span>
            <span className="text-[10px] text-[var(--color-muted)]">
              {g.entries.length} 条 · TTL {g.ttlMs === null ? "永不" : `${Math.round(g.ttlMs / 86_400_000)}d`}
            </span>
          </div>
          {g.entries.map((e) => (
            <LearnedRow
              key={`${e.key}|${e.value}`}
              entry={e}
              actions={actions}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
