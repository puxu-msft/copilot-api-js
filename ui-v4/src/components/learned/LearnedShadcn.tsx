import { useState } from "react"

import type { EntryStatus } from "@/types"

import { LearnedRow } from "@/components/learned/LearnedRow"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  //
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

const FILTERS = ["all", "active", "expired", "pinned"] as const

function matches(filter: Filter, status: EntryStatus): boolean {
  if (filter === "all") return true
  return badgeKind(status) === filter
}

/**
 * fork B · Learned 页元素(shadcn 页壳,P7 完整版)。
 *
 * 与 legacy(`LearnedLegacy`)共用 A 数据 hook `useLearned` + export 逻辑(两树共用,不复制数据层)。
 * 视图编排(filter 状态 / matches / groups 派生 / export)本 commit 内联,后续 commit 单向抽共享 hook。
 * 本组件只负责呈现层:
 *  - 页壳用 shadcn `Card` + `Button` + `Badge` + 中性语义 token(`text-foreground`/`bg-card`/
 *    `text-muted-foreground`),圆角随 `--radius`。
 *  - 每个学习规则分类一张 `Card`(分类名 + 条数 + TTL),内嵌**中性化后的 B 内容体** `LearnedRow`
 *    (续约/失效/固定/删除 管理操作 + `StatusBadge`)逐字复用。
 * `data-testid=learned-shadcn` 供 fork B 互斥挂载守卫(loading 态亦保留,便于守卫恒可定位)。
 */
export function LearnedShadcn() {
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

  const snap = actions.query.data
  const filtering = filter !== "all"
  const groups = (snap?.categories ?? [])
    .map((g) => ({ ...g, entries: g.entries.filter((e) => matches(filter, e.status)) }))
    // 默认（全部）视图展示所有学习规则分类，含 0 条的空分类；筛选视图只留有匹配条目的分类。
    .filter((g) => !filtering || g.entries.length > 0)

  return (
    <div
      data-testid="learned-shadcn"
      className="flex h-full flex-col gap-2 overflow-auto p-1 text-foreground"
    >
      {actions.query.isLoading ?
        <div className="p-4 text-sm text-muted-foreground">loading…</div>
      : <>
          <div className="flex flex-wrap items-center gap-2 px-1">
            <div className="text-[11px] tracking-wider text-muted-foreground uppercase">反应式学习记录</div>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {FILTERS.map((f) => (
                <Button
                  key={f}
                  type="button"
                  variant={filter === f ? "secondary" : "ghost"}
                  size="xs"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABELS[f]}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void onExport()}
                disabled={exporting}
              >
                {exporting ? "导出中…" : "整体导出"}
              </Button>
            </div>
          </div>
          {groups.length === 0 ?
            <div className="px-2 text-xs text-muted-foreground">无记录</div>
          : null}
          {groups.map((g) => (
            <Card
              key={g.category}
              className="gap-0 py-0"
            >
              <CardHeader className="flex-row items-center gap-2 border-b border-border px-2 py-1.5">
                <CardTitle className="text-xs font-medium text-foreground">{CATEGORY_LABELS[g.category]}</CardTitle>
                <Badge
                  variant="outline"
                  className="text-[10px] text-muted-foreground"
                >
                  {g.entries.length} 条 · TTL {g.ttlMs === null ? "永不" : `${Math.round(g.ttlMs / 86_400_000)}d`}
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                {g.entries.length === 0 ?
                  <div className="px-2 py-1 text-[11px] text-muted-foreground">无记录</div>
                : g.entries.map((e) => (
                    <LearnedRow
                      key={`${e.key}|${e.value}`}
                      entry={e}
                      actions={actions}
                    />
                  ))
                }
              </CardContent>
            </Card>
          ))}
        </>
      }
    </div>
  )
}
