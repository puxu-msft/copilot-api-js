#!/usr/bin/env bun
/**
 * Recover terminal records captured from `/history/api/entries/:id` while the
 * pre-fix V3 writer rejected JSON-compatible shared references.
 *
 * Input is gzip NDJSON: one `{type:"header",capturedAt}` line followed by
 * `{type:"entry",entry:HistoryEntry}` lines. Recovery is idempotent by
 * operation_id, preserves the source file, and marks unavailable timing/raw
 * provenance instead of fabricating it.
 *
 * Usage:
 *   bun scripts/recover-history-v3-projections.ts --input=/path/recovery.ndjson.gz --dry-run
 *   bun scripts/recover-history-v3-projections.ts --input=/path/recovery.ndjson.gz --db=/path/history-v3.db
 *     --timing-overrides=/path/timing-overrides.json
 */

import consola from "consola"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { createGunzip } from "node:zlib"

import type { HistoryEntry } from "~/lib/history/types"
import type { V3TimingSource } from "~/lib/history/v3/store"

import { PATHS } from "~/lib/config/paths"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { recoverProjectedHistoryEntry } from "~/lib/history/v3/recovery"
import {
  //
  commitPreparedOperation,
  ensureV3Schema,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import { initProcessIdentity } from "~/lib/process-identity"

interface Options {
  input: string
  dbPath: string
  dryRun: boolean
  timingOverrides?: string
}

interface TimingOverride {
  endedAt?: number
  durationMs?: number
  source: Extract<V3TimingSource, "terminal-log-rounded">
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let input = ""
  let dbPath = PATHS.HISTORY_V3_DB
  let dryRun = false
  let timingOverrides: string | undefined
  for (const arg of argv) {
    if (arg.startsWith("--input=")) input = arg.slice("--input=".length)
    else if (arg.startsWith("--db=")) dbPath = arg.slice("--db=".length)
    else if (arg.startsWith("--timing-overrides=")) timingOverrides = arg.slice("--timing-overrides=".length)
    else if (arg === "--dry-run") dryRun = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (input.length === 0) throw new Error("--input=/path/recovery.ndjson.gz is required")
  return { input, dbPath, dryRun, ...(timingOverrides === undefined ? {} : { timingOverrides }) }
}

async function loadTimingOverrides(path: string | undefined): Promise<Map<string, TimingOverride>> {
  if (path === undefined) return new Map()
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, { endedAt?: number; durationMs?: number; source?: unknown }>
  const out = new Map<string, TimingOverride>()
  for (const [id, value] of Object.entries(parsed)) {
    if (value.source !== "terminal-log-rounded") throw new Error(`unsupported timing source for ${id}: ${String(value.source)}`)
    if (value.endedAt === undefined && value.durationMs === undefined) throw new Error(`timing override for ${id} needs endedAt or durationMs`)
    out.set(id, { ...value, source: value.source })
  }
  return out
}

function timingFor(entry: HistoryEntry, overrides: Map<string, TimingOverride>): Parameters<typeof prepareModelOperation>[1] {
  const override = overrides.get(entry.id)
  if (override === undefined) return { source: "unavailable" }
  return {
    endedAt: override.endedAt ?? entry.startedAt + (override.durationMs ?? 0),
    source: override.source,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const overrides = await loadTimingOverrides(options.timingOverrides)
  initProcessIdentity("history-v3-projection-recovery")
  if (options.dryRun) openInMemoryDatabase()
  else openDatabase(options.dbPath)
  ensureV3Schema(getDatabase())

  let capturedAt: number | undefined
  let seen = 0
  let imported = 0
  let skipped = 0
  let failed = 0
  const lines = createInterface({ input: createReadStream(options.input).pipe(createGunzip()), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.length === 0) continue
      const envelope = JSON.parse(line) as { type: "header"; capturedAt: number } | { type: "entry"; entry: HistoryEntry }
      if (envelope.type === "header") {
        capturedAt = envelope.capturedAt
        continue
      }
      seen++
      const entry = envelope.entry
      if (entry.operationKind !== undefined && entry.operationKind !== "generation" && entry.operationKind !== "responses_ws") {
        skipped++
        continue
      }
      const existing = getDatabase().prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(entry.id)
      if (existing !== undefined && existing !== null) {
        skipped++
        continue
      }
      try {
        const record = recoverProjectedHistoryEntry(entry, capturedAt ?? 0)
        const prepared = prepareModelOperation(record, timingFor(entry, overrides))
        if (!options.dryRun) commitPreparedOperation(getDatabase(), prepared)
        imported++
      } catch (error) {
        failed++
        consola.error(`[history/v3 recovery] ${entry.id} failed`, error)
      }
      if (seen % 10 === 0) consola.info(`[history/v3 recovery] seen=${seen} imported=${imported} skipped=${skipped} failed=${failed}`)
    }
  } finally {
    closeDatabase()
  }

  const mode = options.dryRun ? "validated" : "imported"
  if (failed > 0) {
    consola.error(`[history/v3 recovery] ${mode}=${imported} skipped=${skipped} failed=${failed}; source file left intact`)
    process.exitCode = 1
  } else {
    consola.success(`[history/v3 recovery] ${mode}=${imported} skipped=${skipped} failed=0; source file left intact`)
  }
}

await main()
