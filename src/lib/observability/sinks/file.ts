/**
 * File sink — appends non-HTTP consola logs (`system.log` events) to a
 * rotating `copilot-api.log` so they survive a process crash/hang.
 *
 * Motivation: request lifecycle lines are already persisted to history.db, but
 * the consola stream (startup, auth, model refresh, warnings, errors, reaper)
 * only ever reached stdout — when the process hung and was killed, that stream
 * was lost and the incident could not be diagnosed. This sink persists it.
 *
 * Scope: subscribes to `system.log` ONLY (the republished consola stream). It
 * deliberately does NOT write request lifecycle lines — those live in
 * history.db and would duplicate.
 *
 * Failure isolation: a write error (disk full, permission) must never affect
 * request handling, and must NOT go through consola (that would re-enter the
 * republish reporter → this sink → loop). Errors are written straight to
 * stderr and the sink keeps running.
 */

import fs from "node:fs"
import path from "node:path"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "../index"

/** Strip ANSI SGR color codes so the file holds plain text. */
// eslint-disable-next-line no-control-regex -- matching the ESC control char is the point of an ANSI stripper
const ANSI_SGR = /\u001b\[[0-9;]*m/g

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024
const DEFAULT_RETAIN = 7

export interface FileSinkOptions {
  /** Absolute path to the log file. */
  path: string
  /** Rotate when the active file would exceed this many bytes. Default 10 MiB. */
  maxSizeBytes?: number
  /** Number of rotated files to retain (`.log.1` … `.log.N`). Default 7. */
  retain?: number
}

/** Map a consola log type to a fixed-width file label. */
function levelLabel(logType: string): string {
  switch (logType) {
    case "error": {
      return "ERR "
    }
    case "fatal": {
      return "FATAL"
    }
    case "warn": {
      return "WARN"
    }
    case "info": {
      return "INFO"
    }
    case "success": {
      return "SUCC"
    }
    case "debug": {
      return "DBG "
    }
    default: {
      return logType.toUpperCase().slice(0, 5).padEnd(4)
    }
  }
}

/** `YYYY-MM-DD HH:MM:SS` from epoch ms — full date for post-mortem correlation. */
function formatStamp(time: number): string {
  const d = new Date(time)
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Day key (local) used to trigger time-based rotation across midnight. */
function dayKey(time: number): string {
  return formatStamp(time).slice(0, 10)
}

export class FileSink {
  private readonly path: string
  private readonly maxSizeBytes: number
  private readonly retain: number
  private currentSize: number
  private currentDay: string
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus, options: FileSinkOptions) {
    this.path = options.path
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES
    this.retain = options.retain ?? DEFAULT_RETAIN
    this.currentSize = this.statSize()
    // Initial default for the existing-file case; `append` re-anchors it to each written
    // line's day, so a stale construction-time value can't trigger a spurious rotation.
    this.currentDay = dayKey(Date.now())

    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event)
    })
  }

  destroy(): void {
    this.unsubscribe()
  }

  private handle(event: ObservabilityEvent): void {
    if (event.kind !== "system.log") return
    const message = event.message.replaceAll(ANSI_SGR, "")
    const line = `${formatStamp(event.time)} [${levelLabel(event.logType)}] ${message}\n`
    this.append(event.time, Buffer.byteLength(line), line)
  }

  private append(time: number, byteLen: number, line: string): void {
    try {
      this.rotateIfNeeded(time, byteLen)
      fs.mkdirSync(path.dirname(this.path), { recursive: true })
      fs.appendFileSync(this.path, line)
      this.currentSize += byteLen
      // Track the day of the last line ACTUALLY written, not the construction wall-clock
      // (`currentDay` was seeded from `Date.now()`). Events carry their own `time`, which can
      // legitimately differ from construction time; without this, the first event whose day
      // differs from the construction day leaves `currentDay` stale, so the SECOND same-day
      // event spuriously day-rotates (moving the first line into `.log.1`). Genuine midnight
      // rotation still fires: a later event on a new day differs from this last-written day.
      this.currentDay = dayKey(time)
    } catch (err: unknown) {
      // NEVER route through consola — that re-enters the republish reporter.
      process.stderr.write(`[FileSink] write failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  private rotateIfNeeded(time: number, incomingBytes: number): void {
    const day = dayKey(time)
    const sizeExceeded = this.currentSize > 0 && this.currentSize + incomingBytes > this.maxSizeBytes
    const dayChanged = day !== this.currentDay && this.currentSize > 0
    if (!sizeExceeded && !dayChanged) return
    this.rotate()
    this.currentSize = 0
    this.currentDay = day
  }

  /** Shift `.log → .log.1 → … → .log.N`, dropping anything past `retain`. */
  private rotate(): void {
    if (!fs.existsSync(this.path)) return
    // Drop the oldest, then shift each rotated file up by one.
    const oldest = `${this.path}.${this.retain}`
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
    for (let i = this.retain - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`
      if (fs.existsSync(from)) fs.renameSync(from, `${this.path}.${i + 1}`)
    }
    fs.renameSync(this.path, `${this.path}.1`)
  }

  private statSize(): number {
    try {
      return fs.statSync(this.path).size
    } catch {
      return 0
    }
  }
}

/** Attach a FileSink to the bus. Mirrors attachConsoleSink / attachHistorySink. */
export function attachFileSink(bus: ObservabilityBus, options: FileSinkOptions): () => void {
  const sink = new FileSink(bus, options)
  return () => {
    sink.destroy()
  }
}
