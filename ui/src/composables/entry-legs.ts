import {
  //
  finalAttempt,
  finalUpstreamRequest,
  finalUpstreamResponse,
  resolveResponseModel,
} from "~backend/lib/history/entry-view"

import type {
  //
  HistoryEntry,
  MessageContent,
  SseEventRecord,
  SystemBlock,
  UsageData,
} from "@/types"

/**
 * Frontend read-side resolvers over the RFC 2026-07-07 history data model. Each read targets the
 * new per-attempt `upstreamRequest`/`upstreamResponse` + per-entry `clientRequest`/`clientResponse`/
 * `model` legs (the legacy top-level `outboundResponse`/`inboundResponse`/`effectiveRequest`/
 * `outboundRequest`/`httpHeaders`/`sseEvents` legs were removed in P4c-3).
 *
 * The "which attempt / how to reach the new leg" logic lives in the backend `entry-view.ts`
 * (single shared primitive, re-used here via `~backend/*` — pure, SDK-free, rollup-safe). This
 * module is the single Vue read primitive: every Vue consumer routes through these resolvers.
 */

/** Legacy-shaped upstream (upstream → proxy) response view, so templates keep reading `.content`/`.stop_reason`. */
export interface UpstreamResponseView {
  success: boolean
  model: string
  usage?: UsageData
  stop_reason?: string
  error?: string
  status?: number
  content: MessageContent | null
  rawBody?: string
  sseEvents?: Array<SseEventRecord>
}

/** Upstream response: new final-attempt `upstreamResponse` (legacy `outboundResponse` removed in P4c). */
export function resolveUpstreamResponse(e: HistoryEntry): UpstreamResponseView | undefined {
  const up = finalUpstreamResponse(e)
  if (!up) return undefined
  return {
    success: up.success,
    model: up.model ?? resolveResponseModel(e) ?? "",
    usage: up.usage,
    // Field-name bridge: new leg uses `stopReason`/`body`; the response-side error home is the attempt.
    stop_reason: up.stopReason,
    error: finalAttempt(e)?.error,
    status: up.status,
    content: up.body ?? null,
    rawBody: up.rawBody,
    sseEvents: up.sseEvents,
  }
}

/** Upstream SSE frames: new final-attempt `upstreamResponse.sseEvents`. */
export function resolveUpstreamSse(e: HistoryEntry): Array<SseEventRecord> | undefined {
  return finalUpstreamResponse(e)?.sseEvents
}

/** Forwarded (proxy → client) content: new `clientResponse.body`. */
export function resolveForwardedContent(e: HistoryEntry): MessageContent | null | undefined {
  return e.clientResponse?.body as MessageContent | null | undefined
}

/** Forwarded (proxy → client) SSE frames: new `clientResponse.sseEvents`. */
export function resolveForwardedSse(e: HistoryEntry): Array<SseEventRecord> | undefined {
  return e.clientResponse?.sseEvents
}

/** Effective (post-rewrite) source messages: new final-attempt `effectiveSource.messages`. */
export function resolveEffectiveMessages(e: HistoryEntry): Array<MessageContent> | undefined {
  return finalAttempt(e)?.effectiveSource?.messages
}

/** Effective (post-rewrite) source system: new final-attempt `effectiveSource.system`. */
export function resolveEffectiveSystem(e: HistoryEntry): string | Array<SystemBlock> | undefined {
  return finalAttempt(e)?.effectiveSource?.system
}

/** Whether an effective (post-rewrite) source leg exists at all (new final-attempt leg). */
export function hasEffectiveLeg(e: HistoryEntry): boolean {
  return finalAttempt(e)?.effectiveSource !== undefined
}

/** Upstream wire request raw body: new final-attempt `upstreamRequest.body`. */
export function resolveWirePayload(e: HistoryEntry): unknown {
  return finalUpstreamRequest(e)?.body
}

/** Per-leg HTTP headers: new legs (client/upstream request+response). */
export function resolveHeaders(e: HistoryEntry): {
  inboundRequest?: Record<string, string>
  outboundRequest?: Record<string, string>
  outboundResponse?: Record<string, string>
  inboundResponse?: Record<string, string>
} {
  return {
    inboundRequest: e.clientRequest?.headers,
    outboundRequest: finalUpstreamRequest(e)?.headers,
    outboundResponse: finalUpstreamResponse(e)?.headers,
    inboundResponse: e.clientResponse?.headers,
  }
}

export { resolveAttemptCount, resolveCurrentStrategy, resolveResponseModel } from "~backend/lib/history/entry-view"
