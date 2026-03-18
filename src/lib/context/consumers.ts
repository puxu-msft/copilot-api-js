/**
 * Context event consumers — bridge between RequestContext events and subsystems.
 *
 * Three consumers subscribe to RequestContextManager "change" events:
 * 1. History consumer → inserts/updates HistoryEntry in the store
 * 2. TUI consumer → updates tuiLogger for terminal display
 * 3. (WebSocket is handled implicitly via store's notifyEntryAdded/Updated)
 */

import type { HistoryEntry, MessageContent } from "~/lib/history"

import { getCurrentSession, insertEntry, isHistoryEnabled, updateEntry } from "~/lib/history/store"
import { tuiLogger } from "~/lib/tui"

import type { RequestContextEvent, RequestContextManager } from "./manager"
import type { HistoryEntryData, ResponseData } from "./request"

// ─── History Consumer ───

function handleHistoryEvent(event: RequestContextEvent): void {
  if (!isHistoryEnabled()) return

  switch (event.type) {
    case "created": {
      const ctx = event.context
      const sessionId = getCurrentSession(ctx.endpoint)

      const entry: HistoryEntry = {
        id: ctx.id,
        sessionId,
        timestamp: ctx.startTime,
        endpoint: ctx.endpoint,
        request: {
          model: ctx.originalRequest?.model,
          messages: ctx.originalRequest?.messages as Array<MessageContent> | undefined,
          stream: ctx.originalRequest?.stream,
          tools: ctx.originalRequest?.tools as HistoryEntry["request"]["tools"],
          system: ctx.originalRequest?.system as HistoryEntry["request"]["system"],
        },
      }

      insertEntry(entry)
      break
    }

    case "updated": {
      // originalRequest is set after the "created" event fires (the context
      // doesn't exist yet when create() is called, so setOriginalRequest()
      // comes after). Update the entry with the actual request data now.
      if (event.field === "originalRequest" && event.context.originalRequest) {
        const orig = event.context.originalRequest
        updateEntry(event.context.id, {
          request: {
            model: orig.model,
            messages: orig.messages as Array<MessageContent> | undefined,
            stream: orig.stream,
            tools: orig.tools as HistoryEntry["request"]["tools"],
            system: orig.system as HistoryEntry["request"]["system"],
          },
        })
      }
      if (event.field === "pipelineInfo" && event.context.pipelineInfo) {
        updateEntry(event.context.id, { pipelineInfo: event.context.pipelineInfo })
      }
      break
    }

    case "completed":
    case "failed": {
      const entryData = event.entry
      const response = toHistoryResponse(entryData)

      updateEntry(entryData.id, {
        response,
        durationMs: entryData.durationMs,
        sseEvents: entryData.sseEvents,
        httpHeaders: entryData.httpHeaders,
      })
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

    case "failed": {
      const ctx = event.context
      const tuiLogId = ctx.tuiLogId
      if (!tuiLogId) return

      tuiLogger.finishRequest(tuiLogId, {
        error: ctx.response?.error ?? "Unknown error",
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

function toHistoryResponse(entryData: HistoryEntryData): HistoryEntry["response"] | undefined {
  if (!entryData.response) return undefined

  const r: ResponseData = entryData.response
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
    content: r.content as MessageContent | null,
  }
}

// ─── Registration ───

import { handleErrorPersistence } from "./error-persistence"

export function registerContextConsumers(manager: RequestContextManager): void {
  manager.on("change", handleHistoryEvent)
  manager.on("change", handleTuiEvent)
  manager.on("change", handleErrorPersistence)
}
