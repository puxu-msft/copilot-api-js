/**
 * Backend read-side projections over a `HistoryEntry` (RFC 2026-07-07
 * history-data-model-restructure).
 *
 * The response/model signals live on the per-attempt `upstreamRequest` /
 * `upstreamResponse` legs and the `_index.derived` projection. P4c-3 removed the
 * legacy top-level legs (`outboundResponse` / `outboundRequest` / `effectiveRequest`
 * / `sseEvents`) and the deprecated top-level scalars (`attemptCount` /
 * `currentStrategy` / `failureReason`). Entries now come from the V3 canonical
 * store's projection (`v3/projection.ts`), which produces the new client/upstream
 * legs directly; there is no legacy-row read adapter (V2 `entries_v2`/`entry_stages`
 * removed 2026-07-18), so every consumer reads the new legs uniformly.
 */

import type {
  //
  HistoryEntry,
  MessageContent,
  UsageData,
} from "./types"

import { accumulateForwardedContent } from "./accumulate-response"

/** Non-nullable per-attempt shape (the element type of `HistoryEntry.attempts`). */
type Attempt = NonNullable<HistoryEntry["attempts"]>[number]

/** The final (most recent) attempt of an entry, if any attempts are present. */
export function finalAttempt(entry: Pick<HistoryEntry, "attempts">): Attempt | undefined {
  return entry.attempts?.at(-1)
}

/** The final settled attempt's upstream request leg (new model), if present. */
export function finalUpstreamRequest(entry: Pick<HistoryEntry, "attempts">): Attempt["upstreamRequest"] | undefined {
  return finalAttempt(entry)?.upstreamRequest
}

/** The final settled attempt's upstream response leg (new model), if present. */
export function finalUpstreamResponse(entry: Pick<HistoryEntry, "attempts">): Attempt["upstreamResponse"] | undefined {
  return finalAttempt(entry)?.upstreamResponse
}

/** Resolved model name of the upstream response (final attempt's `upstreamResponse.model`). */
export function resolveResponseModel(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalUpstreamResponse(entry)?.model
}

/**
 * Whether the upstream response succeeded: `_index.derived.responseSuccess`
 * (recompute-only projection) → final attempt's `upstreamResponse.success`.
 * `false` is preserved (nullish coalescing).
 */
export function resolveResponseSuccess(entry: Pick<HistoryEntry, "attempts" | "_index">): boolean | undefined {
  return entry._index?.derived?.responseSuccess ?? finalUpstreamResponse(entry)?.success
}

/** Upstream response usage (final attempt's `upstreamResponse.usage`). */
export function resolveResponseUsage(entry: Pick<HistoryEntry, "attempts">): UsageData | undefined {
  return finalUpstreamResponse(entry)?.usage
}

/** Upstream response stop reason (final attempt's `upstreamResponse.stopReason`). */
export function resolveStopReason(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalUpstreamResponse(entry)?.stopReason
}

/**
 * Tool names invoked in a response `body`, in call order (NOT deduped — repeated
 * names reflect repeated calls, richest-data-flow). Handles both stored shapes:
 * OpenAI / Responses carry `tool_calls[].function.name`; Anthropic carries a
 * content-block array with `{ type: "tool_use" | "server_tool_use", name }`
 * members. Accepts `unknown` (the body is typed `unknown` on the context-side
 * `HistoryUpstreamResponseData`) and narrows at runtime; returns `[]` for any
 * body that invoked no tools.
 */
export function toolNamesFromResponseBody(body: unknown): Array<string> {
  if (typeof body !== "object" || body === null) return []
  const msg = body as { content?: unknown; tool_calls?: unknown }
  // OpenAI Chat Completions / Responses shape: explicit tool_calls array.
  if (Array.isArray(msg.tool_calls)) {
    return msg.tool_calls
      .map((tc) => (tc as { function?: { name?: unknown } }).function?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  }
  // Anthropic shape: tool_use / server_tool_use blocks inside the content array.
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block): block is { type: string; name: string } => {
        if (typeof block !== "object" || block === null) return false
        const b = block as { type?: unknown; name?: unknown }
        return (b.type === "tool_use" || b.type === "server_tool_use") && typeof b.name === "string"
      })
      .map((block) => block.name)
  }
  return []
}

