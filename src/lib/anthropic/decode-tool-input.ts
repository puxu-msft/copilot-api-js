/**
 * Tool input decoding for Anthropic responses.
 *
 * Decodes stringified-JSON fields in tool_use input back to structured form
 * on the wire forwarded to the client, while leaving history recording
 * (sseEvents + accumulated response) untouched. The actual field-level logic
 * is the zero-dependency `./decode-tool-input-core`; this module adapts it to
 * the two response shapes:
 *
 *   - Streaming: a stateful decoder that buffers a target tool_use block's
 *     `input_json_delta` fragments and rewrites them at `content_block_stop`.
 *   - Non-streaming: a helper that rewrites tool_use blocks in a full response.
 *
 * Both are no-ops unless a tool is selected by `DecodeToolInputConfig`, or — for the `AskUserQuestion` question/header backfill — by `ToolInputRewriteOptions`.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { StreamEvent } from "~/types/api/anthropic"

import type { AnthropicMessageResponse } from "./client"

import {
  //
  ASK_USER_QUESTION_TOOL,
  backfillAskUserQuestionHeaders,
  decodeToolUseInput,
  shouldDecodeToolInput,
  type DecodeToolInputConfig,
} from "./decode-tool-input-core"

/** Diagnostic emitted when a tool_use input selected for decode couldn't be decoded. */
export interface DecodeFailureInfo {
  /** Tool name whose input failed to decode. */
  tool: string
  /** The explicitly-configured field that stayed a string; undefined when the whole buffered input JSON failed to parse. */
  field?: string
  reason: "input-parse-failed" | "field-undecodable"
  /** Length of the offending string value (field-undecodable only). */
  valueLength?: number
}

/** Optional per-call rewrites layered on top of field decoding. */
export interface ToolInputRewriteOptions {
  /**
   * When true, backfill a missing `AskUserQuestion` `questions[].question` from its `header` on the forwarded wire (see `backfillAskUserQuestionHeaders`).
   * Runs after field decoding, so a stringified `questions` array is decoded first and then backfilled. Default false.
   */
  backfillAskUserQuestionHeader?: boolean
  /**
   * Called when a tool_use input the decoder buffered (selected for field decoding OR `AskUserQuestion` header backfill) couldn't be rewritten:
   *   - `input-parse-failed` — the whole buffered input JSON didn't parse (a COMPLETE block, not an abort). Fires for ANY buffered tool, including a backfill-only selection.
   *   - `field-undecodable` — an explicitly-configured decode field stayed a string. Fires ONLY for fields named in `cfg.fields[tool]` (never for `cfg.all`-discovered plain strings).
   * NEVER fires on the interrupted-stream `flush()` path (a normal client abort, not a failure).
   * Deduped per `(tool, field, reason)` within one decoder / one non-streaming response, so high-frequency malformed upstreams don't storm the log.
   * Note: covers the malformed / non-decodable variant only; a value that is valid JSON decodes successfully and never reports here.
   */
  onDecodeFailure?: (info: DecodeFailureInfo) => void
}

/** Build a per-scope deduping reporter (`() => {}` when no sink). Dedup key = `tool:field:reason`. */
function makeDecodeFailureReporter(onDecodeFailure?: (info: DecodeFailureInfo) => void): (info: DecodeFailureInfo) => void {
  if (!onDecodeFailure) return () => {}
  const reported = new Set<string>()
  return (info) => {
    const key = `${info.tool}:${info.field ?? "*"}:${info.reason}`
    if (reported.has(key)) return
    reported.add(key)
    onDecodeFailure(info)
  }
}

/**
 * Report each EXPLICITLY-configured decode field of `name` whose value in `result` is still a
 * string — i.e. the config declared it should be JSON but it didn't decode. No-op under `cfg.all`
 * (plain strings legitimately don't decode there) or when `name` has no explicit field list.
 */
function reportUndecodedFields(name: string, result: unknown, cfg: DecodeToolInputConfig, report: (info: DecodeFailureInfo) => void): void {
  if (cfg.all || !Object.hasOwn(cfg.fields, name)) return
  if (typeof result !== "object" || result === null || Array.isArray(result)) return
  const obj = result as Record<string, unknown>
  for (const field of cfg.fields[name]) {
    const v = obj[field]
    if (typeof v === "string") report({ tool: name, field, reason: "field-undecodable", valueLength: v.length })
  }
}

