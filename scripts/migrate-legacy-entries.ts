#!/usr/bin/env bun
/**
 * Legacy `entries` (v1 single-blob) → `entries_v2` (v2 head/stage) migration.
 *
 * The v1 history layout stored each request as one row in `entries` with the
 * whole HistoryEntry compressed into a single `blob_gz`. The v2 rewrite moved
 * to `entries_v2` (indexed head row + head-meta blob) plus `entry_stages`
 * (per-leg / per-attempt heavy bodies, with the redundant request bodies packed
 * into one `request_group` zstd frame). The migration that introduced
 * `entries_v2` created the new table but never dropped the old one, so any
 * pre-v2 database keeps a `entries` table that NO code path reads, reaps, or
 * VACUUMs — pure dead weight pinning the file at its high-water mark.
 *
 * This script folds whatever rows remain in `entries` INTO `entries_v2` so they
 * become visible to the UI / `/history/api` (which only ever read `entries_v2`),
 * then drops the legacy table and returns the freed pages to the OS.
 *
 * How the split is reused (no reimplementation):
 *   - `deserializeEntry(row)` recovers the FULL HistoryEntry from a legacy
 *     single-blob row (a v1 row has no stage rows, so the blob IS the entry).
 *   - `insertCompletedEntry(entry)` re-serializes it through the canonical v2
 *     write path → head row + stage rows + request_group frame + session
 *     aggregate, keyed on the SAME id (ON CONFLICT DO UPDATE — idempotent).
 *
 * Safety:
 *   - Idempotent: re-running re-inserts the same ids (DO UPDATE) and then drops
 *     the table; once dropped, a re-run is a no-op ("nothing to migrate").
 *   - The legacy table is dropped ONLY when every row migrated successfully. A
 *     single failure leaves `entries` intact and the run reports it — no data is
 *     lost, re-run after investigating.
 *   - Writes contend with a live server on `entries_v2`; `openDatabase` sets a
 *     5s busy_timeout, so a concurrent write waits rather than failing. The row
 *     count here is small, so lock windows stay short.
 *
 * Usage:
 *   bun run scripts/migrate-legacy-entries.ts              # migrate + drop + reclaim
 *   bun run scripts/migrate-legacy-entries.ts --dry-run    # report only, no writes
 *   bun run scripts/migrate-legacy-entries.ts --keep-table # migrate but leave `entries`
 *   bun run scripts/migrate-legacy-entries.ts --db=/path/db
 */

import consola from "consola"

import { PATHS } from "~/lib/config/paths"
import {
  //
  checkpointWal,
  closeDatabase,
  getDatabase,
  incrementalVacuum,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  deserializeEntry,
  type EntryRow,
} from "~/lib/history/sqlite/serialize"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

interface MigrateOptions {
  dryRun: boolean
  keepTable: boolean
  dbPath: string | null
}

