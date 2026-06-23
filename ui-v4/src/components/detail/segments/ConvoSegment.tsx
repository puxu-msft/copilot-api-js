import type { HistoryEntry } from "@/types"

import { ConversationView } from "@/components/detail/ConversationView"

export function ConvoSegment({ entry }: { entry: HistoryEntry }) {
  const system = entry.inboundRequest.system
  return (
    <div>
      {system ?
        <div className="mono mb-2 border-l-2 border-[var(--color-muted)] bg-[#161616] px-2 py-1 text-[13px] text-[#999]">
          <div className="text-[11px] uppercase tracking-wider">system</div>
          <div className="whitespace-pre-wrap break-words">{typeof system === "string" ? system : JSON.stringify(system, null, 2)}</div>
        </div>
      : null}
      <ConversationView messages={entry.inboundRequest.messages ?? []} />
    </div>
  )
}