/**
 * Tool names invoked in the final upstream response (via {@link toolNamesFromResponseBody}
 * over `upstreamResponse.body`). Returns `[]` when the response invoked no tools.
 */
export function resolveResponseToolNames(entry: Pick<HistoryEntry, "attempts">): Array<string> {
  return toolNamesFromResponseBody(finalUpstreamResponse(entry)?.body)
}

/**
 * Response-side "did the model actually think" dimension, derived from the
 * stored `thinking` / `redacted_thinking` blocks of a response body. The
 * client-side request `thinking.type` only says what we ASKED for; this says
 * what the upstream actually PRODUCED.
 */
export interface ResponseThinking {
  /** Count of `thinking` + `redacted_thinking` blocks. */
  blockCount: number
  /** Total plaintext chars across non-redacted `thinking` blocks (GHC encrypts opus thinking → often 0). */
  chars: number
  /** Any block carries a `signature` — proof of a legitimate (encrypted) thought. */
  hasSignature: boolean
  /**
   * Empty-plaintext poisoning: ANY single non-redacted `thinking` block that is
   * plaintext-empty AND signature-less (per-block, matching the canonical
   * sanitizer). A signed or nonempty sibling proves only itself legitimate — it
   * never absolves a poisoned block. Redacted blocks never count toward poisoning
   * (they are legitimately opaque). Calibrated against real 4141 data: GHC strips
   * opus plaintext but keeps the signature, so `thinking: ""` + signature is
   * NORMAL, not poisoned — a naive "empty ⇒ poisoned" rule would misreport 100%
   * of opus requests (see skill ghc-anthropic-upstream).
   */
  poisoned: boolean
}

/**
 * Derive {@link ResponseThinking} from a response `body`, or `undefined` when the
 * body carries no thinking blocks at all (dimension omitted). Accepts `unknown`
 * (the body is typed loosely) and narrows at runtime, mirroring
 * {@link toolNamesFromResponseBody}.
 */
export function responseThinkingFromBody(body: unknown): ResponseThinking | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const content = (body as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined

  let blockCount = 0
  let chars = 0
  let hasSignature = false
  // Poison verdict is PER-BLOCK, matching the canonical sanitizer's own
  // `textEmpty && sigEmpty` test (anthropic/sanitize/content-blocks.ts): ANY
  // single non-redacted thinking block that is plaintext-empty AND
  // signature-less is poison. A signed/nonempty sibling proves only ITSELF
  // legitimate — it never absolves another block. Aggregating ("all blocks bad")
  // would let one healthy block hide a genuinely poisoned one.
  let sawPoisoned = false

  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue
    const b = raw as { type?: unknown; thinking?: unknown; signature?: unknown }
    if (b.type === "redacted_thinking") {
      blockCount += 1
      continue
    }
    if (b.type !== "thinking") continue
    blockCount += 1
    const text = typeof b.thinking === "string" ? b.thinking : ""
    chars += text.length
    // Trim, mirroring the sanitizer's empty-field primitive: a whitespace-only
    // signature is not a real seal (and whitespace-only plaintext is not a thought).
    const signed = typeof b.signature === "string" && b.signature.trim().length > 0
    if (signed) hasSignature = true
    if (text.trim().length === 0 && !signed) sawPoisoned = true
  }

  if (blockCount === 0) return undefined
  return { blockCount, chars, hasSignature, poisoned: sawPoisoned }
}

/**
 * {@link ResponseThinking} for the final attempt's upstream response body, or
 * `undefined` when the response produced no thinking.
 */
export function resolveResponseThinking(entry: Pick<HistoryEntry, "attempts">): ResponseThinking | undefined {
  return responseThinkingFromBody(finalUpstreamResponse(entry)?.body)
}

