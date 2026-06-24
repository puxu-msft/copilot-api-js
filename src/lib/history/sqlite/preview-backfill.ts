/**
 * One-time backfill of the denormalized `entries_v2.preview_text` column.
 *
 * `preview_text` is written ONCE at finalize (serialize.ts `serializeHeadEntry`
 * → `extractPreviewText(entry)`) and the list/session read paths read the stored
 * column WITHOUT recomputing. So when `extractPreviewText`'s logic changes, every
 * pre-existing row keeps its STALE preview forever — the user sees the old
 * previews on all historical entries even after a restart. This module recomputes
 * `preview_text` for all existing rows exactly once.
 *
 * Guard: `PRAGMA user_version`. The constant `PREVIEW_LOGIC_VERSION` encodes the
 * current `extractPreviewText` logic generation. A DB whose `user_version` is
 * already ≥ this constant has been backfilled and is skipped. **When you change
 * `extractPreviewText`'s logic again, BUMP `PREVIEW_LOGIC_VERSION` so this
 * backfill re-runs once on the next open.**
 *
 * Only `preview_text` is recomputed — `search_text` (extractSearchText) logic did
 * NOT change, so it is left untouched. The `UPDATE` fires `entries_v2_fts_au`,
 * which re-syncs the external-content FTS index from the new preview_text; this
 * is correct only because the backfill runs AFTER `ensureSearchIndex` has created
 * the FTS table + triggers (see connection.ts wiring).
 */

import consola from "consola"

import { extractPreviewText } from "~/lib/history/in-flight"

import type { Database } from "./connection"

import {
  //
  assembleFullEntry,
  type EntryRow,
  type StageRow,
} from "./serialize"

/**
 * Current generation of `extractPreviewText`'s logic. Stored in the DB via
 * `PRAGMA user_version` after a successful pass so the backfill runs ONCE.
 * BUMP this whenever `extractPreviewText` changes meaningfully — that re-arms the
 * one-time recompute for the new logic on the next `openDatabase`.
 */
const PREVIEW_LOGIC_VERSION = 1

/**
 * Entry-id batch size for the recompute loop. Head rows are loaded all at once
 * (one bounded column), but stage blobs are loaded + decompressed per batch to
 * bound peak memory on a large DB (a single batch's stages are held at a time).
 */
const BACKFILL_BATCH_SIZE = 200

/** Read a single-value PRAGMA as an integer (0 if absent / non-numeric). Local copy — connection.ts's `pragmaInt` is not exported. */
function readPragmaInt(database: Database, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | null
  if (!row) return 0
  const value = Object.values(row)[0]
  return typeof value === "number" ? value : 0
}

/** Load every entry id's stage rows for one batch, grouped by entry_id. */
function loadStagesForBatch(database: Database, ids: Array<string>): Map<string, Array<StageRow>> {
  const map = new Map<string, Array<StageRow>>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = database
    .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id IN (${placeholders})`)
    .all(...ids) as Array<StageRow>
  for (const r of rows) {
    const list = map.get(r.entry_id)
    if (list) list.push(r)
    else map.set(r.entry_id, [r])
  }
  return map
}

interface BackfillCounts {
  recomputed: number
  unchanged: number
  errors: number
}

/**
 * Recompute one batch of head rows in place. Per-entry try/catch: a single
 * corrupt / undecodable blob is counted as an error and skipped — it must NOT
 * abort the whole pass.
 */
function backfillBatch(database: Database, rows: Array<EntryRow>, counts: BackfillCounts): void {
  const ids = rows.map((r) => r.id)
  const stagesById = loadStagesForBatch(database, ids)
  const update = database.prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?")

  for (const row of rows) {
    try {
      const entry = assembleFullEntry(row, stagesById.get(row.id) ?? [])
      const recomputed = extractPreviewText(entry)
      // Stored NULL is treated as "" for the comparison so a row that legitimately
      // recomputes to "" but holds NULL is not counted as a (no-op) change.
      const stored = row.preview_text ?? ""
      if (recomputed === stored) {
        counts.unchanged += 1
        continue
      }
      update.run(recomputed, row.id)
      counts.recomputed += 1
    } catch (err: unknown) {
      // Permanently-bad blob: skip this entry, keep going. The version is still
      // set after the pass so a known-bad row does not force a re-scan every start.
      counts.errors += 1
      consola.debug(`[history/sqlite] preview backfill skipped entry ${row.id} (undecodable)`, err)
    }
  }
}

/**
 * Recompute `preview_text` for all existing rows once, guarded by
 * `PRAGMA user_version`. No-op (silent) when already at / past the current logic
 * version. NEVER throws: backfill is an optimization and must not block
 * `openDatabase` — any top-level failure logs a warning and startup continues
 * (and, crucially, does NOT bump the version, so a transient failure retries on
 * the next open). Per-entry errors are tolerated and DO set the version.
 *
 * Wiring contract: call AFTER `ensureSearchIndex` (the FTS table + triggers must
 * exist so each UPDATE re-syncs FTS from the new preview_text) — see
 * connection.ts `openDatabase`.
 */
export function maybeBackfillPreview(database: Database): void {
  try {
    const current = readPragmaInt(database, "user_version")
    if (current >= PREVIEW_LOGIC_VERSION) return // already backfilled — silent no-op

    const rows = database.prepare("SELECT * FROM entries_v2").all() as Array<EntryRow>
    const counts: BackfillCounts = { recomputed: 0, unchanged: 0, errors: 0 }

    for (let i = 0; i < rows.length; i += BACKFILL_BATCH_SIZE) {
      backfillBatch(database, rows.slice(i, i + BACKFILL_BATCH_SIZE), counts)
    }

    // Set the version after the pass (even with per-entry errors) so the backfill
    // runs ONCE — a permanently-bad blob must not re-scan the whole table every
    // startup. A top-level throw above bypasses this (version unset → retry).
    database.exec(`PRAGMA user_version = ${PREVIEW_LOGIC_VERSION}`)

    consola.info(
      `[history/sqlite] preview backfill: recomputed ${counts.recomputed}, unchanged ${counts.unchanged}, errors ${counts.errors} (of ${rows.length} entries)`,
    )
  } catch (err: unknown) {
    consola.warn("[history/sqlite] preview backfill skipped (error — startup continues)", err)
  }
}
