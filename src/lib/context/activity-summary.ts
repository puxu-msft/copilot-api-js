import type {
  //
  HistoryEntry,
  RequestTransport,
} from "~/lib/history/store"
import type { RequestContextSnapshot } from "~/lib/observability"

import { state } from "~/lib/state"

import type {
  //
  RequestContext,
  RequestState,
} from "./request"

export interface RequestActivitySnapshot {
  id: string
  endpoint: RequestContext["endpoint"]
  rawPath?: string
  state: RequestState
  active: boolean
  startTime: number
  durationMs: number
  lastUpdatedAt: number
  model?: string
  stream?: boolean
  attemptCount: number
  currentStrategy?: string
  queueWaitMs: number
  transport?: RequestTransport
}

export function isActiveRequestState(state: RequestState): boolean {
  return state !== "completed" && state !== "failed"
}

export function summarizeRequestContext(context: RequestContext): RequestActivitySnapshot {
  // Defensive fallbacks: the RequestContext interface declares these fields
  // as non-nullable, but consumers (tests, partial mocks, event payloads from
  // external sources) sometimes pass incomplete shapes. Keeping the fallbacks
  // makes this function robust without forcing every caller to comply with
  // the full type contract.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- see comment above */
  const state = context.state ?? "pending"

  return {
    id: context.id,
    endpoint: context.endpoint,
    ...(context.rawPath ? { rawPath: context.rawPath } : {}),
    state,
    active: isActiveRequestState(state),
    startTime: context.startTime,
    durationMs: context.durationMs ?? 0,
    lastUpdatedAt: Date.now(),
    model: context.originalRequest?.model,
    stream: context.originalRequest?.stream,
    attemptCount: context.attempts?.length ?? 0,
    currentStrategy: context.currentAttempt?.strategy,
    queueWaitMs: context.queueWaitMs ?? 0,
    ...(context.transport ? { transport: context.transport } : {}),
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}

export function buildHistoryActivityPatch(
  context: RequestContext,
): Pick<
  HistoryEntry,
  | "rawPath"
  | "startedAt"
  | "state"
  | "active"
  | "lastUpdatedAt"
  | "queueWaitMs"
  | "durationMs"
  | "transport"
  | "multiplier"
> {
  const snapshot = summarizeRequestContext(context)
  // Resolve the per-request billing multiplier from the SAME source as
  // snapshotWithSummary (state.modelIndex billing) so history records the
  // write-time price factor (e.g. 3 for opus). Lands on the persisted entry via
  // every updateEntry merge, so it survives to finalize even if the model is
  // later unregistered. Omitted when the model has no billing entry.
  const billing = context.resolvedModel ? state.modelIndex.get(context.resolvedModel)?.billing : undefined

  return {
    ...(snapshot.rawPath ? { rawPath: snapshot.rawPath } : {}),
    startedAt: snapshot.startTime,
    state: snapshot.state,
    active: snapshot.active,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    queueWaitMs: snapshot.queueWaitMs,
    durationMs: snapshot.durationMs,
    ...(snapshot.transport ? { transport: snapshot.transport } : {}),
    ...(billing?.multiplier !== undefined ? { multiplier: billing.multiplier } : {}),
  }
}

/**
 * Build a `RequestContextSnapshot` enriched with the front-end activity summary
 * for the lifecycle bus events (created / state_changed / context_updated /
 * completed / failed / aborted). Shared single source for both the producer
 * (`RequestContext` lifecycle publishes) and `RequestContextManager.create`
 * (the `request.created` publish) so the snapshot shape stays identical across
 * the two — no duplication (原则9).
 *
 * Pre-resolves the billing multiplier from `state.modelIndex` so ConsoleSink
 * doesn't have to (and so it stays correct if the model is unregistered
 * mid-flight). Reads only the public `RequestContext` getters.
 */
export function snapshotWithSummary(context: RequestContext): RequestContextSnapshot {
  const billing = context.resolvedModel ? state.modelIndex.get(context.resolvedModel)?.billing : undefined
  return {
    id: context.id,
    endpoint: context.endpoint,
    ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
    ...(context.rawPath !== undefined && { rawPath: context.rawPath }),
    method: context.method,
    path: context.path,
    ...(context.clientModel !== null && { clientModel: context.clientModel }),
    ...(context.resolvedModel !== null && { resolvedModel: context.resolvedModel }),
    state: context.state,
    startTime: context.startTime,
    queueWaitMs: context.queueWaitMs,
    ...(context.requestBodySize !== undefined && { requestBodySize: context.requestBodySize }),
    ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
    summary: summarizeRequestContext(context),
  }
}