function parseArgs(argv: ReadonlyArray<string>): MigrateOptions {
  let dryRun = false
  let keepTable = false
  let dbPath: string | null = null
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true
    else if (arg === "--keep-table") keepTable = true
    else if (arg.startsWith("--db=")) dbPath = arg.slice("--db=".length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { dryRun, keepTable, dbPath }
}

/** Is the legacy v1 `entries` table present in this database? */
function legacyTableExists(): boolean {
  const db = getDatabase()
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'entries'").get() as { name: string } | undefined
  return row !== undefined
}

/**
 * One legacy `entries` row. Same columns as v2 EXCEPT the process-identity trio
 * (pid / boot_time / git_sha) which v1 never had — they map to null in EntryRow.
 */
interface LegacyRow {
  id: string
  session_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  model: string | null
  endpoint: string | null
  transport: string | null
  status: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
  reasoning_tokens: number | null
  stop_reason: string | null
  error_message: string | null
  message_count: number | null
  preview_text: string | null
  blob_gz: Uint8Array
}

/** Lift a legacy v1 row into the v2 EntryRow shape (process-identity columns → null). */
function toEntryRow(r: LegacyRow): EntryRow {
  return {
    id: r.id,
    session_id: r.session_id,
    agent_id: null,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    model: r.model,
    endpoint: r.endpoint,
    transport: r.transport,
    status: r.status,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read: r.cache_read,
    cache_creation: r.cache_creation,
    reasoning_tokens: r.reasoning_tokens,
    // Legacy v1 rows predate net-of-cache normalization → leave 0 so the
    // usage-normalize-backfill picks them up (OpenAI-family legacy input_tokens
    // still includes cached).
    usage_normalized: 0,
    // Legacy v1 rows are single-blob (no new client/upstream stages) → leave 0 so
    // the legacy-stage-backfill re-serializes them into the new stage shape.
    stages_migrated: 0,
    stop_reason: r.stop_reason,
    error_message: r.error_message,
    message_count: r.message_count,
    preview_text: r.preview_text,
    // Legacy v1 rows have no derived response preview → NULL (→ "" on read).
    response_preview_text: null,
    pid: null,
    boot_time: null,
    git_sha: null,
    pinned: 0,
    // Legacy v1 rows have no byte/multiplier data → NULL (→ undefined on read).
    request_bytes: null,
    response_bytes: null,
    multiplier: null,
    blob_gz: r.blob_gz,
  }
}

function listLegacyRows(): Array<LegacyRow> {
  return getDatabase().prepare("SELECT * FROM entries ORDER BY started_at ASC").all() as Array<LegacyRow>
}

/**
 * Migrate one legacy row into entries_v2 (+ entry_stages). Recovers the full
 * entry from the v1 blob, then re-inserts through the canonical v2 write path.
 * A failure logs + returns "fail" so the caller can keep the legacy table.
 */
async function migrateOne(r: LegacyRow, dryRun: boolean): Promise<"ok" | "fail"> {
  try {
    const entry = deserializeEntry(toEntryRow(r))
    if (!dryRun) await insertCompletedEntry(entry)
    return "ok"
  } catch (err: unknown) {
    consola.warn(`[migrate] row ${r.id} failed:`, err)
    return "fail"
  }
}

/** Drop the legacy table (its indexes drop with it) inside a transaction. */
function dropLegacyTable(): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS entries")
  })
  tx()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.dbPath ?? PATHS.HISTORY_DB
  consola.info(`[migrate] opening ${dbPath}${args.dryRun ? " (dry-run)" : ""}`)
  openDatabase(dbPath)

  try {
    if (!legacyTableExists()) {
      consola.success("[migrate] no legacy `entries` table — nothing to migrate")
      return
    }

    const rows = listLegacyRows()
    consola.info(`[migrate] found ${rows.length} legacy row(s) to fold into entries_v2`)

    let ok = 0
    let fail = 0
    const t0 = Date.now()
    for (const r of rows) {
      if ((await migrateOne(r, args.dryRun)) === "ok") ok++
      else fail++
    }
    consola.info(`[migrate] migrated ok=${ok} fail=${fail} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    if (fail > 0) {
      consola.warn(`[migrate] ${fail} row(s) failed — leaving legacy \`entries\` table INTACT. Investigate and re-run.`)
      return
    }
    if (args.dryRun) {
      consola.info("[migrate] dry-run: legacy table left intact, no rows written")
      return
    }
    if (args.keepTable) {
      consola.info("[migrate] --keep-table: rows migrated, legacy `entries` table left intact")
      return
    }

    dropLegacyTable()
    consola.info("[migrate] dropped legacy `entries` table")

    // Return the just-freed pages to the OS. auto_vacuum=INCREMENTAL moves the
    // dropped table's pages to the freelist; checkpoint first so the WAL frames
    // land, then incremental_vacuum truncates, then checkpoint(TRUNCATE) bounds
    // the WAL back down.
    const db = getDatabase()
    checkpointWal(db)
    incrementalVacuum(db)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
    consola.success(`[migrate] done — ${ok} row(s) now live in entries_v2, legacy table reclaimed`)
  } finally {
    closeDatabase()
  }
}

await main()
