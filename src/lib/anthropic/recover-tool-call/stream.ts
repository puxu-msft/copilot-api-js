import type { ServerSentEventMessage } from "fetch-event-stream"

import type { StreamEvent } from "~/types/api/anthropic"

import { isEmptyAnthropicStreamDelta } from "../empty-stream-delta"
import { anthropicSseFrame } from "../sse-frame"
import {
  //
  findDowngradeMarkPos,
  isInvokeTerminal,
  isResidueWhitespaceAdjacent,
  recoverDowngradeTail,
  synthesizeToolUseId,
  type ToolParamTypes,
} from "./core"

export interface RecoverStreamDeps {
  enabled: boolean
  /** wire 工具名（P4 命中）。 */
  toolNames: ReadonlySet<string>
  toolSchemas: Map<string, ToolParamTypes>
}

export interface ToolCallTextRecoverer {
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
  flush: () => Array<ServerSentEventMessage>
}

// Lookahead 下限。真正窗口在构造时按最长工具名动态放大（见 markLookahead）——检测发生在
// 完整 `<invoke name="X">`（跨度 16+len(X)），固定窗口对长 MCP 工具名会泄漏 call/半截开标签。
const MARK_LOOKAHEAD_FLOOR = 32

// Synthesized frames must carry the `event:` line (= their `type`) or the Anthropic
// SDK decoder drops them — see anthropic/sse-frame.ts. Frames replayed from buffered
// upstream (rollback / passthrough) already keep their original event line.
function sse(obj: Record<string, unknown>): ServerSentEventMessage {
  return anthropicSseFrame(obj as { type: string } & Record<string, unknown>)
}

/**
 * 流式恢复器：把上游 tool-call 文本降级重建为 tool_use。
 *
 * 自包含 SSE transform：依赖构造期注入，不读 handler 全局，可独立喂事件序列单测，也可
 * 作为 transform stage 接入未来 v4 管线。**假设运行在 serverToolFilter 之前**——发
 * wire-name tool_use、用上游 index 空间（maxSeen+1+k），name 还原 + index densify 由
 * 下游 serverToolFilter 负责。
 *
 * CANDIDATE/COMMIT 两阶段：门控需 message_delta 的 stop_reason + P3，早于发帧不可知，故
 * text content_block_stop 时只持帧（CANDIDATE），message_delta 才发合成帧或回退（COMMIT）。
 */
