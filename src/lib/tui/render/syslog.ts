/**
 * System-log line rendering — pure renderer extracted from `ConsoleSink`
 * (P0 terminal-layer reorg; behavior-equivalent to the former private
 * `consolaPrefix` helper + `onSystemLog` body).
 *
 * A `system.log` event is a non-HTTP consola line republished onto the
 * observability bus (see `republish.ts`). This module turns it into the exact
 * `[INFO] HH:MM:SS message` line the old consola-hijack reporter produced, so
 * the sink only has to `printLog` the result.
 *
 * Purity: no `this`, no wall clock, no I/O. The caller supplies the event; the
 * timestamp comes from the event's own `time` field.
 */

import pc from "picocolors"

import type { DiagnosticEvent } from "~/lib/diagnostics"

import { diagnosticConsolaType } from "~/lib/diagnostics"
import { sanitizeTerminalText } from "./sanitize"
import { formatTime } from "~/lib/observability/projections/format"

/**
 * Render a republished consola log (`system.log` event) into its full terminal
 * line — `consolaPrefix(logType, time)` + `message`, no trailing newline.
 * `message` is already args-joined by `republish.ts`; an unknown `logType`
 * yields the bare timestamp prefix (message only when the prefix is empty,
 * which never happens today since the default branch still returns the time).
 */
export function renderSystemLogLine(event: Pick<DiagnosticEvent, "message" | "timeUnixMs"> & { severity: string; fields?: DiagnosticEvent["fields"] }): string {
  const prefix = consolaPrefix(diagnosticConsolaType(event), new Date(event.timeUnixMs))
  const message = sanitizeTerminalText(event.message)
  return prefix ? `${prefix} ${message}` : message
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
