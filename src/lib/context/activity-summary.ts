import type {
  //
  HistoryEntry,
  RequestTransport,
} from "~/lib/history/store"

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
  | "attemptCount"
  | "currentStrategy"
  | "durationMs"
  | "transport"
> {
  const snapshot = summarizeRequestContext(context)

  return {
    ...(snapshot.rawPath ? { rawPath: snapshot.rawPath } : {}),
    startedAt: snapshot.startTime,
    state: snapshot.state,
    active: snapshot.active,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    queueWaitMs: snapshot.queueWaitMs,
    attemptCount: snapshot.attemptCount,
    currentStrategy: snapshot.currentStrategy,
    durationMs: snapshot.durationMs,
    ...(snapshot.transport ? { transport: snapshot.transport } : {}),
  }
}
