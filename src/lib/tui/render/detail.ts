import type { AttemptSnapshot } from "~/lib/observability"

import { truncateToWidth } from "~/lib/observability/projections/format"
import {
  //
  formatBytes,
  formatDuration,
  formatDurationField,
} from "~/lib/observability/projections/format"

import type { DetailView } from "./panel"

import { sanitizeTerminalText } from "./sanitize"

export interface KeyedDetailLine {
  key: string
  text: string
}
export interface DetailDocument {
  revision: string
  header: KeyedDetailLine
  body: Array<KeyedDetailLine>
}
export interface DetailViewport {
  lines: Array<string>
  offset: number
  maxOffset: number
  bodyRows: number
}

/** Build an unstyled, stable-keyed detail document independent of terminal geometry. */
export function buildDetailDocument(entry: DetailView, now: number): DetailDocument {
  const { ctx } = entry
  const retries = (ctx.attemptCount ?? 1) - 1
  const lastMs = ctx.currentAttemptStartedAt === undefined ? undefined : now - ctx.currentAttemptStartedAt
  const lines: Array<KeyedDetailLine> = [
    keyed("route", `${ctx.method} ${ctx.path}`),
    keyed("model", `model: ${ctx.clientModel ?? "?"} → ${ctx.resolvedModel ?? "(resolving)"}`),
    ...(ctx.multiplier === undefined ? [] : [keyed("multiplier", `multiplier: ${ctx.multiplier}x`)]),
    keyed("state", `state: ${ctx.state}`),
    keyed("elapsed", `elapsed: ${formatDurationField({ lastMs, totalMs: now - ctx.startTime, retries })}`),
    keyed("queue-wait", `queueWait: ${formatDuration(ctx.queueWaitMs)}`),
    keyed(
      "bytes",
      `bytes: ↑${ctx.requestBodySize === undefined ? "-" : formatBytes(ctx.requestBodySize)} ↓${entry.streamBytesIn === undefined ? "-" : formatBytes(entry.streamBytesIn)}`,
    ),
    keyed("events", `events: ${entry.streamEventsIn ?? 0}`),
    ...(entry.streamBlockType === undefined ? [] : [keyed("block", `block: ${entry.streamBlockType}`)]),
    ...(entry.tags && entry.tags.length > 0 ? [keyed("tags", `tags: ${entry.tags.join(", ")}`)] : []),
    ...(entry.thinking ? [keyed("thinking", `thinking: ${entry.thinking.requested ?? "(unset)"} (requested) → ${entry.thinking.effective} (effective)`)] : []),
    ...(entry.attempts && entry.attempts.length > 0 ?
      [keyed("attempt-count", `attempts: ${entry.attempts.length}`), ...entry.attempts.map((attempt) => attemptLine(attempt))]
    : []),
  ]
  const attemptRevision = entry.attempts?.map((attempt) => `${attempt.attemptIndex}:${attempt.strategy ?? ""}:${attempt.error?.message ?? ""}`).join("|") ?? ""
  return { revision: `${ctx.id}:${ctx.state}:${attemptRevision}`, header: keyed("header", `req_id: ${ctx.id}`), body: lines }
}

/** Lay out fixed header/keybar around a scrollable body and clamp after resize/revision. */
export function layoutDetailViewport(document: DetailDocument, options: { rows: number; columns: number; offset: number }): DetailViewport {
  const rows = Math.max(1, options.rows)
  const budget = Math.max(0, options.columns - 1)
  const hasKeybar = rows >= 2
  const bodyRows = Math.max(0, rows - 1 - (hasKeybar ? 1 : 0))
  const maxOffset = Math.max(0, document.body.length - bodyRows)
  const offset = Math.min(Math.max(0, options.offset), maxOffset)
  const visible = document.body.slice(offset, offset + bodyRows)
  const render = (line: KeyedDetailLine): string => truncateToWidth(sanitizeTerminalText(line.text), budget)
  const lines = [render(document.header), ...visible.map((line) => render(line))]
  if (hasKeybar) {
    const above = offset
    const below = Math.max(0, document.body.length - offset - visible.length)
    const status = `${above > 0 ? `↑${above} ` : ""}${below > 0 ? `↓${below} ` : ""}· ↑↓/PgUp/PgDn/Home/End · esc back`
    lines.push(truncateToWidth(status, budget))
  }
  return { lines, offset, maxOffset, bodyRows }
}

function keyed(key: string, text: string): KeyedDetailLine {
  return { key, text }
}
function attemptLine(attempt: AttemptSnapshot): KeyedDetailLine {
  const parts = [`#${attempt.attemptIndex}`]
  if (attempt.strategy) parts.push(attempt.strategy)
  if (attempt.transport) parts.push(`[${attempt.transport}]`)
  if (attempt.error) parts.push(`error ${attempt.error.status} ${attempt.error.type}: ${attempt.error.message}`)
  return keyed(`attempt:${attempt.attemptIndex}`, `  ${parts.join(" ")}`)
}
