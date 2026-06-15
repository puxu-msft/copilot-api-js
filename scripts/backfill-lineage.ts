#!/usr/bin/env bun
/**
 * Lineage backfill script — compute and persist `entry_lineage` /
 * `entry_produced_tool_ids` rows for every Anthropic entry in the history
 * database that doesn't yet have a digest.
 *
 * Per RFC §4.3:
 * - Idempotent: re-running computes the same digest (deterministic) and
 *   uses INSERT OR REPLACE / INSERT OR IGNORE in the write path, so
 *   running twice is safe.
 * - Cursors through entries_v2.id ORDER BY started_at DESC in batches.
 * - Non-Anthropic entries / entries with no messages get skipped (mirror
 *   computeLineageDigest's null-return contract).
 * - Failed digest compute on a single entry logs + continues; never
 *   blocks the run.
 *
 * Usage:
 *   bun run scripts/backfill-lineage.ts                 # backfill missing
 *   bun run scripts/backfill-lineage.ts --rebuild       # ALSO rewrite
 *                                                        existing digests
 *                                                        (use after a
 *                                                        canonicalization
 *                                                        rule change /
 *                                                        schema_version bump)
 *   bun run scripts/backfill-lineage.ts --dry-run       # don't write
 *   bun run scripts/backfill-lineage.ts --batch=200     # batch size
 *   bun run scripts/backfill-lineage.ts --db=/path/db   # override DB path
 */

import consola from "consola"

import { PATHS } from "~/lib/config/paths"
import {
  //
  computeLineageDigest,
  packTurnHashes,
} from "~/lib/history/lineage"
import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { getEntryById } from "~/lib/history/sqlite/read"

interface BackfillOptions {
  rebuild: boolean
  dryRun: boolean
  batchSize: number
  dbPath: string | null
}

function parseArgs(argv: ReadonlyArray<string>): BackfillOptions {
  let rebuild = false
  let dryRun = false
  let batchSize = 200
  let dbPath: string | null = null
  for (const arg of argv) {
    if (arg === "--rebuild") rebuild = true
    else if (arg === "--dry-run") dryRun = true
    else if (arg.startsWith("--batch=")) batchSize = Number.parseInt(arg.slice("--batch=".length), 10)
    else if (arg.startsWith("--db=")) dbPath = arg.slice("--db=".length)
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`--batch must be a positive integer, got ${batchSize}`)
  }
  return { rebuild, dryRun, batchSize, dbPath }
}

interface IdRow {
  id: string
  has_lineage: number
}

function listEntryIds(rebuild: boolean): Array<string> {
  const db = getDatabase()
  // LEFT JOIN to detect which entries already have a lineage row.
  // Anthropic-only filter (v1 scope); non-Anthropic entries would
  // compute to null anyway and waste reads.
  const rows = db
    .prepare(
      `SELECT e.id, CASE WHEN el.entry_id IS NULL THEN 0 ELSE 1 END AS has_lineage
         FROM entries_v2 e
         LEFT JOIN entry_lineage el ON el.entry_id = e.id
         WHERE e.endpoint = 'anthropic-messages'
         ORDER BY e.started_at DESC`,
    )
    .all() as Array<IdRow>
  if (rebuild) return rows.map((r) => r.id)
  return rows.filter((r) => r.has_lineage === 0).map((r) => r.id)
}

function backfillOne(entryId: string, dryRun: boolean): "ok" | "skip" | "fail" {
  const entry = getEntryById(entryId)
  if (!entry) return "skip"
  let digest
  try {
    digest = computeLineageDigest(entry)
  } catch (err: unknown) {
    consola.warn(`[backfill] compute failed for ${entryId}:`, err)
    return "fail"
  }
  if (!digest) return "skip" // non-Anthropic / no messages
  if (dryRun) return "ok"

  const db = getDatabase()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO entry_lineage
         (entry_id, schema_version, root_hash, turn_hashes_blob, post_response_hash, back_tool_use_id, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entryId, digest.v, digest.rootHash, packTurnHashes(digest.turnHashes), digest.postResponseHash, digest.backToolUseId, digest.computedAt)

    db.prepare("DELETE FROM entry_produced_tool_ids WHERE entry_id = ?").run(entryId)
    if (digest.producedToolUseIds.length > 0) {
      const stmt = db.prepare("INSERT OR IGNORE INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES (?, ?)")
      for (const toolUseId of digest.producedToolUseIds) {
        stmt.run(toolUseId, entryId)
      }
    }
  })
  tx()
  return "ok"
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.dbPath ?? PATHS.HISTORY_DB
  consola.info(`[backfill] opening ${dbPath}${args.dryRun ? " (dry-run)" : ""}${args.rebuild ? " (rebuild mode)" : ""}`)
  openDatabase(dbPath)

  try {
    const ids = listEntryIds(args.rebuild)
    consola.info(`[backfill] found ${ids.length} entries to process (batch=${args.batchSize})`)

    let ok = 0
    let skipped = 0
    let failed = 0
    const t0 = Date.now()
    for (let i = 0; i < ids.length; i += args.batchSize) {
      const batch = ids.slice(i, i + args.batchSize)
      for (const id of batch) {
        const result = backfillOne(id, args.dryRun)
        if (result === "ok") ok++
        else if (result === "skip") skipped++
        else failed++
      }
      const elapsed = Date.now() - t0
      const rate = Math.round((ok + skipped + failed) / Math.max(1, elapsed / 1000))
      consola.info(`[backfill] processed ${i + batch.length}/${ids.length} (ok=${ok} skip=${skipped} fail=${failed}, ${rate}/s)`)
    }
    consola.success(`[backfill] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ok=${ok} skip=${skipped} fail=${failed}`)
  } finally {
    closeDatabase()
  }
}

// Resolve path import statically (no top-level await issues in CLI script).
await main()
