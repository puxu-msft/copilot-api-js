import {
  //
  computed,
  type ComputedRef,
  type Ref,
} from "vue"

import type {
  //
  ContentBlock,
  HistoryEntry,
  MessageContent,
} from "@/types"

import {
  //
  isToolResultBlock,
  isToolUseBlock,
} from "@/utils/typeGuards"

import {
  //
  hasEffectiveLeg,
  resolveEffectiveMessages,
  resolveEffectiveSystem,
  resolveUpstreamResponse,
} from "./entry-legs"
import { useDetailViewState } from "./useDetailViewState"
import { usePipelineInfo } from "./usePipelineInfo"

export interface DetailOrchestration {
  // Pipeline info (delegated)
  truncationPoint: ComputedRef<number>
  hasRewrites: ComputedRef<boolean>
  rewriteSummary: ComputedRef<{ msgCount: number; sysRewritten: boolean; truncated: boolean; truncatedCount: number }>
  rewrittenIndexList: ComputedRef<Array<number>>
  getRewrittenMessage: (index: number) => MessageContent | null
  getSplitMessages: (index: number) => Array<MessageContent>
  isMessageRewritten: (index: number) => boolean
  isMessageTruncated: (index: number) => boolean

  // Derived from entry
  toolMaps: ComputedRef<{ resultMap: Record<string, ContentBlock>; nameMap: Record<string, string> }>
  filteredMessages: ComputedRef<Array<{ msg: MessageContent; originalIndex: number }>>
  responseMessage: ComputedRef<MessageContent | null>
  requestBadge: ComputedRef<string>
  rewrittenRequest: ComputedRef<unknown>

  // Functions
  hasMatchingBlockType: (msg: MessageContent, filterType: string) => boolean
  scrollToResult: (toolUseId: string) => void
  scrollToCall: (toolUseId: string) => void
}

function highlightBlock(el: HTMLElement): void {
  el.classList.remove("highlight-flash")
  void el.offsetWidth
  el.classList.add("highlight-flash")
}

/** Orchestration composable for DetailPanel — extracts data derivation and scroll logic */
export function useDetailOrchestration(entry: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>): DetailOrchestration {
  const detail = useDetailViewState()

  // Pipeline info
  const { truncationPoint, hasRewrites, rewriteSummary, rewrittenIndexList, getRewrittenMessage, getSplitMessages, isMessageRewritten, isMessageTruncated } =
    usePipelineInfo(entry)

  // Merged tool maps — single pass over messages
  const toolMaps = computed(() => {
    const resultMap: Record<string, ContentBlock> = {}
    const nameMap: Record<string, string> = {}
    if (!entry.value) return { resultMap, nameMap }
    for (const msg of entry.value.clientRequest?.messages ?? []) {
      // Anthropic format: content is ContentBlock[]
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (isToolResultBlock(block)) resultMap[block.tool_use_id] = block
          if (isToolUseBlock(block)) nameMap[block.id] = block.name
        }
      }
      // OpenAI format: tool_calls on message
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          nameMap[tc.id] = tc.function.name
        }
      }
      // OpenAI format: tool response (role: "tool" with tool_call_id)
      if (msg.role === "tool" && msg.tool_call_id) {
        resultMap[msg.tool_call_id] = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        } as ContentBlock
      }
    }
    return { resultMap, nameMap }
  })

  // Filter messages by role, with pre-computed original indices
  const filteredMessages = computed(() => {
    if (!entry.value) return []
    const messages = entry.value.clientRequest?.messages ?? []
    let indexed = messages.map((msg, i) => ({ msg, originalIndex: i }))
    if (detail.detailFilterRole) {
      indexed = indexed.filter(({ msg }) => msg.role === detail.detailFilterRole)
    }
    if (detail.showOnlyRewritten) {
      indexed = indexed.filter(({ originalIndex }) => isMessageRewritten(originalIndex))
    }
    return indexed
  })

  const responseMessage = computed<MessageContent | null>(() => {
    // New final-attempt `upstreamResponse.body` (legacy `outboundResponse.content` removed in P4c).
    const content = entry.value ? resolveUpstreamResponse(entry.value)?.content : null
    return content ?? null
  })

  const requestBadge = computed(() => {
    if (!entry.value) return ""
    return `${(entry.value.clientRequest?.messages ?? []).length} messages`
  })

  /** Rewritten request payload for the Raw modal */
  const rewrittenRequest = computed(() => {
    const e = entry.value
    if (!e || !hasEffectiveLeg(e)) return undefined
    const effMessages = resolveEffectiveMessages(e)
    const effSystem = resolveEffectiveSystem(e)
    if (!effMessages && effSystem === undefined) return undefined
    return {
      ...e.clientRequest,
      ...(effMessages && { messages: effMessages }),
      ...(effSystem !== undefined && { system: effSystem }),
    }
  })

  function hasMatchingBlockType(msg: MessageContent, filterType: string): boolean {
    if (typeof msg.content === "string") {
      if (filterType === "text") return true
      if (filterType === "tool_use" && msg.tool_calls?.length) return true
      return false
    }
    if (!Array.isArray(msg.content)) return false
    return msg.content.some((b) => b.type === filterType)
  }

  function scrollToResult(toolUseId: string): void {
    const el = document.querySelector<HTMLElement>(`#tool-result-${toolUseId}`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      highlightBlock(el)
    }
  }

  function scrollToCall(toolUseId: string): void {
    const el = document.querySelector<HTMLElement>(`#tool-use-${toolUseId}`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      highlightBlock(el)
    }
  }

  return {
    truncationPoint,
    hasRewrites,
    rewriteSummary,
    rewrittenIndexList,
    getRewrittenMessage,
    getSplitMessages,
    isMessageRewritten,
    isMessageTruncated,
    toolMaps,
    filteredMessages,
    responseMessage,
    requestBadge,
    rewrittenRequest,
    hasMatchingBlockType,
    scrollToResult,
    scrollToCall,
  }
}
