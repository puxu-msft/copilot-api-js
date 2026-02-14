import { computed, type Ref } from "vue"

import type { HistoryEntry, MessageContent } from "@/types"

export function useRewriteInfo(entry: Ref<HistoryEntry | null>) {
  const truncationPoint = computed(() => {
    const e = entry.value
    if (!e?.rewrites?.truncation) return -1
    const removed = e.rewrites.truncation.removedMessageCount
    if (!removed) return -1
    // truncationPoint is the index after which messages were kept
    // i.e. messages[0..truncationPoint-1] were truncated
    const mapping = e.rewrites.messageMapping
    if (mapping && mapping.length > 0) {
      // Find first mapped index — messages before this were removed
      return mapping[0]
    }
    return removed
  })

  function getRewrittenMessage(index: number): MessageContent | null {
    const e = entry.value
    if (!e?.rewrites?.rewrittenMessages || !e.rewrites.messageMapping) return null
    const mapping = e.rewrites.messageMapping
    const rewrittenIdx = mapping.indexOf(index)
    if (rewrittenIdx === -1) return null
    return e.rewrites.rewrittenMessages[rewrittenIdx] ?? null
  }

  function isMessageRewritten(index: number): boolean {
    const e = entry.value
    if (!e?.rewrites?.rewrittenMessages) return false
    const rewritten = getRewrittenMessage(index)
    if (!rewritten) return false
    const original = e.request.messages[index]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index access
    if (!original) return false
    return JSON.stringify(original.content) !== JSON.stringify(rewritten.content)
  }

  function isMessageTruncated(index: number): boolean {
    const tp = truncationPoint.value
    if (tp < 0) return false
    return index < tp
  }

  return { truncationPoint, getRewrittenMessage, isMessageRewritten, isMessageTruncated }
}
