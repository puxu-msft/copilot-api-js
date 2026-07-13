import { useState } from "react"

import type {
  //
  EntryStatus,
  LearnedSnapshot,
} from "@/types"

import { useLearned } from "@/hooks/useLearned"
import { api } from "@/lib/api"
import { triggerDownload } from "@/lib/export-entry"
import { badgeKind } from "@/lib/learned"

export type LearnedFilter = "all" | "active" | "expired" | "pinned"

/** 过滤按钮的取值顺序（`all` 首）。 */
export const LEARNED_FILTERS = ["all", "active", "expired", "pinned"] as const

/** 过滤按钮的显示标签（值不变，仅渲染文案本地化 —— 见 spec §4.5）。 */
export const LEARNED_FILTER_LABELS: Record<LearnedFilter, string> = {
  all: "全部",
  active: "active",
  expired: "已过期",
  pinned: "pinned",
}

/** 一个学习规则分类分组（`entries` 已按当前 filter 裁剪）。 */
export type LearnedCategoryView = LearnedSnapshot["categories"][number]

function matches(filter: LearnedFilter, status: EntryStatus): boolean {
  if (filter === "all") return true
  return badgeKind(status) === filter
}

/**
 * Learned 视图编排 hook(A 层,design-agnostic)。
 *
 * 抽出 legacy 与 shadcn 页元素**曾各持一份逐字副本**的有状态视图编排——filter 状态、`matches` 状态
 * 匹配、`groups` 派生(空分类在默认视图保留、筛选视图裁掉)、整体导出(`api.getBlob` + `triggerDownload`
 * + exporting 守卫)——为单一共享 primitive(对齐 P5 `groupByAgent` / P6 `useConfigEditor` 抽取范式)。
 * shadcn 侧 `LearnedShadcn` 导入之只做呈现;legacy `LearnedLegacy` 保留内联冻结副本到 Z1 删文件
 * (单向抽取,不碰冻结体)。
 *
 * 语义与 legacy 同构:默认（`all`）视图展示所有学习规则分类(含 0 条空分类,呈现分类名 + TTL + 无记录);
 * 筛选视图(active/expired/pinned)只留有匹配条目的分类,避免被空分类淹没。返回富上下文(`actions`
 * 全对象交呈现层给 `LearnedRow`,不预先过滤)。
 */
export function useLearnedView() {
  const actions = useLearned()
  const [filter, setFilter] = useState<LearnedFilter>("all")
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
  const groups: Array<LearnedCategoryView> = (snap?.categories ?? [])
    .map((g) => ({ ...g, entries: g.entries.filter((e) => matches(filter, e.status)) }))
    .filter((g) => !filtering || g.entries.length > 0)

  return {
    //
    actions,
    filter,
    setFilter,
    groups,
    exporting,
    onExport,
    isLoading: actions.query.isLoading,
  }
}
