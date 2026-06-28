/**
 * History sink — translates `request.*` lifecycle events into SQLite writes
 * via the existing `lib/history/*` API, and is the upstream of `history.*`
 * events (entry persistence, stats deltas, cleared/session_deleted) which
 * `lib/history/entries.ts` and `sessions.ts` publish via the injected
 * `historyState.publisher`.
 *
 * Replaces the `handleHistoryEvent` consumer in `lib/context/consumers.ts`
 * (deleted in commit 3b).
 *
 * Subscribes to:
 * - `request.created` — no-op (waits for originalRequest)
 * - `request.context_updated` — synchronous mirror of the legacy `updated`
 *   field branch; inserts/updates the in-flight entry and persists each
 *   stage (eager head row at `originalRequest`, per-attempt bodies at
 *   `attempts`, head status on state changes).
 * - `request.state_changed` — head-row state update + persistEntryStatus.
 * - `request.completed`/`failed`/`aborted` — terminal write + finalizeEntry.
 *
 * Does NOT subscribe to `history.*` (it would receive its own emissions
 * via entries.ts — pointless and noisy). The subscription filter at
 * construction time strips them.
 */

import type {
  //
  HistoryEntryData,
  RequestContext,
  ResponseData,
} from "~/lib/context/types"
import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history"

import { buildHistoryActivityPatch } from "~/lib/context/activity-summary"
import {
  //
  legFromEffective,
  legFromWire,
} from "~/lib/context/request"
import {
  //
  STAGE,
  type StagePayload,
} from "~/lib/history/sqlite/serialize"
import {
  //
  finalizeEntry,
  insertEntry,
  isHistoryEnabled,
  persistEntryEager,
  persistEntryStages,
  persistEntryStatus,
  updateEntry,
} from "~/lib/history/store"
import { getProcessIdentity } from "~/lib/process-identity"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
  ScopedPublisher,
} from "../index"

export interface HistorySinkOptions {
  /**
   * Scoped publisher for `history.*` events. NOT consumed by HistorySink
   * itself — it's the publisher reference HistorySink hands off to
   * `historyState.publisher` (set via `setHistoryPublisher` at start.ts).
   * The actual `history.*` emissions originate in `lib/history/entries.ts`
   * / `sessions.ts` after each SQLite write completes.
   *
   * Optional in tests: when omitted, history writes still happen but no
   * `history.*` bus events fire (so WsSink doesn't broadcast).
   */
  publisher?: ScopedPublisher<"history">
}

