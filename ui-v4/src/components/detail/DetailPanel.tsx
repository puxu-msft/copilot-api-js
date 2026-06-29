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
      <div className="flex min-h-0 flex-1">
        <DetailSubRail
          active={segment}
          onSelect={setSegment}
        />
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {segment === "Convo" ?
            <ConvoSegment entry={data} />
          : null}
          {segment === "Stages" ?
            <StagesSegment entry={data} />
          : null}
          {segment === "Response" ?
            <ResponseSegment entry={data} />
          : null}
          {segment === "SSE" ?
            <SseEventsSegment entry={data} />
          : null}
          {segment === "Headers" ?
            <HeadersSegment entry={data} />
          : null}
          {segment === "Meta" ?
            <MetaSegment entry={data} />
          : null}
        </div>
      </div>
    </div>
  )
}
