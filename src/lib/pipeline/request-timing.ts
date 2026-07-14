/**
 * 请求首包/时序埋点（spec docs/spec/2026-07-14-request-timing-instrumentation.md）。
 *
 * 上游 4 刻存 per-attempt（绝对 epoch instant）；客户端 3 刻存 entry（offset 相对
 * started_at）。捕获在各事件真实发生点单点采样，绕过帧 offset 折叠/双原点的不可靠。
 */

import { ENDPOINT } from "~/lib/models/endpoint"

import type { ClientFormat, UpstreamEndpoint } from "./envelope"

/** 上游侧 4 刻：绝对 epoch instant（Date.now()），存 per-attempt（`Attempt` 记录）。 */
export interface AttemptTiming {
  upstreamHeadersAt?: number
  upstreamMessageStartAt?: number
  upstreamFirstTokenAt?: number
  upstreamLastTokenAt?: number
}

/** 客户端侧 3 刻：offset ms 相对 entry.started_at，存 entry 列。 */
export interface ClientTiming {
  streamOpenMs?: number
  firstRealMs?: number
  bufferHoldStartMs?: number
}

/** 首写为准：仅当 target[key] 未设且 value 有效时写入（spec §3.4 once 语义）。 */
export function recordOnce<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  if (target[key] === undefined) target[key] = value
}

/** 末写为准：每次有效 value 覆盖（spec §3.4 latest 语义，upstreamLastTokenAt 用）。 */
export function recordLatest<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null) return
  target[key] = value
}

// ─── 首包谓词（spec §3.5）───
// 帧最小结构：driver loop-top raw 帧与 client-sink 帧都是 { event?, data? }。
// 上游侧谓词按 targetEndpoint（UpstreamEndpoint）分：/v1/messages→anthropic 帧（带 event 行），
// /responses|ws:/responses→responses 帧（带 event 行），/chat/completions→openai data-only（parse）。
// 客户端侧谓词按 clientFormat（ClientFormat）分。

export interface RawFrame {
  event?: string
  data?: string
}

function parseData(frame: RawFrame): { choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>; candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; functionCall?: unknown }> } }> } | undefined {
  if (!frame.data) return undefined
  try {
    return JSON.parse(frame.data) as ReturnType<typeof parseData>
  } catch {
    return undefined
  }
}

/** openai-cc chunk（data-only）首/内容判据：delta.content 非空字符串 或 有 tool_calls。 */
function openaiChunkHasContent(frame: RawFrame): boolean {
  const delta = parseData(frame)?.choices?.[0]?.delta
  if (!delta) return false
  return (typeof delta.content === "string" && delta.content.length > 0) || Array.isArray(delta.tool_calls)
}

/** gemini part（data-only）内容判据：某 part 含非空 text 或 functionCall。 */
function geminiPartHasContent(frame: RawFrame): boolean {
  const parts = parseData(frame)?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return false
  return parts.some((p) => (typeof p?.text === "string" && p.text.length > 0) || p?.functionCall != null)
}

/** 上游首个「承诺产出内容」信号（含 tool-first / reasoning-first）——按 targetEndpoint。 */
export function isFirstUpstreamContent(frame: RawFrame, targetEndpoint: UpstreamEndpoint): boolean {
  switch (targetEndpoint) {
    case ENDPOINT.MESSAGES:
      return frame.event === "content_block_start"
    case ENDPOINT.RESPONSES:
    case ENDPOINT.WS_RESPONSES:
      return frame.event === "response.output_item.added" || frame.event === "response.output_text.delta"
    case ENDPOINT.CHAT_COMPLETIONS:
      return openaiChunkHasContent(frame)
    default:
      return false
  }
}

/** 上游「任意内容帧」（last_token 用；比 first 宽）——按 targetEndpoint。 */
export function isUpstreamContentFrame(frame: RawFrame, targetEndpoint: UpstreamEndpoint): boolean {
  switch (targetEndpoint) {
    case ENDPOINT.MESSAGES:
      return frame.event === "content_block_delta" || frame.event === "content_block_start"
    case ENDPOINT.RESPONSES:
    case ENDPOINT.WS_RESPONSES:
      return typeof frame.event === "string" && frame.event.startsWith("response.output")
    case ENDPOINT.CHAT_COMPLETIONS:
      return openaiChunkHasContent(frame)
    default:
      return false
  }
}

/** 客户端可见的首个真实内容帧（非 message_start / 前奏 / synthetic）——按 clientFormat。 */
export function isClientContentFrame(frame: RawFrame, clientFormat: ClientFormat): boolean {
  switch (clientFormat) {
    case "anthropic":
      return frame.event === "content_block_delta"
    case "openai-responses":
      return frame.event === "response.output_text.delta"
    case "openai-cc":
      return openaiChunkHasContent(frame)
    case "gemini":
      return geminiPartHasContent(frame)
    default:
      return false
  }
}
