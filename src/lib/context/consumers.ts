/**
 * Context event consumers — bridge between RequestContext events and subsystems.
 *
 * Three consumers subscribe to RequestContextManager "change" events:
 * 1. History consumer → inserts/updates HistoryEntry in the store
 * 2. TUI consumer → updates tuiLogger for terminal display
 * 3. (WebSocket is handled implicitly via store's notifyEntryAdded/Updated)
 */

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history"

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
import { tuiLogger } from "~/lib/tui"

import type {
  //
  RequestContextEvent,
  RequestContextManager,
} from "./manager"
import type {
  //
  HistoryEntryData,
  ResponseData,
} from "./request"

import { buildHistoryActivityPatch } from "./activity-summary"
import {
  //
  legFromEffective,
  legFromWire,
} from "./request"

// ─── History Consumer ───

function handleHistoryEvent(event: RequestContextEvent): void {
  if (!isHistoryEnabled()) return

  switch (event.type) {
    case "created": {
      // Don't insert yet — wait for originalRequest to be available
      // (setOriginalRequest fires "updated" event immediately after create)
      break
    }

    case "updated": {
      // Insert entry on first originalRequest (delayed from "created")
      if (event.field === "originalRequest") {
        const orig = event.context.originalRequest
        if (!orig) break
        const ctx = event.context

        const entry: HistoryEntry = {
          id: ctx.id,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
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
        // Eager SQLite persistence: head row (status=pending) + inbound_request
        // stage, so a crash before terminal still leaves a discoverable record.
        persistEntryEager(entry)
      }
      if (event.field === "attempts" || event.field === "queueWaitMs") {
        updateEntry(event.context.id, buildHistoryActivityPatch(event.context))
        // Incrementally persist the current attempt's available bodies (wire
        // request written BEFORE the upstream call → survives a mid-call crash).
        if (event.field === "attempts") persistEntryStages(event.context.id, collectAttemptStages(event.context))
      }
      if (event.field === "warningMessages" && event.context.warningMessages.length > 0) {
        updateEntry(event.context.id, { warningMessages: [...event.context.warningMessages] })
      }
      if (event.field === "pipelineInfo" && event.context.pipelineInfo) {
        updateEntry(event.context.id, { pipelineInfo: event.context.pipelineInfo })
      }
      break
    }

    case "state_changed": {
      updateEntry(event.context.id, buildHistoryActivityPatch(event.context))
      // Reflect the new status on the persisted head row (pending→executing→
      // streaming…), so a crash shows how far the request got.
      persistEntryStatus(event.context.id)
      break
    }

    case "completed":
    case "failed":
    case "aborted": {
      const entryData = event.entry
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
        ...(entryData.httpHeaders && {
          httpHeaders: entryData.httpHeaders,
        }),
        ...(entryData.attempts && {
          attempts: toHistoryAttempts(entryData.attempts),
        }),
      })
      // Explicit finalization step. Previously updateEntry inferred terminality
      // from the state field and auto-persisted as a side effect. That coupled
      // a data field to a write-to-disk action, so a transition() emitting
      // state_changed BEFORE the full completed/failed event would persist a
      // partial entry and remove it from in-flight, making the subsequent
      // full update silently no-op. Explicit finalize keeps the ordering
      // contract obvious and auditable.
      finalizeEntry(entryData.id)
      break
    }

    default: {
      break
    }
  }
}

// ─── TUI Consumer ───

function handleTuiEvent(event: RequestContextEvent): void {
  switch (event.type) {
    case "state_changed": {
      const tuiLogId = event.context.tuiLogId
      if (!tuiLogId) return

      const newState = event.context.state
      if (newState === "streaming") {
        tuiLogger.updateRequest(tuiLogId, { status: "streaming" })
      } else if (newState === "executing") {
        tuiLogger.updateRequest(tuiLogId, { status: "executing" })
      }
      break
    }

    case "updated": {
      const tuiLogId = event.context.tuiLogId
      if (!tuiLogId) return

      // When attempts are updated, add retry tags
      if (event.field === "attempts" && event.context.attempts.length > 1) {
        const attempt = event.context.currentAttempt
        if (attempt?.strategy) {
          tuiLogger.updateRequest(tuiLogId, { tags: [attempt.strategy] })
        }
      }
      if (event.field === "attempts") {
        const transportTag = toTransportTag(event.context.currentAttempt?.transport)
        if (transportTag) {
          tuiLogger.updateRequest(tuiLogId, { tags: [transportTag] })
        }
      }
      break
    }

    case "completed": {
      const ctx = event.context
      const tuiLogId = ctx.tuiLogId
      if (!tuiLogId) return

      const response = ctx.response
      if (response) {
        tuiLogger.updateRequest(tuiLogId, {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
          queueWaitMs: ctx.queueWaitMs || undefined,
        })
        // "completed" event implies upstream returned 200
        tuiLogger.finishRequest(tuiLogId, { statusCode: 200 })
      }
      break
    }

    case "aborted":
    case "failed": {
      const ctx = event.context
      const tuiLogId = ctx.tuiLogId
      if (!tuiLogId) return

      tuiLogger.finishRequest(tuiLogId, {
        error: ctx.response?.error ?? (event.type === "aborted" ? "client disconnected" : "Unknown error"),
        // HTTP status from the last attempt's classified error (if available)
        statusCode: ctx.currentAttempt?.error?.status || undefined,
      })
      break
    }

    default: {
      break
    }
  }
}

// ─── Helpers ───

/** Build the incremental stage payloads for the current attempt's available bodies. */
function collectAttemptStages(ctx: RequestContextEvent["context"]): Array<StagePayload> {
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

/** Project a context ResponseData into the history OutboundResponseData shape (rawBody ← responseText). */
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

/** Map context attempts to history attempts, projecting each per-attempt response (Bug 3). */
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

function toTransportTag(transport: HistoryEntry["transport"] | undefined): string | undefined {
  if (transport === "upstream-ws") return "ws"
  if (transport === "upstream-ws-fallback") return "ws→http"
  return undefined
}

// ─── Registration ───

export function registerContextConsumers(manager: RequestContextManager): void {
  manager.on("change", handleHistoryEvent)
  manager.on("change", handleTuiEvent)
}
