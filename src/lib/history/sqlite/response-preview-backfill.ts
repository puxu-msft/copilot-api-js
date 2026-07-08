/**
 * Recoverable background backfill that computes `response_preview_text` for every
 * historical row whose column is NULL (pre-feature rows). Mirrors the
 * usage-normalize / search-index backfill skeleton: version-guarded, keyset-
 * resumable, cooperatively stoppable, non-blocking, never-throws.
 *
 * Per-row idempotency marker is the `response_preview_text IS NULL` predicate
 * itself (no extra column): a processed row drops out of the scan. Every row
 * written by the current producers is born non-NULL (Task 3), so only pre-feature
 * rows are ever touched. Guard: `history_meta(response_preview_version)`
 * short-circuits once the whole table is done. A row whose blob fails to decode is
 * written "" (never NULL) so it is not re-scanned forever; the version guard still
 * requires a clean full pass.
 *
 * Cooperative shutdown mirrors usage-normalize/search-index: `shutdownHistory`
 * calls `stopResponsePreviewBackfill()` BEFORE `closeDatabase()` (a post-close
 * prepare would throw), and every DB op is under try/catch so a close that races
 * the loop ends gracefully.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import { extractResponsePreviewText } from "~/lib/history/entry-view"

import type { Database } from "./connection"

import {
  //
  getMeta,
  RESPONSE_PREVIEW_CURSOR_KEY,
  RESPONSE_PREVIEW_VERSION,
  RESPONSE_PREVIEW_VERSION_KEY,
  setMeta,
} from "./meta"
import {
  //
  assembleFullEntry,
  type EntryRow,
  type StageRow,
} from "./serialize"

/** Entry batch size; the loop yields to the event loop after each batch. */
const BACKFILL_BATCH_SIZE = 100

/** Checkpoint the WAL every N batches so a long backfill doesn't balloon `-wal`. */
const CHECKPOINT_EVERY_BATCHES = 20

/** Cooperative stop flag (set by stopResponsePreviewBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `shutdownHistory` BEFORE `closeDatabase`. */
export function stopResponsePreviewBackfill(): void {
  stopRequested = true
}

/**
 * Read the stop flag through a function so TS control-flow analysis does not
 * narrow it to a constant `false` inside the loop — it is mutated EXTERNALLY
 * (during an `await`), which flow analysis can't see.
 */
function isStopRequested(): boolean {
  return stopRequested
}

/** Reset module-global backfill state (test isolation — registered in RESETTERS). */
export function resetResponsePreviewBackfillForTests(): void {
  stopRequested = false
  running = false
}

/** One id-scan row: the keyset columns needed to advance the cursor (NOT the blob). */
interface ScanRow {
  id: string
  started_at: number
}

/** Load a row's stage rows so `assembleFullEntry` can reconstruct the full entry. */
function loadStages(db: Database, id: string): Array<StageRow> {
  return db.prepare("SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id = ?").all(id) as Array<StageRow>
}

/**
 * Process one batch: for each scan row, reassemble the full entry (head row +
 * stage rows), extract its response preview, and write it. Per-row try/catch: an
 * undecodable blob is written "" so the row drops out of the IS NULL scan (never
 * re-scanned forever), not left NULL. Mutates counts.
 */
function processBatch(db: Database, scanRows: Array<ScanRow>, counts: { filled: number; errors: number }): void {
  const headSelect = db.prepare("SELECT * FROM entries_v2 WHERE id = ?")
  const update = db.prepare("UPDATE entries_v2 SET response_preview_text = ? WHERE id = ?")
  for (const scan of scanRows) {
    try {
      const row = headSelect.get(scan.id) as EntryRow | undefined
      if (!row) continue
      const entry = assembleFullEntry(row, loadStages(db, scan.id))
      update.run(extractResponsePreviewText(entry), scan.id)
      counts.filled += 1
    } catch (err: unknown) {
      // Undecodable → write "" so the row is not re-scanned forever.
      try {
        update.run("", scan.id)
      } catch {
        // db closing race — leave for the next run.
      }
      counts.errors += 1
      consola.debug(`[response-preview-backfill] skipped entry ${scan.id}`, err)
    }
  }
}

/**
 * Backfill every historical row's `response_preview_text`, once. Guarded by
 * `response_preview_version`; resumable via the cursor; cooperatively stoppable.
 * NEVER throws (background work — an escaped rejection could crash the process).
 */
export async function runResponsePreviewBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, RESPONSE_PREVIEW_VERSION_KEY) === RESPONSE_PREVIEW_VERSION) return

    const cursorRaw = getMeta(db, RESPONSE_PREVIEW_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts = { filled: 0, errors: 0 }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE response_preview_text IS NULL").get() as { n: number }).n

    // Compound (started_at, id) keyset over the NOT-yet-filled rows. As rows flip
    // to non-NULL they drop out of the predicate, so the cursor advances losslessly
    // across ties and restarts.
    const scanStmt = db.prepare(
      "SELECT id, started_at FROM entries_v2 "
        + "WHERE response_preview_text IS NULL AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
    )
    let boundaryTs = cursorTs
    let lastId = ""
    let batchIndex = 0

    for (;;) {
      if (isStopRequested()) break
      let scanRows: Array<ScanRow>
      try {
        scanRows = scanStmt.all(boundaryTs, boundaryTs, lastId, BACKFILL_BATCH_SIZE) as Array<ScanRow>
      } catch (err: unknown) {
        consola.debug("[response-preview-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, RESPONSE_PREVIEW_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[response-preview-backfill] batch failed (db closing?) — stopping", err)
        return
      }

      batchIndex += 1
      if (batchIndex % CHECKPOINT_EVERY_BATCHES === 0) {
        try {
          db.exec("PRAGMA wal_checkpoint(PASSIVE);")
        } catch {
          // best-effort
        }
      }
      if (scanRows.length < BACKFILL_BATCH_SIZE) break // reached the tail
      await sleep(0)
    }

    if (!isStopRequested()) {
      setMeta(db, RESPONSE_PREVIEW_VERSION_KEY, RESPONSE_PREVIEW_VERSION)
      if (total > 0) consola.info(`[response-preview-backfill] complete: filled ${counts.filled}, errors ${counts.errors} (of ${total})`)
    }
  } catch (err: unknown) {
    consola.warn("[response-preview-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
