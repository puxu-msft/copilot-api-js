/**
 * Anthropic upstream "refusal" recovery (response-side).
 *
 * Empirically, opus-4.8 (and peers) sometimes end a turn with
 * `stop_reason:"refusal"` after emitting ONLY a `thinking` block (empty text,
 * but a VALID non-empty signature) and NO `text`/`tool_use` — i.e. the client
 * (Claude Code) receives an empty/broken turn with nothing usable. Observed live
 * as `req_1782214935133_68`: a legit coding turn refused after 1058 thinking
 * tokens; the session then stalled (every subsequent user turn became "继续").
 *
 * This module recovers such turns by APPENDING a synthetic `text` block carrying
 * an informative message and rewriting `stop_reason: "refusal" → "end_turn"`
 * (clearing `stop_details`), so the client renders a coherent message instead of
 * a dead turn.
 *
 * WHY we keep the thinking block (rather than strip it): the block carries a
 * VALID signature, and Anthropic thinking signatures are self-contained (they
 * encrypt the thinking content itself, not context/position) — replaying it
 * verbatim is accepted by the upstream. It is therefore NOT the double-empty
 * (empty text AND empty signature) poison; stripping it would lose data and, on
 * the streaming path, would require buffering the entire thinking phase (a live-UX
 * regression). So we append, never strip.
 *
 * WHY append at the message_delta boundary (streaming): the refusal is only
 * knowable at `message_delta`, by which point the thinking frames are already
 * forwarded — there is no retroactive un-send. Appending a fresh text block then
 * + rewriting the delta needs no buffering and adds zero latency to the common
 * (non-refusal) path. The non-streaming path has the whole JSON in hand, so it
 * does the equivalent mutation directly.
 *
 * History fidelity: this only reshapes the forwarded/rendered response. The
 * driver samples the upstream-original frames (and feeds the accumulator) BEFORE
 * the S5 rewrite chain, so `sseEvents` and the recorded `stop_reason` keep the
 * genuine upstream `refusal` untouched.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type {
  //
  RawMessageDeltaEvent,
  StreamEvent,
} from "~/types/api/anthropic"

import { anthropicSseFrame } from "./sse-frame"

/**
 * The synthetic completion text shown to the client when a thinking-only refusal
 * is recovered. Fixed (not config-driven) — there is no real need for per-deployment
 * customization, and a config string would be speculative surface. Informative
 * (what happened), non-alarming (frames it as transient upstream policy), and
 * actionable (retry / rephrase / split / switch model) so both a human and a
 * Claude Code agent reading it can decide the next step.
 */
export const REFUSAL_RECOVERY_TEXT =
  "上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（仅有思考块）。这通常是上游安全策略对当前请求的瞬时拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后重试；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。"

/** A thinking-only refusal = `stop_reason:"refusal"` with no real (text/tool_use) content seen. */
export function isThinkingOnlyRefusal(stopReason: string | null | undefined, sawRealContent: boolean): boolean {
  return stopReason === "refusal" && !sawRealContent
}

/**
 * Build the synthetic `text` content-block frames (start → delta → stop) at `index`.
 * Each frame carries an `event:` line (= its `type`) via {@link anthropicSseFrame} —
 * a `data:`-only frame is dropped by the Anthropic SDK decoder (see sse-frame.ts).
 */
export function buildSyntheticTextFrames(index: number): Array<ServerSentEventMessage> {
  return [
    anthropicSseFrame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    anthropicSseFrame({ type: "content_block_delta", index, delta: { type: "text_delta", text: REFUSAL_RECOVERY_TEXT } }),
    anthropicSseFrame({ type: "content_block_stop", index }),
  ]
}

/**
 * Rewrite a refusal `message_delta` to a clean `end_turn` (immutably): flip
 * `stop_reason` and clear `stop_details` (refusal detail does not belong on an
 * end_turn). `usage` / `stop_sequence` / `container` are preserved verbatim.
 */
export function rewriteRefusalMessageDelta(parsed: RawMessageDeltaEvent): RawMessageDeltaEvent {
  return { ...parsed, delta: { ...parsed.delta, stop_reason: "end_turn", stop_details: null } }
}

/** A per-stream refusal recoverer: passthrough frames, synthesize at the refusal `message_delta`. */
export interface RefusalRecoverer {
  /** Process one upstream frame; returns the frame(s) to forward (always ≥1, never buffers). */
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
}

/** Options for {@link createRefusalRecoverer}. */
export interface RefusalRecovererDeps {
  /** Invoked once, when a refusal is first recovered (for feature telemetry / logging). */
  onRecover?: () => void
}

/**
 * Create a streaming refusal recoverer. It forwards every frame unchanged while
 * tracking the max content-block index and whether any real (text/tool_use) block
 * appeared; at a thinking-only refusal `message_delta` it emits a synthetic text
 * block (at `maxIndex + 1`) followed by the rewritten `end_turn` delta. No buffering.
 */
export function createRefusalRecoverer(deps: RefusalRecovererDeps = {}): RefusalRecoverer {
  let maxIndex = -1
  let sawRealContent = false
  let recovered = false

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      if (parsed.type === "content_block_start") {
        if (typeof parsed.index === "number") maxIndex = Math.max(maxIndex, parsed.index)
        // Only client-visible text/tool_use counts as "real content" — a refusal alongside
        // these is left untouched. server_tool_use never reaches here: server-tool-filter
        // (order 300) suppresses it before this rewrite (order 400), so "thinking-only" holds.
        const blockType = (parsed.content_block as { type?: string }).type
        if (blockType === "text" || blockType === "tool_use") sawRealContent = true
        return [raw]
      }

      if ((parsed.type === "content_block_delta" || parsed.type === "content_block_stop") && typeof parsed.index === "number") {
        maxIndex = Math.max(maxIndex, parsed.index)
        return [raw]
      }

      if (parsed.type === "message_delta") {
        if (!isThinkingOnlyRefusal(parsed.delta.stop_reason, sawRealContent)) return [raw]
        if (!recovered) {
          recovered = true
          deps.onRecover?.()
        }
        const synthFrames = buildSyntheticTextFrames(maxIndex + 1)
        const rewritten: ServerSentEventMessage = { ...raw, data: JSON.stringify(rewriteRefusalMessageDelta(parsed)) }
        return [...synthFrames, rewritten]
      }

      return [raw]
    },
  }
}

/**
 * Non-streaming: recover a thinking-only refusal on the whole response. Whole JSON
 * in hand → no timing constraint. Appends the synthetic text block and flips
 * `stop_reason` to `end_turn` (clearing `stop_details`). Returns the response
 * unchanged when it is not a thinking-only refusal (real content present, or
 * stop_reason ≠ refusal).
 */
export function recoverRefusalInResponse(response: AnthropicMessageResponse): AnthropicMessageResponse {
  if (response.stop_reason !== "refusal") return response
  const content = response.content as unknown as Array<Record<string, unknown> & { type: string }>
  if (content.some((b) => b.type === "text" || b.type === "tool_use")) return response

  const recovered = [...content, { type: "text", text: REFUSAL_RECOVERY_TEXT }]
  return { ...response, stop_reason: "end_turn", stop_details: null, content: recovered as unknown as AnthropicMessageResponse["content"] }
}