export class HistorySink {
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus, _options?: HistorySinkOptions) {
    this.unsubscribe = bus.subscribe(
      (event) => {
        this.handle(event)
      },
      // Filter at subscribe time so we don't even materialize history.* /
      // system.* events. HistorySink subscribes only to request.* and does
      // NOT see its own emitted history.* events (avoids noisy default-case).
      (event) => event.kind.startsWith("request."),
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  private handle(event: ObservabilityEvent): void {
    if (!isHistoryEnabled()) return

    switch (event.kind) {
      case "request.created": {
        // Don't insert yet — wait for originalRequest. (Mirrors the
        // consumers.ts handleHistoryEvent "created" branch.)
        return
      }
      case "request.context_updated": {
        this.onContextUpdated(event.contextRef, event.field)
        return
      }
      case "request.state_changed": {
        // Mirror the legacy consumers.ts state_changed branch — apply the
        // full activity patch (rawPath/startedAt/state/active/lastUpdatedAt/
        // queueWaitMs/attemptCount/currentStrategy/durationMs/transport)
        // so a head-row read during a long-running request shows up-to-date
        // duration / attempt count, not the stale insert-time values.
        const s = event.ctx.summary
        if (s) {
          updateEntry(event.ctx.id, {
            ...(s.rawPath ? { rawPath: s.rawPath } : {}),
            startedAt: s.startTime,
            state: s.state,
            active: s.active,
            lastUpdatedAt: s.lastUpdatedAt,
            queueWaitMs: s.queueWaitMs,
            attemptCount: s.attemptCount,
            currentStrategy: s.currentStrategy,
            durationMs: s.durationMs,
            ...(s.transport ? { transport: s.transport } : {}),
          })
        } else {
          updateEntry(event.ctx.id, {
            state: event.ctx.state,
            active: event.ctx.state !== "completed" && event.ctx.state !== "failed" && event.ctx.state !== "aborted",
            lastUpdatedAt: Date.now(),
          })
        }
        persistEntryStatus(event.ctx.id)
        return
      }
      case "request.completed":
      case "request.failed":
      case "request.aborted": {
        this.onTerminal(event.entry)
        return
      }
      // Mid-flight bus events we don't need (history is driven via
      // `request.context_updated` instead — same data, one channel).
      case "request.model_resolved":
      case "request.attempt_started":
      case "request.attempt_failed":
      case "request.stream_progress":
      case "request.feature_applied": {
        return
      }
      // Filtered out at subscribe time but listed for exhaustive check.
      default: {
        return
      }
    }
  }

  /**
   * Mirror the legacy `handleHistoryEvent` "updated" branch:
   * - First `originalRequest` set → insertEntry + persistEntryEager
   * - `attempts`/`queueWaitMs` → updateEntry activity patch; for attempts,
   *   incrementally persist the current attempt's bodies
   * - `warningMessages` → updateEntry warningMessages
   * - `pipelineInfo` → updateEntry pipelineInfo
   *
   * Reads the live `contextRef` synchronously (this method is on the
   * subscriber path; sink runs to completion before bus.publish returns).
   * The contract is documented on the `request.context_updated` event in
   * events.ts.
   */
  private onContextUpdated(ctx: RequestContext, field: string): void {
    if (field === "originalRequest") {
      const orig = ctx.originalRequest
      if (!orig) return
      const entry: HistoryEntry = {
        id: ctx.id,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx.rawPath ? { rawPath: ctx.rawPath } : {}),
        endpoint: ctx.endpoint,
        // Process identity injected once at insert. The in-flight merge chain
        // ({...existing, ...patch}) preserves it through every subsequent
        // updateEntry to finalization, so it lands in the persisted blob + the
        // pid column without needing to be re-supplied on each update (and it
        // is intentionally absent from updateEntry's Pick<> allowlist).
        process: getProcessIdentity(),
        ...buildHistoryActivityPatch(ctx),
        inboundRequest: {
          model: orig.model,
          messages: orig.messages as Array<MessageContent> | undefined,
          stream: orig.stream,
          tools: orig.tools as HistoryEntry["inboundRequest"]["tools"],
          system: orig.system as HistoryEntry["inboundRequest"]["system"],
        },
      }
      insertEntry(entry)
      persistEntryEager(entry)
      return
    }
    if (field === "attempts" || field === "queueWaitMs") {
      updateEntry(ctx.id, buildHistoryActivityPatch(ctx))
      if (field === "attempts") persistEntryStages(ctx.id, collectAttemptStages(ctx))
      return
    }
    if (field === "warningMessages" && ctx.warningMessages.length > 0) {
      updateEntry(ctx.id, { warningMessages: [...ctx.warningMessages] })
      return
    }
    if (field === "pipelineInfo" && ctx.pipelineInfo) {
      updateEntry(ctx.id, { pipelineInfo: ctx.pipelineInfo })
      return
    }
    if (field === "httpHeaders" && ctx.httpHeaders) {
      // RFC Phase 5: mirror the live captured header legs onto the in-flight entry so
      // streaming requests show httpHeaders before they finalize. Reads the full
      // headers off the ctx ref (not carried in the lightweight snapshot).
      updateEntry(ctx.id, { httpHeaders: ctx.httpHeaders })
      return
    }
    // Other field names (e.g. future additions) are intentionally ignored —
    // adding a new mirror-to-history field is an explicit choice.
  }

  /**
   * Write a terminal entry to SQLite. Mirrors the body of
   * `handleHistoryEvent`'s `completed/failed/aborted` branch in
   * `consumers.ts` 1:1.
   */
  private onTerminal(entryData: HistoryEntryData): void {
    const response = toHistoryResponse(entryData)
    updateEntry(entryData.id, {
      rawPath: entryData.rawPath,
      sessionId: entryData.sessionId,
      agentId: entryData.agentId,
      state: entryData.state,
      active: entryData.active,
      lastUpdatedAt: entryData.lastUpdatedAt,
      queueWaitMs: entryData.queueWaitMs,
      attemptCount: entryData.attemptCount,
      currentStrategy: entryData.currentStrategy,
      outboundResponse: response,
      startedAt: entryData.startedAt,
      endedAt: entryData.endedAt,
      durationMs: entryData.durationMs,
      transport: entryData.transport,
      sseEvents: entryData.sseEvents,
      ...(entryData.inboundResponse && { inboundResponse: entryData.inboundResponse }),
      ...(entryData.warningMessages && { warningMessages: entryData.warningMessages }),
      ...(entryData.effectiveRequest && {
        effectiveRequest: {
          model: entryData.effectiveRequest.model,
          format: entryData.effectiveRequest.format,
          messageCount: entryData.effectiveRequest.messageCount,
          messages: entryData.effectiveRequest.messages as NonNullable<HistoryEntry["effectiveRequest"]>["messages"],
          system: entryData.effectiveRequest.system as NonNullable<HistoryEntry["effectiveRequest"]>["system"],
          payload: entryData.effectiveRequest.payload,
        },
      }),
      ...(entryData.outboundRequest && {
        outboundRequest: {
          model: entryData.outboundRequest.model,
          format: entryData.outboundRequest.format,
          messageCount: entryData.outboundRequest.messageCount,
          messages: entryData.outboundRequest.messages as NonNullable<HistoryEntry["outboundRequest"]>["messages"],
          system: entryData.outboundRequest.system as NonNullable<HistoryEntry["outboundRequest"]>["system"],
          payload: entryData.outboundRequest.payload,
          // RFC Phase 3: ② per-attempt/outbound request headers (the explicit field
          // projection must carry the new leg field through HistoryEntryData→HistoryEntry).
          ...(entryData.outboundRequest.headers && { headers: entryData.outboundRequest.headers }),
        },
      }),
      ...(entryData.httpHeaders && { httpHeaders: entryData.httpHeaders }),
      ...(entryData.attempts && { attempts: toHistoryAttempts(entryData.attempts) }),
    })
    // Fire-and-forget: finalize is now async (libuv-offloaded compression). It
    // tracks itself in `pendingFinalizations` for the shutdown drain and never
    // rejects, so the synchronous bus handler doesn't await it.
    void finalizeEntry(entryData.id)
  }
}

