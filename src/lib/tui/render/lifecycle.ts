import pc from "picocolors"

import type { LogLineParts } from "~/lib/observability/projections/log-line"

import {
  //
  deriveResponseBytes,
  responseThinkingFromBody,
  toolNamesFromResponseBody,
} from "~/lib/history/entry-view"
import {
  //
  formatDuration,
  formatDurationField,
  formatTime,
  resolveDurationColorMs,
} from "~/lib/observability/projections/format"
import { formatLogLine } from "~/lib/observability/projections/log-line"

import type { RequestDisplayEffect } from "../active-request-store"

import { sanitizeTerminalText } from "./sanitize"

export interface RequestEffectRenderOptions {
  now: number
  showActive: boolean
  verbose: boolean
  ordinalFor: (sessionId?: string, agentId?: string) => number | undefined
}

export function renderRequestEffect(effect: RequestDisplayEffect, options: RequestEffectRenderOptions): string | undefined {
  if (effect.kind === "created") {
    if (!options.showActive || !options.verbose) return undefined
    const ctx = effect.entry.ctx
    return formatLogLine(
      sanitizeParts({ prefix: "[....]", time: formatTime(new Date(options.now)), method: ctx.method, path: ctx.path, model: ctx.resolvedModel, isDim: true }),
    )
  }
  if (effect.kind === "retry") return renderRetry(effect, options)
  return renderTerminal(effect, options)
}

export function renderSyntheticRequestLine(parts: LogLineParts): string {
  return formatLogLine(sanitizeParts(parts))
}

export function formatThinkingTag(thinking: { requested?: string; effective: string }): string {
  return thinking.requested !== undefined && thinking.requested !== thinking.effective ?
      `thinking:${thinking.requested}→${thinking.effective}`
    : `thinking:${thinking.effective}`
}

function renderRetry(effect: Extract<RequestDisplayEffect, { kind: "retry" }>, options: RequestEffectRenderOptions): string {
  const { event, entry } = effect
  const attemptN = event.attempt.attemptIndex + 1
  const meta = [`retryable: ${event.nextStrategy ?? event.attempt.strategy ?? "?"}`]
  if (event.waitMs && event.waitMs > 0) meta.push(`wait ${formatDuration(event.waitMs)}`)
  if (event.learning) meta.push("learning")
  const elapsedMs = options.now - event.ctx.startTime
  const duration = formatDurationField({ lastMs: event.attempt.durationMs, totalMs: elapsedMs, retries: attemptN })
  const error = event.attempt.error?.message
  return formatLogLine(
    sanitizeParts({
      prefix: "[RETRY]",
      time: formatTime(new Date(options.now)),
      method: event.ctx.method,
      path: event.ctx.path,
      sessionId: event.ctx.sessionId,
      agentId: event.ctx.agentId,
      agentOrdinal: options.ordinalFor(event.ctx.sessionId, event.ctx.agentId),
      model: event.ctx.resolvedModel,
      clientModel: event.ctx.clientModel,
      multiplier: event.ctx.multiplier,
      status: event.attempt.error?.status,
      duration,
      durationMs: resolveDurationColorMs({ lastMs: event.attempt.durationMs, totalMs: elapsedMs, retries: attemptN }),
      requestBodySize: event.ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      extra: error ? `: ${error}` : undefined,
      retryableMeta: `(${meta.join(", ")})`,
      isRetry: true,
    }),
  )
}

function renderTerminal(effect: Extract<RequestDisplayEffect, { kind: "terminal" }>, options: RequestEffectRenderOptions): string | undefined {
  const { entry, historyEntry } = effect
  const ctx = entry.ctx
  const isError = effect.outcome !== "completed" || (effect.statusCode !== undefined && effect.statusCode >= 400)
  if (entry.isHistoryAccess && !isError) return undefined
  const attempts = historyEntry.attempts
  const retries = (attempts?.length ?? 1) - 1
  const lastMs = attempts?.at(-1)?.durationMs
  const durationMs = options.now - ctx.startTime
  const final = attempts?.at(-1)?.upstreamResponse
  const tags = entry.thinking ? [formatThinkingTag(entry.thinking), ...entry.tags] : entry.tags
  const extra =
    `${!isError && tags.length > 0 ? pc.dim(` (${tags.join(", ")})`) : ""}${isError && effect.error ? `: ${sanitizeTerminalText(effect.error)}` : ""}`
    || undefined
  const upstreamNames = toolNamesFromResponseBody(final?.body)
  const toolNames = upstreamNames.length > 0 ? upstreamNames : (entry.recoveredToolNames ?? [])
  return formatLogLine(
    sanitizeParts(
      {
        prefix: isError ? "[FAIL]" : "[ OK ]",
        time: formatTime(new Date(options.now)),
        method: ctx.method,
        path: ctx.path,
        inputFormat: ctx.endpoint,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        agentOrdinal: options.ordinalFor(ctx.sessionId, ctx.agentId),
        model: ctx.resolvedModel,
        clientModel: ctx.clientModel,
        multiplier: ctx.multiplier,
        status: effect.statusCode,
        duration: formatDurationField({ lastMs, totalMs: durationMs, retries }),
        durationMs: resolveDurationColorMs({ lastMs, totalMs: durationMs, retries }),
        queueWait: ctx.queueWaitMs > 100 ? formatDuration(ctx.queueWaitMs) : undefined,
        requestBodySize: ctx.requestBodySize,
        // ↓ downstream bytes: the live stream accumulator stays authoritative for
        // streaming rows; fall back to the authoritative forwarded content for
        // non-streaming / short rows where no `stream_progress` ever fired.
        responseBodySize: entry.streamBytesIn ?? deriveResponseBytes(historyEntry),
        inputTokens: final?.usage?.input_tokens,
        outputTokens: final?.usage?.output_tokens,
        cacheReadInputTokens: final?.usage?.cache_read_input_tokens,
        cacheCreationInputTokens: final?.usage?.cache_creation_input_tokens,
        stopReason: isError ? undefined : final?.stopReason,
        toolNames: isError ? undefined : toolNames,
        responseThinking: isError ? undefined : responseThinkingFromBody(final?.body),
        extra,
        reqId: isError ? ctx.id : undefined,
        isError,
      },
      new Set(["extra"]),
    ),
  )
}

const STRING_FIELDS: ReadonlyArray<keyof LogLineParts> = [
  "prefix",
  "time",
  "method",
  "path",
  "sessionId",
  "agentId",
  "model",
  "clientModel",
  "duration",
  "queueWait",
  "extra",
  "retryableMeta",
  "stopReason",
  "reqId",
]

function sanitizeParts(parts: LogLineParts, trusted = new Set<keyof LogLineParts>()): LogLineParts {
  const result = { ...parts }
  for (const key of STRING_FIELDS) {
    const value = result[key]
    if (typeof value === "string" && !trusted.has(key)) (result as Record<string, unknown>)[key] = sanitizeTerminalText(value)
  }
  if (result.toolNames) result.toolNames = result.toolNames.map((name) => sanitizeTerminalText(name))
  return result
}
