import { useParams } from "react-router-dom"

import { DiagnosticBar } from "@/components/detail/DiagnosticBar"
import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"
import { HeadersSegment } from "@/components/detail/segments/HeadersSegment"
import { MetaSegment } from "@/components/detail/segments/MetaSegment"
import { ResponseSegment } from "@/components/detail/segments/ResponseSegment"
import { SseEventsSegment } from "@/components/detail/segments/SseEventsSegment"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"
import { SystemSegment } from "@/components/detail/segments/SystemSegment"
import { HorizontalTabs } from "@/components/ui/HorizontalTabs"
import { useEntry } from "@/hooks/useEntry"

/** 每段内容体的共享 class(与 legacy DetailPanel 同:填满 + 独立滚动)。 */
const SEG_CONTENT_CLASS = "min-h-0 flex-1 overflow-auto p-2 outline-none"

/**
 * fork B · Requests 详情内容面板 shadcn 侧(D-shell,决策 10):`HorizontalTabs`(`line` 变体)顶部
 * 水平 7 段 tab **替** legacy `DetailPanel` 的 `Tabs.Root orientation=vertical` + `DetailSubRail` 竖排。
 * DiagnosticBar(B)+ 7 段内容体(`segments/*`,B,已中性化)**逐字复用**,本文件只重写 tab 容器与朝向。
 * 数据源同 legacy(`useEntry`);roving tabindex / 键盘 nav / tab↔panel aria 由 Radix(经 shadcn Tabs)提供。
 * 本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function DetailPanelShadcn() {
  const { id } = useParams()
  const { data, isLoading, isError, error } = useEntry(id)

  if (!id) return <div className="p-4 text-sm text-muted-foreground">← 选一条请求看详情</div>
  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">loading {id}…</div>
  if (isError) return <div className="p-4 text-sm text-destructive">详情加载失败:{error instanceof Error ? error.message : "load failed"}</div>
  if (!data) return null

  // 7 段声明式映射(顺序 = legacy SEGMENTS);内容体逐字复用 B 段组件,零改动。
  const tabs = [
    { value: "Convo", label: "Convo", content: <ConvoSegment entry={data} /> },
    { value: "System", label: "System", content: <SystemSegment entry={data} /> },
    { value: "Stages", label: "Stages", content: <StagesSegment entry={data} /> },
    { value: "Response", label: "Response", content: <ResponseSegment entry={data} /> },
    { value: "SSE", label: "SSE", content: <SseEventsSegment entry={data} /> },
    { value: "Headers", label: "Headers", content: <HeadersSegment entry={data} /> },
    { value: "Meta", label: "Meta", content: <MetaSegment entry={data} /> },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DiagnosticBar entry={data} />
      <HorizontalTabs
        tabs={tabs}
        defaultValue="Convo"
        listVariant="line"
        listAriaLabel="Request detail segments"
        className="min-h-0 flex-1"
        listClassName="shrink-0 overflow-x-auto border-b border-border px-2 py-1"
        contentClassName={SEG_CONTENT_CLASS}
      />
    </div>
  )
}
