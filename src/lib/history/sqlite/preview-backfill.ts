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
 *
 * INBOUND-ONLY + BACKGROUND (the cost fix): `extractPreviewText` reads ONLY
 * `inboundRequest.messages`, so this backfill decompresses ONLY each entry's
 * request-side blob — the standalone `inbound_request` stage (in-flight / eager
 * rows) or the `request_group` dedup container (finalized rows, holding only the
 * redundant request bodies) — NEVER the response legs or the (largest by far)
 * `sse_events` stream. Recomputing the full entry per row decompressed gigabytes
 * of unrelated lifecycle data and took minutes on a multi-GB DB. It also runs
 * ASYNC/CHUNKED in the BACKGROUND after the server is listening (see start.ts),
 * yielding to the event loop between batches so it never blocks startup or
 * starves request serving.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import type { HistoryEntry } from "~/lib/history/types"

import { extractPreviewText } from "~/lib/history/in-flight"

import type { Database } from "./connection"

import {
  //
  deserializeEntry,
  type EntryRow,
  extractInboundRequestFromStageBlob,
  STAGE,
} from "./serialize"

/**
 * Current generation of `extractPreviewText`'s logic. Stored in the DB via
 * `PRAGMA user_version` after a successful pass so the backfill runs ONCE.
 * BUMP this whenever `extractPreviewText` changes meaningfully — that re-arms the
 * one-time recompute for the new logic on the next `openDatabase`.
 */
const PREVIEW_LOGIC_VERSION = 1

/**
 * Entry-id batch size for the recompute loop. After each batch the loop yields
 * to the event loop (`await sleep(0)`) so the background pass stays responsive
 * while the server serves requests. Small enough that each batch's
 * inbound_request blobs (the ONLY thing decompressed) bound peak memory.
 */
const BACKFILL_BATCH_SIZE = 50

/** Read a single-value PRAGMA as an integer (0 if absent / non-numeric). Local copy — connection.ts's `pragmaInt` is not exported. */
function readPragmaInt(database: Database, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | null
  if (!row) return 0
  const value = Object.values(row)[0]
  return typeof value === "number" ? value : 0
}

/** One head-id row from the cheap id scan — preview_text only, NOT the head blob. */
interface IdRow {
  id: string
  preview_text: string | null
}

interface BackfillCounts {
  recomputed: number
  unchanged: number
  errors: number
}

/** One inbound-bearing stage row for a batch: the stage name + its compressed blob. */
interface InboundStageRow {
  stage: string
  blob_gz: Uint8Array
}

/**
 * Load the inbound-bearing stage blob for every id in a batch, keyed by entry_id.
 * This is the ONLY decompression-bearing read: ONLY the request-side stages are
 * fetched — the standalone `inbound_request` row (in-flight / eager rows) OR the
 * `request_group` dedup container (finalized rows, which holds the redundant
 * request bodies). NEVER the response or sse_events stages. The blob is left
 * compressed here; decompression happens per-entry in `recomputeBatch` so a
 * single corrupt blob is isolated.
 *
 * Prefer the standalone `inbound_request` row when both exist (it is the exact
 * inboundRequest object — no container decode), else fall back to request_group.
 */
function loadInboundStagesForBatch(database: Database, ids: Array<string>): Map<string, InboundStageRow> {
  const map = new Map<string, InboundStageRow>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = database
    .prepare(
      `SELECT entry_id, stage, blob_gz FROM entry_stages WHERE entry_id IN (${placeholders}) AND stage IN ('${STAGE.inboundRequest}', '${STAGE.requestGroup}') AND attempt_index = -1`,
    )
    .all(...ids) as Array<{ entry_id: string; stage: string; blob_gz: Uint8Array }>
  for (const r of rows) {
    const existing = map.get(r.entry_id)
    // Prefer the standalone inbound_request row over the request_group container.
    if (existing && existing.stage === STAGE.inboundRequest) continue
    map.set(r.entry_id, { stage: r.stage, blob_gz: r.blob_gz })
  }
  return map
}

/**
 * Resolve the `inboundRequest` payload for one entry, decompressing ONLY the
 * inbound (request-side) data:
 *   - Modern (stage-split) rows: the `inbound_request` stage blob — or, for a
 *     finalized row, the inbound_request member of the `request_group` dedup
 *     frame — decompresses to the `inboundRequest` object. The request_group
 *     frame carries only the redundant request bodies, never response / sse, so
 *     this stays inbound-only.
 *   - Legacy (pre-stage-split) rows have NEITHER stage row; their inboundRequest
 *     lives in the head blob. Only for those (rare) do we fetch the head row and
 *     `deserializeEntry` it (which decompresses the head blob and floors
 *     `inboundRequest`).
 */
