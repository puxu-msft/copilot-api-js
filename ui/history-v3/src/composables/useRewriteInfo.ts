import { computed, type Ref } from "vue"

import type { HistoryEntry, MessageContent } from "../types"

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

  /** Pre-computed map: original message index → rewritten message (O(1) lookup) */
  const rewrittenMessageMap = computed(() => {
    const map = new Map<number, MessageContent>()
    const e = entry.value
    if (!e?.rewrites?.rewrittenMessages || !e.rewrites.messageMapping) return map
    const { rewrittenMessages, messageMapping } = e.rewrites
    for (let i = 0; i < messageMapping.length; i++) {
      const originalIdx = messageMapping[i]
      const rewritten = rewrittenMessages[i]
      if (rewritten) map.set(originalIdx, rewritten)
    }
    return map
  })

  /** Pre-computed set of indices whose content was actually modified by rewriting */
  const rewrittenIndices = computed(() => {
    const indices = new Set<number>()
    const e = entry.value
    if (!e?.rewrites?.rewrittenMessages) return indices
    const messages = e.request.messages ?? []
    for (const [idx, rewritten] of rewrittenMessageMap.value) {
      const original = messages[idx]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index access
      if (!original) continue
      // Quick reference check before expensive serialization
      if (
        original.content !== rewritten.content
        && JSON.stringify(original.content) !== JSON.stringify(rewritten.content)
      ) {
        indices.add(idx)
      }
    }
    return indices
  })

  function getRewrittenMessage(index: number): MessageContent | null {
    return rewrittenMessageMap.value.get(index) ?? null
  }

  function isMessageRewritten(index: number): boolean {
    return rewrittenIndices.value.has(index)
  }

  function isMessageTruncated(index: number): boolean {
    const tp = truncationPoint.value
    if (tp < 0) return false
    return index < tp
  }

  return { truncationPoint, getRewrittenMessage, isMessageRewritten, isMessageTruncated }
}