// ============================================================================
// Helpers (kept in sync with the legacy consumers.ts — single source now)
// ============================================================================

function collectAttemptStages(ctx: RequestContext): Array<StagePayload> {
  const a = ctx.currentAttempt
  if (!a) return []
  const stages: Array<StagePayload> = []
  if (a.effectiveRequest) stages.push({ stage: STAGE.effectiveRequest, attemptIndex: a.index, payload: legFromEffective(a.effectiveRequest) })
  if (a.wireRequest) stages.push({ stage: STAGE.outboundRequest, attemptIndex: a.index, payload: legFromWire(a.wireRequest) })
  if (a.response) stages.push({ stage: STAGE.outboundResponse, attemptIndex: a.index, payload: responseDataToHistory(a.response) })
  return stages
}

function toHistoryResponse(entryData: HistoryEntryData): HistoryEntry["outboundResponse"] | undefined {
  if (!entryData.outboundResponse) return undefined
  return responseDataToHistory(entryData.outboundResponse)
}

function responseDataToHistory(r: ResponseData): NonNullable<HistoryEntry["outboundResponse"]> {
  return {
    success: r.success,
    model: r.model,
    usage: {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens,
      cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
      output_tokens_details: r.usage.output_tokens_details,
    },
    stop_reason: r.stop_reason,
    error: r.error,
    status: r.status,
    content: r.content as MessageContent | null,
    rawBody: r.responseText,
  }
}

function toHistoryAttempts(attempts: HistoryEntryData["attempts"]): HistoryEntry["attempts"] {
  return attempts?.map((a) => ({
    index: a.index,
    strategy: a.strategy,
    durationMs: a.durationMs,
    transport: a.transport,
    error: a.error,
    truncation: a.truncation,
    sanitization: a.sanitization,
    effectiveMessageCount: a.effectiveMessageCount,
    effectiveRequest: a.effectiveRequest as NonNullable<HistoryEntry["attempts"]>[number]["effectiveRequest"],
    wireRequest: a.wireRequest as NonNullable<HistoryEntry["attempts"]>[number]["wireRequest"],
    response: a.response ? responseDataToHistory(a.response) : undefined,
    sseEvents: a.sseEvents,
    responseHeaders: a.responseHeaders,
  }))
}

// ============================================================================
// Attachment helper
// ============================================================================

export function attachHistorySink(bus: ObservabilityBus, options?: HistorySinkOptions): () => void {
  const sink = new HistorySink(bus, options)
  return () => {
    sink.destroy()
  }
}
