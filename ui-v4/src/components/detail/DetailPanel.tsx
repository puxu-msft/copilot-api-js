import { Tabs } from "radix-ui"
import { useState } from "react"
import { useParams } from "react-router-dom"

import {
  //
  DetailSubRail,
  type SegmentName,
} from "@/components/detail/DetailSubRail"
import { DiagnosticBar } from "@/components/detail/DiagnosticBar"
import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"
import { HeadersSegment } from "@/components/detail/segments/HeadersSegment"
import { MetaSegment } from "@/components/detail/segments/MetaSegment"
import { ResponseSegment } from "@/components/detail/segments/ResponseSegment"
import { SseEventsSegment } from "@/components/detail/segments/SseEventsSegment"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"
import { useEntry } from "@/hooks/useEntry"

/** Shared class for each segment's content pane. */
const SEG_CONTENT_CLASS = "min-h-0 flex-1 overflow-auto p-2 outline-none"

export function DetailPanel() {
  const { id } = useParams()
  const { data, isLoading, isError, error } = useEntry(id)
  const [segment, setSegment] = useState<SegmentName>("Convo")

  if (!id) return <div className="mono p-4 text-[#666]">← 选一条请求看详情</div>
  if (isLoading) return <div className="mono p-4 text-[#888]">loading {id}…</div>
  if (isError) return <div className="mono p-4 text-[var(--color-fail)]">详情加载失败:{error instanceof Error ? error.message : "load failed"}</div>
  if (!data) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DiagnosticBar entry={data} />
      <Tabs.Root
        value={segment}
        onValueChange={(v) => setSegment(v as SegmentName)}
        orientation="vertical"
        className="flex min-h-0 flex-1"
      >
        <DetailSubRail />
        <Tabs.Content
          value="Convo"
          className={SEG_CONTENT_CLASS}
        >
          <ConvoSegment entry={data} />
        </Tabs.Content>
        <Tabs.Content
          value="Stages"
          className={SEG_CONTENT_CLASS}
        >
          <StagesSegment entry={data} />
        </Tabs.Content>
        <Tabs.Content
          value="Response"
          className={SEG_CONTENT_CLASS}
        >
          <ResponseSegment entry={data} />
        </Tabs.Content>
        <Tabs.Content
          value="SSE"
          className={SEG_CONTENT_CLASS}
        >
          <SseEventsSegment entry={data} />
        </Tabs.Content>
        <Tabs.Content
          value="Headers"
          className={SEG_CONTENT_CLASS}
        >
          <HeadersSegment entry={data} />
        </Tabs.Content>
        <Tabs.Content
          value="Meta"
          className={SEG_CONTENT_CLASS}
        >
          <MetaSegment entry={data} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
