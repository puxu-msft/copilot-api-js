import {
  //
  computed,
  type Ref,
} from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "../types"

export function usePipelineInfo(entry: Ref<HistoryEntry | null>) {
  const truncationPoint = computed(() => {
    const e = entry.value
    if (!e?.pipelineInfo?.truncation) return -1
    const removed = e.pipelineInfo.truncation.removedMessageCount
    if (!removed) return -1
    // truncationPoint is the index after which messages were kept
    // i.e. messages[0..truncationPoint-1] were truncated
    const mapping = e.pipelineInfo.messageMapping
    if (mapping && mapping.length > 0) {
      // Find first mapped index — messages before this were removed
      return mapping[0]
    }
    return removed
  })

  /**
   * Pre-computed map: original message index → rewritten message(s).
   *
   * Usually 1:1, but `rewriteServerToolHistory` (downgrade) splits ONE original
   * assistant turn into TWO rewritten messages (assistant tool_use+text, then an
   * injected user tool_result) — both map to the same original index. The array
   * preserves rewritten order: `[0]` is the head (shares the original's role/
   * identity), `[1..]` are injected split-out messages.
   */
  const rewrittenMessageMap = computed(() => {
    const map = new Map<number, Array<MessageContent>>()
    const e = entry.value
    if (!e?.effectiveRequest?.messages || !e.pipelineInfo?.messageMapping) return map
    const rewrittenMessages = e.effectiveRequest.messages
    const messageMapping = e.pipelineInfo.messageMapping
    for (const [i, originalIdx] of messageMapping.entries()) {
      const bucket = map.get(originalIdx)
      if (bucket) bucket.push(rewrittenMessages[i])
      else map.set(originalIdx, [rewrittenMessages[i]])
    }
    return map
  })

  /** Pre-computed set of indices whose content was actually modified by rewriting */
  const rewrittenIndices = computed(() => {
    const indices = new Set<number>()
    const e = entry.value
    if (!e?.effectiveRequest?.messages) return indices
    const messages = e.inboundRequest.messages ?? []
    for (const [idx, rewrittenBucket] of rewrittenMessageMap.value) {
      const original = messages[idx]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array index access
      if (!original) continue
      // Compare against the head (the message that retains the original's
      // identity); a split also injects extra messages, which alone count as a
      // rewrite even when the head content is unchanged.
      const head = rewrittenBucket[0]
      const split = rewrittenBucket.length > 1
      if (split || (original.content !== head.content && JSON.stringify(original.content) !== JSON.stringify(head.content))) {
        indices.add(idx)
      }
    }
    return indices
  })

  /** Whether any rewriting occurred (messages or system prompt) */
  const hasRewrites = computed(() => {
    const e = entry.value
    if (!e?.effectiveRequest) return false
    return rewrittenIndices.value.size > 0 || Boolean(e.effectiveRequest.system)
  })

  /** Whether the system prompt was rewritten */
  const isSystemRewritten = computed(() => {
    const e = entry.value
    if (!e?.effectiveRequest?.system) return false
    const origSystem = e.inboundRequest.system
    const rwSystem = e.effectiveRequest.system
    if (!origSystem || !rwSystem) return Boolean(rwSystem)
    return JSON.stringify(origSystem) !== JSON.stringify(rwSystem)
  })

  /** Summary of rewrite statistics */
  const rewriteSummary = computed(() => {
    const msgCount = rewrittenIndices.value.size
    const sysRewritten = isSystemRewritten.value
    const truncated = truncationPoint.value >= 0
    const truncatedCount = truncated ? truncationPoint.value : 0
    return { msgCount, sysRewritten, truncated, truncatedCount }
  })

  /** Sorted array of rewritten message indices (for navigation) */
  const rewrittenIndexList = computed(() => {
    return [...rewrittenIndices.value].sort((a, b) => a - b)
  })

  /** The rewritten head for an original index (the message retaining its identity), or null. */
  function getRewrittenMessage(index: number): MessageContent | null {
    return rewrittenMessageMap.value.get(index)?.[0] ?? null
  }

  /**
   * Messages SPLIT OFF an original turn during rewrite (e.g. the user tool_result
   * a downgraded web_search turn produces). Empty for the common 1:1 case. The
   * Effective stage renders these right after the head so the full rewritten
   * shape is visible without leaving the detail view.
   */
  function getSplitMessages(index: number): Array<MessageContent> {
    const bucket = rewrittenMessageMap.value.get(index)
    return bucket && bucket.length > 1 ? bucket.slice(1) : []
  }

  function isMessageRewritten(index: number): boolean {
    return rewrittenIndices.value.has(index)
  }

  function isMessageTruncated(index: number): boolean {
    const tp = truncationPoint.value
    if (tp < 0) return false
    return index < tp
  }

  return {
    truncationPoint,
    hasRewrites,
    isSystemRewritten,
    rewriteSummary,
    rewrittenIndices,
    rewrittenIndexList,
    getRewrittenMessage,
    getSplitMessages,
    isMessageRewritten,
    isMessageTruncated,
  }
}