export function createToolCallTextRecoverer(deps: RecoverStreamDeps): ToolCallTextRecoverer {
  // Lookahead 须 ≥ 从残留 token 到完整 `<invoke name="X">` 的最大跨度，否则逐字流式下
  // markPos 检出前会把 call/半截开标签转发出去。跨度 = len(残留 `<function_calls>`=16)
  // + 空白余量 + len(`<invoke name="">`=16) + 最长工具名。
  const maxToolNameLen = deps.toolNames.size > 0 ? Math.max(...Array.from(deps.toolNames, (n) => n.length)) : 0
  const markLookahead = Math.max(MARK_LOOKAHEAD_FLOOR, 48 + maxToolNameLen)

  let maxUpstreamIndexSeen = -1
  let sawToolUseBlock = false
  let inTextBlock = false
  let textIndex = -1
  let mode: "PASSTHROUGH" | "BUFFERING" = "PASSTHROUGH"
  let seen = ""
  let forwardedLen = 0
  let bufferedFrames: Array<ServerSentEventMessage> = []
  let markPos = -1
  let candidate: { stopFrame: ServerSentEventMessage; bufferedFrames: Array<ServerSentEventMessage>; tail: string; textIndex: number } | null = null

  function resetBlock() {
    inTextBlock = false
    textIndex = -1
    mode = "PASSTHROUGH"
    seen = ""
    forwardedLen = 0
    bufferedFrames = []
    markPos = -1
  }

  function emitCommit(): Array<ServerSentEventMessage> {
    if (!candidate) return []
    const result = recoverDowngradeTail(candidate.tail, deps.toolSchemas)
    const out: Array<ServerSentEventMessage> = [candidate.stopFrame]
    let seq = 0
    let k = 1
    for (const rb of result.blocks) {
      if (rb.type !== "tool_use") continue
      const idx = maxUpstreamIndexSeen + k++
      const id = synthesizeToolUseId(rb.name, seq++, candidate.tail)
      out.push(
        sse({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id, name: rb.name, input: {} } }),
        sse({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(rb.input) } }),
        sse({ type: "content_block_stop", index: idx }),
      )
    }
    return out
  }

  function rollbackCandidate(): Array<ServerSentEventMessage> {
    if (!candidate) return []
    const out = [candidate.stopFrame, ...candidate.bufferedFrames]
    candidate = null
    return out
  }

  function commitTier(stopReason: string | undefined, tail: string): "A" | "B" | null {
    if (stopReason === "tool_use" && !sawToolUseBlock) return "A"
    if (stopReason === "end_turn" && isResidueWhitespaceAdjacent(tail) && isInvokeTerminal(tail)) return "B"
    return null
  }

  return {
    processEvent(parsed, raw) {
      if (!deps.enabled || !parsed) return [raw]

      // message_start = clean per-message slate. One Anthropic stream carries exactly
      // one message, so this resets message-level state (sawToolUseBlock /
      // maxUpstreamIndexSeen / any stale candidate) — keeping each message independent
      // and making the per-message invariant self-enforcing for instance reuse.
      if (parsed.type === "message_start") {
        maxUpstreamIndexSeen = -1
        sawToolUseBlock = false
        candidate = null
        resetBlock()
        return [raw]
      }

      if (
        (parsed.type === "content_block_start" || parsed.type === "content_block_delta" || parsed.type === "content_block_stop")
        && typeof parsed.index === "number"
      ) {
        maxUpstreamIndexSeen = Math.max(maxUpstreamIndexSeen, parsed.index)
      }

      if (candidate) {
        if (parsed.type === "content_block_start") {
          const rb = rollbackCandidate()
          const blockType = (parsed.content_block as { type?: string }).type
          if (blockType === "tool_use") sawToolUseBlock = true
          return [...rb, raw]
        }
        if (parsed.type === "message_delta") {
          const stopReason = (parsed.delta as { stop_reason?: string }).stop_reason
          const tier = commitTier(stopReason, candidate.tail)
          const result = tier ? recoverDowngradeTail(candidate.tail, deps.toolSchemas) : { recovered: false, blocks: [] }
          if (tier && result.recovered) {
            const synth = emitCommit()
            candidate = null
            const md =
              stopReason === "end_turn" ?
                sse({
                  ...(parsed as unknown as Record<string, unknown>),
                  delta: { ...(parsed.delta as unknown as Record<string, unknown>), stop_reason: "tool_use" },
                })
              : raw
            return [...synth, md]
          }
          return [...rollbackCandidate(), raw]
        }
        return [...rollbackCandidate(), raw]
      }

      if (parsed.type === "content_block_start") {
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "tool_use") sawToolUseBlock = true
        if (blockType === "text") {
          resetBlock()
          inTextBlock = true
          textIndex = parsed.index
          return [raw]
        }
        return [raw]
      }

      if (inTextBlock && parsed.type === "content_block_delta" && parsed.index === textIndex) {
        const delta = parsed.delta as { type?: string; text?: string }
        if (delta.type !== "text_delta" || typeof delta.text !== "string") return [raw]
        // Empty deltas carry no downgraded tool-call text, so the lookahead has nothing to inspect.
        // They are nevertheless protocol-significant keepalive chunks for Claude Code's idle
        // watchdog and must reach the client immediately rather than disappear into `seen`.
        if (isEmptyAnthropicStreamDelta(parsed)) return [raw]
        seen += delta.text
        if (mode === "BUFFERING") {
          bufferedFrames.push(raw)
          return []
        }
        const pos = findDowngradeMarkPos(seen, deps.toolNames)
        if (pos >= 0) {
          markPos = pos
          mode = "BUFFERING"
          const toForward = seen.slice(forwardedLen, markPos)
          forwardedLen = markPos
          bufferedFrames.push(raw)
          return toForward.length > 0 ? [sse({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: toForward } })] : []
        }
        const safeEnd = Math.max(forwardedLen, seen.length - markLookahead)
        if (safeEnd > forwardedLen) {
          const chunk = seen.slice(forwardedLen, safeEnd)
          forwardedLen = safeEnd
          return [sse({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: chunk } })]
        }
        return []
      }

      if (inTextBlock && parsed.type === "content_block_stop" && parsed.index === textIndex) {
        if (mode === "BUFFERING" && markPos >= 0) {
          const tail = seen.slice(markPos)
          const pre = recoverDowngradeTail(tail, deps.toolSchemas)
          if (pre.recovered) {
            candidate = { stopFrame: raw, bufferedFrames: bufferedFrames.slice(), tail, textIndex }
            resetBlock()
            return []
          }
          const flushTail = seen.slice(forwardedLen)
          const idx = parsed.index
          resetBlock()
          const out: Array<ServerSentEventMessage> = []
          if (flushTail.length > 0) out.push(sse({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: flushTail } }))
          return [...out, raw]
        }
        const flushTail = seen.slice(forwardedLen)
        const idx = parsed.index
        resetBlock()
        const out: Array<ServerSentEventMessage> = []
        if (flushTail.length > 0) out.push(sse({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: flushTail } }))
        return [...out, raw]
      }

      return [raw]
    },

    flush() {
      if (candidate) {
        const out = [candidate.stopFrame, ...candidate.bufferedFrames]
        candidate = null
        return out
      }
      if (mode === "BUFFERING") {
        const out = bufferedFrames.slice()
        resetBlock()
        return out
      }
      if (inTextBlock && forwardedLen < seen.length) {
        const tail = seen.slice(forwardedLen)
        const idx = textIndex
        resetBlock()
        return [sse({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: tail } })]
      }
      return []
    },
  }
}
