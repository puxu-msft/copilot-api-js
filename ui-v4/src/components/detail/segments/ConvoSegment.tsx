import type { HistoryEntry } from "@/types"

import { SystemMessage } from "@/components/detail/blocks/SystemMessage"
import { ConversationView } from "@/components/detail/ConversationView"

export function ConvoSegment({ entry }: { entry: HistoryEntry }) {
  const system = entry.inboundRequest.system
  return (
    <div>
      {system ?
        <SystemMessage
          system={system}
          rewrittenSystem={entry.effectiveRequest?.system}
        />
      : null}
      <ConversationView messages={entry.inboundRequest.messages ?? []} />
    </div>
  )
}
