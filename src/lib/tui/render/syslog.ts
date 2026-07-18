/**
 * System-log line rendering — pure renderer extracted from `ConsoleSink`
 * (P0 terminal-layer reorg; behavior-equivalent to the former private
 * `consolaPrefix` helper + `onSystemLog` body).
 *
 * A `system.diagnostic` event is a structured diagnostic published onto the
 * observability bus (see `republish.ts`). This module preserves its physical
 * line structure while rendering the first line as
 * `[INFO] HH:MM:SS message`; the sink prints the returned lines in order.
 *
 * Purity: no `this`, no wall clock, no I/O. The caller supplies the event; the
 * timestamp comes from the event's own `time` field.
 */

import pc from "picocolors"

import type { DiagnosticEvent } from "~/lib/diagnostics"

import { diagnosticConsolaType } from "~/lib/diagnostics"
import { formatTime } from "~/lib/observability/projections/format"

import { sanitizeTerminalText } from "./sanitize"

/**
 * Render a structured diagnostic into terminal physical lines. The first line
 * receives `consolaPrefix(logType, time)`; continuation and blank lines retain
 * the message's original structure without repeating the badge. Every line is
 * sanitized independently, so LF remains a structural boundary while CR and
 * other terminal controls cannot reposition the cursor.
 */
export function renderSystemLogLines(
  event: Pick<DiagnosticEvent, "message" | "timeUnixMs"> & { severity: string; fields?: DiagnosticEvent["fields"] },
): Array<string> {
  const prefix = consolaPrefix(diagnosticConsolaType(event), new Date(event.timeUnixMs))
  const [first = "", ...continuations] = event.message
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
  return [prefix ? `${prefix} ${first}` : first, ...continuations]
}

/**
 * Map a consola log type to its `[XXXX] HH:MM:SS` badge + dim timestamp prefix.
 * The badge color mirrors consola's own level coloring; an unrecognized type
 * falls through to the bare (dim) timestamp with no badge.
 */
export function consolaPrefix(type: string, date?: Date): string {
  const time = pc.dim(formatTime(date))
  switch (type) {
    case "error":
    case "fatal": {
      return `${pc.red("[ERR ]")} ${time}`
    }
    case "warn": {
      return `${pc.yellow("[WARN]")} ${time}`
    }
    case "info": {
      return `${pc.cyan("[INFO]")} ${time}`
    }
    case "success": {
      return `${pc.green("[SUCC]")} ${time}`
    }
    case "debug": {
      return `${pc.gray("[DBG ]")} ${time}`
    }
    default: {
      return time
    }
  }
}
