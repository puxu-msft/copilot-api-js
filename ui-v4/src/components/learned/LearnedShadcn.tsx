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
import {
  //
  LEARNED_FILTER_LABELS,
  LEARNED_FILTERS,
  useLearnedView,
} from "@/hooks/useLearnedView"
import { CATEGORY_LABELS } from "@/lib/learned"

/**
 * fork B · Learned 页元素(shadcn 页壳,P7 完整版)。
 *
 * 与 legacy(`LearnedLegacy`)共用 A 层视图编排 hook `useLearnedView`(filter 状态 / matches / groups
 * 派生 / 整体导出,两树共用,不复制逻辑;legacy 保留内联冻结副本到 Z1)。本组件只负责呈现层:
 *  - 页壳用 shadcn `Card` + `Button` + `Badge` + 中性语义 token(`text-foreground`/`bg-card`/
 *    `text-muted-foreground`),圆角随 `--radius`。
 *  - 每个学习规则分类一张 `Card`(分类名 + 条数 + TTL),内嵌**中性化后的 B 内容体** `LearnedRow`
 *    (续约/失效/固定/删除 管理操作 + `StatusBadge`)逐字复用。
 * `data-testid=learned-shadcn` 供 fork B 互斥挂载守卫(loading 态亦保留,便于守卫恒可定位)。
 */
export function LearnedShadcn() {
  const {
    //
    actions,
    filter,
    setFilter,
    groups,
    exporting,
    onExport,
    isLoading,
  } = useLearnedView()

  return (
    <div
      data-testid="learned-shadcn"
      className="flex h-full flex-col gap-2 overflow-auto p-1 text-foreground"
    >
      {isLoading ?
        <div className="p-4 text-sm text-muted-foreground">loading…</div>
      : <>
          <div className="flex flex-wrap items-center gap-2 px-1">
            <div className="text-[11px] tracking-wider text-muted-foreground uppercase">反应式学习记录</div>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {LEARNED_FILTERS.map((f) => (
                <Button
                  key={f}
                  type="button"
                  variant={filter === f ? "secondary" : "ghost"}
                  size="xs"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {LEARNED_FILTER_LABELS[f]}
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