function resolveInboundRequest(database: Database, id: string, inboundStage: InboundStageRow | undefined): HistoryEntry["inboundRequest"] {
  if (inboundStage) {
    const inbound = extractInboundRequestFromStageBlob(inboundStage.stage, inboundStage.blob_gz)
    if (inbound) return inbound
  }
  // Legacy fallback: no inbound-bearing stage row → inboundRequest is in the head blob.
  const headRow = database.prepare("SELECT * FROM entries_v2 WHERE id = ?").get(id) as EntryRow | null
  if (!headRow) throw new Error(`[history/sqlite] preview backfill: entry ${id} vanished mid-pass`)
  return deserializeEntry(headRow, undefined).inboundRequest
}

/**
 * Recompute one batch of previews in place from inbound-only data. Per-entry
 * try/catch: a single corrupt / undecodable blob is counted as an error and
 * skipped — it must NOT abort the whole pass. Each UPDATE is its own statement
 * (no transaction held across the batch / the inter-batch yield, which would
 * lock writers); it fires `entries_v2_fts_au` to re-sync FTS from the new
 * preview_text.
 */
function recomputeBatch(database: Database, idRows: Array<IdRow>, counts: BackfillCounts): void {
  const ids = idRows.map((r) => r.id)
  const inboundById = loadInboundStagesForBatch(database, ids)
  const update = database.prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?")

  for (const idRow of idRows) {
    try {
      const inboundRequest = resolveInboundRequest(database, idRow.id, inboundById.get(idRow.id))
      const recomputed = extractPreviewText({ inboundRequest })
      // Stored NULL is treated as "" for the comparison so a row that legitimately
      // recomputes to "" but holds NULL is not counted as a (no-op) change.
      const stored = idRow.preview_text ?? ""
      if (recomputed === stored) {
        counts.unchanged += 1
        continue
      }
      update.run(recomputed, idRow.id)
      counts.recomputed += 1
    } catch (err: unknown) {
      // Permanently-bad blob: skip this entry, keep going. The version is still
      // set after the pass so a known-bad row does not force a re-scan every start.
      counts.errors += 1
      consola.debug(`[history/sqlite] preview backfill skipped entry ${idRow.id} (undecodable)`, err)
    }
  }
}

/**
 * Recompute `preview_text` for all existing rows once, guarded by
 * `PRAGMA user_version`. No-op (silent) when already at / past the current logic
 * version.
 *
 * Runs ASYNC + CHUNKED in the BACKGROUND (fired post-listen by start.ts), so it
 * NEVER blocks startup: it processes BACKFILL_BATCH_SIZE rows then `await`s a
 * yield (`sleep(0)`) so the event loop keeps serving requests. NEVER throws — an
 * escaped rejection in background work could crash the process via
 * `unhandledRejection`; the whole body is wrapped and a top-level failure logs a
 * warning and is swallowed (and, crucially, does NOT bump the version, so a
 * transient failure retries on the next open). Per-entry errors are tolerated and
 * DO set the version (a permanently-bad blob must not re-scan every start).
 *
 * INBOUND-ONLY: only each entry's request-side blob is decompressed (standalone
 * `inbound_request` stage or the `request_group` dedup container) — never the
 * response legs or `sse_events`.
 *
 * Wiring contract: call AFTER `ensureSearchIndex` (the FTS table + triggers must
 * exist so each UPDATE re-syncs FTS from the new preview_text).
 */
export async function backfillPreviewInBackground(database: Database): Promise<void> {
  try {
    const current = readPragmaInt(database, "user_version")
    if (current >= PREVIEW_LOGIC_VERSION) return // already backfilled — silent no-op

    // Cheap id scan: id + preview_text ONLY (NOT `SELECT *` — do not pull the
    // head blob_gz). The full id set is small per-row; heavy blobs are loaded
    // per batch and only for the inbound_request stage.
    const idRows = database.prepare("SELECT id, preview_text FROM entries_v2").all() as Array<IdRow>
    const counts: BackfillCounts = { recomputed: 0, unchanged: 0, errors: 0 }

    for (let i = 0; i < idRows.length; i += BACKFILL_BATCH_SIZE) {
      recomputeBatch(database, idRows.slice(i, i + BACKFILL_BATCH_SIZE), counts)
      // Yield between batches so the background pass never starves request
      // serving. No transaction is held across this await (each UPDATE above is
      // its own statement), so writers are never blocked while we yield.
      await sleep(0)
    }

    // Set the version after the pass (even with per-entry errors) so the backfill
    // runs ONCE — a permanently-bad blob must not re-scan the whole table every
    // startup. A top-level throw above bypasses this (version unset → retry).
    database.exec(`PRAGMA user_version = ${PREVIEW_LOGIC_VERSION}`)

    if (idRows.length > 0) {
      consola.info(
        `[history/sqlite] preview backfill: recomputed ${counts.recomputed}, unchanged ${counts.unchanged}, errors ${counts.errors} (of ${idRows.length} entries)`,
      )
    }
  } catch (err: unknown) {
    consola.warn("[history/sqlite] preview backfill skipped (error — startup continues)", err)
  }
}