/**
 * Default `onDecodeFailure` sink: WARN + `recordFeature` so a non-decodable tool_use input is
 * never silent server-side (the client otherwise just rejects the tool call with no proxy trail).
 * Shared by every decode consumer (v4 S5 rewrite + web_search bypass) so the log shape can't drift.
 * Dedup is the decoder's job (per (tool,field,reason)); this only formats and emits.
 */
export function reportDecodeFailure(info: DecodeFailureInfo, ctx: RequestContext): void {
  const where = info.field === undefined ? "whole-input" : `field=${info.field}`
  const len = info.valueLength === undefined ? "" : ` len=${info.valueLength}`
  consola.warn(`[DECODE] tool_use input not decodable — tool=${info.tool} ${where} reason=${info.reason}${len} requestId=${ctx.id}`)
  ctx.recordFeature("tool-input-decode-failed", { tool: info.tool, field: info.field, reason: info.reason })
}

// ============================================================================
// Streaming decoder
// ============================================================================

/** Per-block buffer for a tool_use whose input is being collected for decode. */
interface BufferedToolUse {
  /** The tool name (drives field selection). */
  name: string
  /** Stream index of the block (used to rebuild the rewritten delta). */
  index: number
  /** Accumulated `partial_json` fragments, in order. */
  chunks: Array<string>
  /** Original delta SSE messages, kept for lossless fallback replay. */
  rawDeltas: Array<ServerSentEventMessage>
}

export interface ToolInputStreamDecoder {
  /**
   * Process one upstream SSE event. Returns the SSE messages to forward to the
   * client — usually `[raw]` (pass-through), `[]` (a suppressed delta being
   * buffered), or, at a buffered block's stop, the rewritten `[delta, stop]`.
   */
  processEvent: (parsed: StreamEvent | undefined, raw: ServerSentEventMessage) => Array<ServerSentEventMessage>
  /**
   * Emit any still-buffered original deltas for blocks that never received a
   * `content_block_stop` (interrupted / aborted stream). Prevents silently
   * dropping fragments the client would otherwise have received.
   */
  flush: () => Array<ServerSentEventMessage>
}

/** Build a single `content_block_delta` SSE message carrying the full decoded input JSON. */
function buildInputJsonDelta(template: ServerSentEventMessage | undefined, index: number, partialJson: string): ServerSentEventMessage {
  return {
    event: template?.event ?? "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    }),
    id: template?.id,
    retry: template?.retry,
  }
}

/**
 * Create a stateful decoder for an Anthropic SSE stream.
 *
 * Only `tool_use` blocks whose name is selected by `cfg` (or, when `opts.backfillAskUserQuestionHeader` is set, the `AskUserQuestion` block) are buffered; `server_tool_use` and every other block pass through untouched (the `block.type === "tool_use"` guard hard-excludes server tools even when `cfg.all` is set, avoiding conflicts with the server-tool filter).
 */
