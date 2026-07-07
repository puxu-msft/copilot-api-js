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
 * Frontend read-side resolvers over the RFC 2026-07-07 history data model. Each read is
 * "new leg ?? legacy top-level": the new per-attempt `upstreamRequest`/`upstreamResponse` +
 * per-entry `clientRequest`/`clientResponse`/`model` legs win for live entries (dual-written by
 * the P2.x producer), and a legacy-only row (pre-restructure DB row) falls back byte-identically.
 *
 * The "which attempt / how to reach the new leg" logic lives in the backend `entry-view.ts`
 * (single shared primitive, re-used here via `~backend/*` — pure, SDK-free, rollup-safe). The
 * per-field legacy fallback is centralized HERE so P4c's legacy-leg removal is a one-file edit
 * for this frontend: drop the `?? e.outboundResponse…`/`?? e.inboundResponse…`/`?? e.effectiveRequest…`
 * arms below and every Vue consumer is migrated at once.
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

/** Upstream response: new final-attempt `upstreamResponse` ?? legacy `outboundResponse` (P4c: drop legacy arm). */
export function resolveUpstreamResponse(e: HistoryEntry): UpstreamResponseView | undefined {
  const up = finalUpstreamResponse(e)
  if (!up) return e.outboundResponse
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

/** Upstream SSE frames: new final-attempt `upstreamResponse.sseEvents` ?? legacy top-level `sseEvents`. */
export function resolveUpstreamSse(e: HistoryEntry): Array<SseEventRecord> | undefined {
  return finalUpstreamResponse(e)?.sseEvents ?? e.sseEvents
}

/** Forwarded (proxy → client) content: new `clientResponse.body` ?? legacy `inboundResponse.content`. */
export function resolveForwardedContent(e: HistoryEntry): MessageContent | null | undefined {
  return (e.clientResponse?.body ?? e.inboundResponse?.content) as MessageContent | null | undefined
}

/** Forwarded (proxy → client) SSE frames: new `clientResponse.sseEvents` ?? legacy `inboundResponse.sseEvents`. */
export function resolveForwardedSse(e: HistoryEntry): Array<SseEventRecord> | undefined {
  return e.clientResponse?.sseEvents ?? e.inboundResponse?.sseEvents
}

/** Effective (post-rewrite) source messages: new final-attempt `effectiveSource.messages` ?? legacy `effectiveRequest.messages`. */
export function resolveEffectiveMessages(e: HistoryEntry): Array<MessageContent> | undefined {
  return finalAttempt(e)?.effectiveSource?.messages ?? e.effectiveRequest?.messages
}

/** Effective (post-rewrite) source system: new final-attempt `effectiveSource.system` ?? legacy `effectiveRequest.system`. */
export function resolveEffectiveSystem(e: HistoryEntry): string | Array<SystemBlock> | undefined {
  return finalAttempt(e)?.effectiveSource?.system ?? e.effectiveRequest?.system
}

/** Whether an effective (post-rewrite) source leg exists at all (new final-attempt leg ?? legacy top-level). */
export function hasEffectiveLeg(e: HistoryEntry): boolean {
  return (finalAttempt(e)?.effectiveSource ?? e.effectiveRequest) !== undefined
}

/** Upstream wire request raw body: new final-attempt `upstreamRequest.body` ?? legacy `outboundRequest.payload`. */
export function resolveWirePayload(e: HistoryEntry): unknown {
  return finalUpstreamRequest(e)?.body ?? e.outboundRequest?.payload
}

/** Per-leg HTTP headers: new legs (client/upstream request+response) ?? legacy `httpHeaders.*` (P4c: drop legacy arms). */
export function resolveHeaders(e: HistoryEntry): {
  inboundRequest?: Record<string, string>
  outboundRequest?: Record<string, string>
  outboundResponse?: Record<string, string>
  inboundResponse?: Record<string, string>
} {
  return {
    inboundRequest: e.clientRequest?.headers ?? e.httpHeaders?.inboundRequest,
    outboundRequest: finalUpstreamRequest(e)?.headers ?? e.httpHeaders?.outboundRequest,
    outboundResponse: finalUpstreamResponse(e)?.headers ?? e.httpHeaders?.outboundResponse,
    inboundResponse: e.clientResponse?.headers ?? e.httpHeaders?.inboundResponse,
  }
}

export { resolveAttemptCount, resolveCurrentStrategy, resolveResponseModel } from "~backend/lib/history/entry-view"