/**
 * Response-side error message: the final attempt's `error` (the per-attempt error
 * home — `upstreamResponse` carries no error field). Callers that also want the
 * entry-level verdict append `?? entry._index?.derived?.failureReason` at the call site.
 */
export function resolveResponseError(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalAttempt(entry)?.error
}

/** Attempt count: `_index.derived.attemptCount` → live `attempts.length`. */
export function resolveAttemptCount(entry: Pick<HistoryEntry, "attempts" | "_index">): number | undefined {
  return entry._index?.derived?.attemptCount ?? entry.attempts?.length
}

/** Current strategy: `_index.derived.currentStrategy` → live final attempt's `strategy`. */
export function resolveCurrentStrategy(entry: Pick<HistoryEntry, "attempts" | "_index">): string | undefined {
  return entry._index?.derived?.currentStrategy ?? finalAttempt(entry)?.strategy
}

/** 截断到 ~100 字（与请求侧 `summarizeMessage` 上限一致）。 */
const RESPONSE_PREVIEW_MAX = 100

/**
 * 把一条 assistant 响应消息摘要成 `[ToolA, ToolB] text` —— 工具名在前(方括号逗号
 * 连接)、其后接首个非空文本。覆盖 string content(CC/Responses/Gemini) 与 array
 * content(Anthropic) 两种形态 + OpenAI `tool_calls[]`。仅文本→text；仅工具→[A,B]；
 * 皆无→""。与请求侧 text-优先的 `summarizeMessage` 相反(响应关注模型调了什么工具)。
 */
export function summarizeResponseMessage(msg: MessageContent): string {
  const tools: Array<string> = []
  let text = ""

  if (typeof msg.content === "string") {
    text = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if ((b.type === "tool_use" || b.type === "server_tool_use") && typeof b.name === "string") tools.push(b.name)
      else if (b.type === "text" && typeof b.text === "string" && !text && b.text.length > 0) text = b.text
    }
  }
  // OpenAI assistant tool_calls carrier (parallel to string content).
  for (const tc of msg.tool_calls ?? []) {
    if (tc.function.name) tools.push(tc.function.name)
  }

  const toolPart = tools.length > 0 ? `[${tools.join(", ")}]` : ""
  const combined = [toolPart, text].filter(Boolean).join(" ")
  return combined.length <= RESPONSE_PREVIEW_MAX ? combined : combined.slice(0, RESPONSE_PREVIEW_MAX)
}

/** 失败/无内容时的紧凑错误回退(承接 richest-data-flow：已在库的错误不丢)。 */
function errorFallback(entry: Pick<HistoryEntry, "attempts" | "_index">): string {
  const err = resolveResponseError(entry) ?? entry._index?.derived?.failureReason ?? finalUpstreamResponse(entry)?.rawBody?.split("\n")[0] ?? ""
  return err.length <= RESPONSE_PREVIEW_MAX ? err : err.slice(0, RESPONSE_PREVIEW_MAX)
}

/**
 * 响应内容预览：非流式取 `finalUpstream.body`(已归一 MessageContent)，流式经
 * `accumulateForwardedContent(clientResponse.sseEvents, endpoint)` 重建(客户端方言，
 * 与 endpoint 分派匹配 —— spec C1)，再 `summarizeResponseMessage`。无内容且失败→错误
 * 回退。在途(无 finalUpstream / 无 forwarded 帧 / 未失败)天然返回 ""。
 */
export function extractResponsePreviewText(entry: Pick<HistoryEntry, "attempts" | "clientResponse" | "endpoint" | "_index">): string {
  const body = finalUpstreamResponse(entry)?.body
  let assembled: MessageContent | undefined
  if (body && typeof body === "object" && "content" in body) {
    assembled = body
  } else {
    const frames = entry.clientResponse?.sseEvents
    if (frames && frames.length > 0) assembled = accumulateForwardedContent(frames, entry.endpoint)
  }
  const summary = assembled ? summarizeResponseMessage(assembled) : ""
  return summary || errorFallback(entry)
}