export function createToolInputStreamDecoder(cfg: DecodeToolInputConfig, opts: ToolInputRewriteOptions = {}): ToolInputStreamDecoder {
  const buffering = new Map<number, BufferedToolUse>()
  const backfill = opts.backfillAskUserQuestionHeader === true
  const report = makeDecodeFailureReporter(opts.onDecodeFailure)

  function finalize(buf: BufferedToolUse, stopRaw: ServerSentEventMessage): Array<ServerSentEventMessage> {
    const full = buf.chunks.join("")
    let inputObj: unknown
    try {
      inputObj = JSON.parse(full)
    } catch {
      // Upstream sent malformed / truncated JSON for a COMPLETE block — replay originals
      // losslessly, but surface the anomaly (this is content_block_stop, not an abort).
      report({ tool: buf.name, reason: "input-parse-failed" })
      return [...buf.rawDeltas, stopRaw]
    }

    // Decode stringified fields first, then backfill — so a stringified `questions` array is structured before its items are inspected.
    const decoded = decodeToolUseInput(buf.name, inputObj, cfg)
    const normalized = backfill ? backfillAskUserQuestionHeaders(buf.name, decoded) : decoded
    reportUndecodedFields(buf.name, normalized, cfg, report)
    if (normalized === inputObj) {
      // Nothing changed — zero-perturbation pass-through of the original bytes.
      return [...buf.rawDeltas, stopRaw]
    }

    const delta = buildInputJsonDelta(buf.rawDeltas[0], buf.index, JSON.stringify(normalized))
    return [delta, stopRaw]
  }

  return {
    processEvent(parsed, raw) {
      if (!parsed) return [raw]

      if (parsed.type === "content_block_start") {
        const block = parsed.content_block as { type: string; name?: string }
        // KNOWN LIMITATION — sanitize × wire-name (deferred-items §2 Step1 item2). `block.name` is the UPSTREAM WIRE name; decode (order 200) runs BEFORE name-restore (filter, order 300, which applies `toolNameMapper.toClient`).
        // `cfg.fields` / `ASK_USER_QUESTION_TOOL` are keyed by the CLIENT-ORIGINAL name, so when `sanitizeToolNames` rewrote a tool's name on the wire the upstream echoes the SANITIZED name and this match misses → decode silently skipped (and no [DECODE] log, since the tool was never selected).
        // NOT a real-world trigger today: the default config (`AskUserQuestion`) is a legal name `makeValidToolName` leaves unchanged. Fix when a tool with an illegal/too-long name lands in `decodeToolInputFields`: resolve `block.name` via `env.ctx.toolNameMapper.toClient(...)` before matching (thread a resolver through here + the non-streaming path + both decode-rewrite call sites).
        if (
          block.type === "tool_use"
          && block.name !== undefined
          && (shouldDecodeToolInput(block.name, cfg) || (backfill && block.name === ASK_USER_QUESTION_TOOL))
        ) {
          buffering.set(parsed.index, { name: block.name, index: parsed.index, chunks: [], rawDeltas: [] })
        }
        return [raw]
      }

      if (parsed.type === "content_block_delta") {
        const buf = buffering.get(parsed.index)
        const delta = parsed.delta as { type: string; partial_json?: string }
        if (buf && delta.type === "input_json_delta") {
          buf.chunks.push(delta.partial_json ?? "")
          buf.rawDeltas.push(raw)
          return []
        }
        return [raw]
      }

      if (parsed.type === "content_block_stop") {
        const buf = buffering.get(parsed.index)
        if (!buf) return [raw]
        buffering.delete(parsed.index)
        return finalize(buf, raw)
      }

      return [raw]
    },

    flush() {
      if (buffering.size === 0) return []
      const out: Array<ServerSentEventMessage> = []
      for (const buf of buffering.values()) out.push(...buf.rawDeltas)
      buffering.clear()
      return out
    },
  }
}

// ============================================================================
// Non-streaming helper
// ============================================================================

/**
 * Decode stringified-JSON fields in tool_use blocks of a non-streaming response, then optionally backfill `AskUserQuestion` headers (`opts.backfillAskUserQuestionHeader`).
 * Returns a new response object when any block changed, otherwise the original reference (immutable — never mutates `response`).
 */
export function decodeToolInputBlocksInResponse(
  response: AnthropicMessageResponse,
  cfg: DecodeToolInputConfig,
  opts: ToolInputRewriteOptions = {},
): AnthropicMessageResponse {
  const backfill = opts.backfillAskUserQuestionHeader === true
  const report = makeDecodeFailureReporter(opts.onDecodeFailure)
  const content = response.content.map((block) => {
    const b = block as { type?: string; name?: string; input?: unknown }
    if (b.type !== "tool_use" || b.name === undefined) return block
    const decoded = decodeToolUseInput(b.name, b.input, cfg)
    const normalized = backfill ? backfillAskUserQuestionHeaders(b.name, decoded) : decoded
    reportUndecodedFields(b.name, normalized, cfg, report)
    return normalized === b.input ? block : ({ ...b, input: normalized } as typeof block)
  })
  // Reference-equality check (not a closure flag — keeps the lint flow analysis
  // honest): every untouched block returns its original reference.
  const changed = content.some((block, i) => block !== response.content[i])
  return changed ? { ...response, content } : response
}
