/**
 * History sink — translates `request.*` terminal events into SQLite writes
 * via the existing `lib/history/*` API, and forwards history-level signals
 * (entry persistence, stats deltas, cleared/session_deleted) onto the bus
 * for WsSink to broadcast.
 *
 * Replaces the `handleHistoryEvent` consumer in `lib/context/consumers.ts`.
 *
 * Commit 2 (this commit): subscribed but idle — bus carries no events
 * yet because the producer in `manager.ts` still calls `consumers.ts`.
 * Commit 3b atomically swaps the producer over and deletes `consumers.ts`,
 * at which point this sink becomes authoritative.
 *
 * `history.*` event emission (via the injected publisher) is **not yet
 * wired here** — `lib/history/entries.ts` and `lib/history/sessions.ts`
 * still call the legacy `notifyEntry...`, `notifyStatsUpdated`,
 * `notifyHistoryCleared`, and `notifySessionDeleted` functions directly.
 * They will be switched to publish via `historyState.publisher` in
 * commit 3b alongside the producer cutover (so the two halves of D9
 * collapse together).
 */

import type {
  //
  HistoryEntryData,
  ResponseData,
} from "~/lib/context/types"
import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history"

import {
  //
  finalizeEntry,
  isHistoryEnabled,
  updateEntry,
} from "~/lib/history/store"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
  ScopedPublisher,
} from "../index"

export interface HistorySinkOptions {
  /**
   * Scoped publisher for `history.*` events. Injected by `start.ts`; in
   * commit 3b `lib/history/entries.ts` and `sessions.ts` will receive
   * this same publisher via `historyState.publisher` to emit
   * `history.entry_added/updated/stats_changed/cleared/session_deleted`.
   * For commit 2 it is unused (no producer publishes terminal events yet).
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
      // system.* events. This is the §2.3 #9 contract: HistorySink subscribes
      // only to request.* and does NOT see its own emitted history.* events
      // (which avoids a noisy assertNever path).
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
        // No-op — original behavior waits for originalRequest to be set.
        return
      }
      case "request.model_resolved":
      case "request.state_changed": {
        // Translate state changes to head-row updates. The event payload
        // does not carry `originalRequest` / `attempts` so we cannot fully
        // mirror `handleHistoryEvent`'s "updated" branch yet. Commit 3b
        // either threads the full ctx through these events or replaces this
        // sink's body with a richer translation. For commit 2 this is a
        // no-op because no producer publishes these events.
        return
      }
      case "request.attempt_started":
      case "request.attempt_failed":
      case "request.stream_progress":
      case "request.feature_applied": {
        // Per RFC §2.3 these are mid-flight signals. History persistence
        // for attempts/streaming is currently driven by ctx.field
        // updates ("attempts"/"queueWaitMs"); commit 3b will move that
        // logic here. For commit 2: idle.
        return
      }
      case "request.completed":
      case "request.failed":
      case "request.aborted": {
        this.onTerminal(event.entry)
        return
      }
      // We filtered these out at subscribe time, but include the cases so
      // adding a new request.* kind to the union still fails tsc until
      // this sink decides what to do.
      default: {
        return
      }
    }
  }

  /**
   * Write a terminal entry to SQLite. Mirrors the body of
   * `handleHistoryEvent`'s `completed/failed/aborted` branch in
   * `consumers.ts` so commit 3b can delete that file 1:1.
   */
  private onTerminal(entryData: HistoryEntryData): void {
    const response = toHistoryResponse(entryData)
    updateEntry(entryData.id, {
      rawPath: entryData.rawPath,
      sessionId: entryData.sessionId,
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
        },
      }),
      ...(entryData.httpHeaders && { httpHeaders: entryData.httpHeaders }),
      ...(entryData.attempts && { attempts: toHistoryAttempts(entryData.attempts) }),
    })
    finalizeEntry(entryData.id)
  }
}

// ============================================================================
// Helpers (kept in sync with consumers.ts — commit 3b deletes the duplicate)
// ============================================================================

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
  }))
}

// `insertEntry / persistEntryEager / persistEntryStatus / persistEntryStages
// / buildHistoryActivityPatch / collectAttemptStages / STAGE / legFromEffective
// / legFromWire / getProcessIdentity` are still referenced by the original
// `consumers.ts` flow in commits 1-3a. Commit 3b moves their call sites here
// and adds the corresponding imports back.

// ============================================================================
// Attachment helper
// ============================================================================

export function attachHistorySink(bus: ObservabilityBus, options?: HistorySinkOptions): () => void {
  const sink = new HistorySink(bus, options)
  return () => {
    sink.destroy()
  }
}
