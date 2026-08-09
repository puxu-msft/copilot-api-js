/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 1 — the sidecar daemon core: readonly-tail `history-v3.db` -> hydrate the
 * canonical `ModelOperationRecord` from its manifest -> project the searchable
 * text -> upsert into the (already-built, native) Tantivy `HistoryIndex` -> debounced
 * flush. Pure library surface, independently drivable by tests — process entry
 * point / UDS wiring / supervisor land in later phases (P2/P3), NOT here.
 *
 * Cursor discipline (plan "architecture decision 2", REVISED 2026-07-22 after a
 * merged-state review found two silent-permanent-data-loss blockers in the
 * original design -- both confirmed via real probes, not theoretical):
 *
 *  - Keyset `(committed_at, operation_id)`, NEVER a raw rowid. `committed_at` is the
 *    INSERT-time wall clock written by `commitPreparedOperation` (`Date.now()`),
 *    monotonic by construction; `operation_id` was ORIGINALLY meant to "break ties
 *    within the same millisecond" -- BUT `operation_id` is a random UUID, entirely
 *    unrelated to commit ORDER. A naive `WHERE (committed_at,operation_id) > (?,?)`
 *    keyset boundary is therefore a row-value (lexicographic tuple) comparison: if
 *    the cursor lands on `(ms, "zzz...")` and a DIFFERENT row committed in the SAME
 *    millisecond happens to have a lexicographically SMALLER operation_id (e.g.
 *    "aaa..."), `(ms, "aaa...") > (ms, "zzz...")` is FALSE forever after -- that row
 *    is silently excluded from every future tail round, permanently. (A raw rowid
 *    cursor would ALSO silently skip/reprocess rows across a `VACUUM` -- SQLite's own
 *    docs: VACUUM "may" renumber rowids on a table without an INTEGER PRIMARY KEY,
 *    confirmed empirically to actually happen here -- which is why rowid was
 *    rejected in the first place; the fix below does not reopen that hole.)
 *
 *    THE FIX (user-directed root-cause repair, keeps the sidecar-side-only
 *    decoupling -- zero authoritative-schema changes, main process still carries
 *    zero search burden): `tailOnce()` runs in TWO passes. Pass 1 ("boundary
 *    re-scan") re-queries EXACTLY the cursor's `committed_at` millisecond with
 *    `AND operation_id NOT IN <indexedAtBoundaryMs>` until nothing new turns up
 *    (provably terminating -- see the code comment at its call site: each
 *    iteration folds newly-seen ids into the persisted exclusion set, so the
 *    candidate pool strictly shrinks and cannot cycle). Pass 2 (the ordinary
 *    forward loop) then queries everything with `committed_at > cursor.
 *    committedAt` -- a plain monotonic filter, since pass 1 already fully
 *    resolved the tie-breaking millisecond, there is no same-millisecond hazard
 *    left for pass 2 to worry about. The cursor additionally persists the set of
 *    operation_ids already indexed AT the boundary millisecond
 *    (`indexedAtBoundaryMs`) so this re-scan does not re-report already-seen rows
 *    as newly processed. Once `committed_at` advances past the boundary
 *    millisecond, this set resets to just the new row (it only ever needs to
 *    remember ONE millisecond's membership, not an unboundedly-growing history)
 *    — persisted into `tail-cursor.json` so a restart mid-millisecond does not
 *    reopen the same loss window (a purely in-memory dedup set would reset on
 *    restart and re-lose the tie-breaking row at the exact same boundary).
 *    `HistoryIndex.upsert` is delete-then-add idempotent, so even a hypothetical
 *    re-upsert of an already-indexed row would be a harmless no-op -- the
 *    exclusion set is a correctness+termination mechanism, not merely an
 *    optimization.
 *
 *    NOTE (explicitly out of scope, unchanged precondition): this construction
 *    assumes `committed_at` is monotonic non-decreasing across commits, which in
 *    turn assumes the system clock never moves backward between two
 *    `commitPreparedOperation` calls (`Date.now()` is not itself guaranteed
 *    monotonic across an NTP step-back). A genuine backward clock jump could still
 *    theoretically violate the ordering this scheme depends on -- this is a
 *    pre-existing assumption inherited from the original design, not something
 *    this fix introduces or resolves.
 *
 *  - append-once premise: `v3_operations` never gets an UPDATE that changes
 *    `manifest_gz` (the sole input to `projectSearchableText`) for an already-committed
 *    row -- `commitPreparedOperation` only INSERTs once per operation_id and treats a
 *    resubmit as either `idempotent` (identical digest, no-op) or a thrown conflict
 *    (never a silent overwrite). So a keyset tail can never miss a "content-changing
 *    revision" because there is no such revision. Locked as a regression in
 *    `tests/history/search/daemon.it.test.ts`.
 *
 * Poison-row isolation (2026-07-22, the SECOND merged-state review blocker): a
 * single row whose manifest cannot be hydrated (a real trigger: an unsupported/
 * future manifest format version, a missing CAS object, an incomplete sequence --
 * `hydrateManifest`/`v3/store.ts` throws on all three) used to propagate straight
 * out of `tailOnce()`'s per-row loop, aborting the ENTIRE round -- every row after
 * the poisoned one in that batch (and every batch after it, forever, since the
 * cursor never advanced past it) was silently never indexed. Deleting
 * `tail-cursor.json` did not help: the poison is IN THE ROW ITSELF, not the
 * cursor. Mirrors this project's established poison-isolation discipline (skill
 * `persistence-async-invariants`; `telemetry/store.ts`'s `computeTierSketchBlob`
 * read-merge-serialize poison isolation): each row's hydrate+project+upsert is
 * individually try/caught; a poisoned row is COUNTED (`poisoned`) and logged
 * (rate-limited per operation_id -- see `createPoisonLogDeduper` below -- so a
 * permanently-poisoned row does not spam the log every tail tick forever), but the
 * cursor STILL ADVANCES past it and the loop continues to the next row. A search
 * request for a poisoned operation degrades to "not indexed" (same never-throw
 * contract the rest of this out-of-process design already guarantees end to end),
 * not "the whole sidecar's index silently stops growing".
 *
 * Autocommit discipline (plan warning, reviewed): each tail round issues ONE
 * `SELECT ... LIMIT n` as an independent readonly statement -- there is NEVER a
 * long-lived open transaction (`BEGIN`) held across a round. A long snapshot would
 * pin the primary writer's WAL at that point forever, starving its PASSIVE
 * checkpoints (`checkpointWal` in connection.ts) and letting the -wal file grow
 * unboundedly. This module deliberately has no `db.transaction(...)` anywhere.
 */

import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import type {
  //
  NativeHistoryIndex,
  NativeHistoryListSearchRequest,
  NativeHistoryListSearchResult,
  TantivySearchHit,
} from "~/lib/history/search-native"
import type {
  //
  HistorySearchListRequest,
  HistorySearchListResponse,
} from "~/lib/history/search/protocol"
import type { Database } from "~/lib/history/sqlite/connection"

import { openDatabaseReadonly } from "~/lib/history/sqlite/connection"
import {
  //
  projectSearchableText,
  recordToEntrySummary,
} from "~/lib/history/v3/projection"
import { hydrateManifest } from "~/lib/history/v3/store"

/**
 * Keyset tail cursor -- the LAST row this daemon has successfully upserted (not
 * flushed; flush is a separate, cheaper commit boundary). `null`/absent means "tail
 * from the very beginning".
 *
 * `indexedAtBoundaryMs` (2026-07-22, blocker-2 fix): the set of `operation_id`s
 * already indexed AT the `committedAt` boundary millisecond -- see the module doc's
 * "overlap re-scan" explanation. Persisted (not just kept in memory) so a restart
 * exactly at a tie-breaking boundary does not reopen the same loss window. Always
 * a small, bounded set (only ever the rows sharing ONE millisecond -- cleared the
 * moment `committedAt` advances past it, see `advanceCursorPastRow` below), never
 * unboundedly growing.
 */
export interface TailCursor {
  committedAt: number
  operationId: string
  indexedAtBoundaryMs?: Array<string>
  /** Poisoned rows already crossed by this durable index frontier. Kept for strict freshness attestation across restarts. */
  poisoned?: Array<{ operationId: string; committedAt: number }>
  /**
   * `IndexGeneration.opstamp` of the index commit this cursor was published against
   * (`search-native.ts`). Binds the cursor to the index that produced it — see
   * `validateCursorAgainstIndex` below. Absent only in cursors written before this
   * binding existed, which are treated as unverifiable and therefore discarded.
   */
  indexOpstamp?: number
}

const CURSOR_FILE_NAME = "tail-cursor.json"

/**
 * Run a list search, re-labelling a rejected query string as `invalid-query`.
 *
 * The native module reports a query Tantivy's parser refuses as `Status::InvalidArg`, which napi
 * surfaces as `code: "InvalidArg"` (measured — see `exp/history-search-list-perf/parse-error-probe.ts`).
 * Without this distinction the caller could only see "the sidecar threw", so a user typing `error:`
 * or a leading `-` into a free-text search box took the whole listing down with a 503, in-flight
 * rows and all. It is a bad request, and the code says so.
 */
async function listSearchOrInvalidQuery(index: NativeHistoryIndex, request: NativeHistoryListSearchRequest): Promise<NativeHistoryListSearchResult> {
  try {
    return await index.listSearch(request)
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "InvalidArg") {
      throw Object.assign(new Error(`Unsupported search query: ${error.message}`), { code: "invalid-query" as const })
    }
    throw error
  }
}

function cursorPath(indexPath: string): string {
  return path.join(indexPath, CURSOR_FILE_NAME)
}

/**
 * Read the persisted tail cursor for a given index directory. Returns `null` when
 * absent (fresh index -- tail from the start) or corrupt (never-throw: a damaged
 * cursor file must degrade to "re-tail from the beginning", not crash the daemon --
 * duplicate upserts are idempotent via `HistoryIndex::upsert`'s delete-then-add, so a
 * full re-tail is safe, merely slower).
 */
export function readTailCursor(indexPath: string): TailCursor | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cursorPath(indexPath), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return null
    const raw = parsed as Record<string, unknown>
    if (typeof raw.committedAt !== "number" || typeof raw.operationId !== "string") return null
    const indexedAtBoundaryMs =
      Array.isArray(raw.indexedAtBoundaryMs) && raw.indexedAtBoundaryMs.every((id) => typeof id === "string") ? raw.indexedAtBoundaryMs : undefined
    const poisoned =
      (
        Array.isArray(raw.poisoned)
        && raw.poisoned.every(
          (entry: unknown) =>
            typeof entry === "object"
            && entry !== null
            && typeof (entry as { operationId?: unknown }).operationId === "string"
            && typeof (entry as { committedAt?: unknown }).committedAt === "number",
        )
      ) ?
        (raw.poisoned as Array<{ operationId: string; committedAt: number }>)
      : undefined
    return {
      committedAt: raw.committedAt,
      operationId: raw.operationId,
      ...(indexedAtBoundaryMs ? { indexedAtBoundaryMs } : {}),
      ...(poisoned ? { poisoned } : {}),
      ...(typeof raw.indexOpstamp === "number" ? { indexOpstamp: raw.indexOpstamp } : {}),
    }
  } catch {
    return null // ENOENT / corrupt JSON / missing fields -- treat as "no cursor yet".
  }
}

/**
 * Persist the tail cursor atomically (write-to-tmp then rename -- mirrors
 * `src/lib/restart/pidfile.ts`'s `writePidfile`), so a crash mid-write can never
 * leave a half-written cursor file for the next restart to choke on. Never-throw: a
 * failed cursor write only means the NEXT tail round re-processes a bit more (still
 * idempotent), not a hard daemon failure.
 */
export function writeTailCursor(indexPath: string, cursor: TailCursor): void {
  try {
    fs.mkdirSync(indexPath, { recursive: true })
    const target = cursorPath(indexPath)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cursor), "utf8")
    fs.renameSync(tmp, target)
  } catch (error) {
    consola.warn(`[history-search-daemon] failed to persist tail cursor (non-fatal -- next round re-tails further back): ${indexPath}`, error)
  }
}

export interface HistorySearchDaemonOptions {
  /** Path to the on-disk `history-v3.db` to tail readonly. */
  dbPath: string
  /** Path to the Tantivy index directory (also where the tail cursor is persisted). */
  indexPath: string
  /** Already-constructed native index handle (caller owns its lifecycle: flush/close). */
  index: NativeHistoryIndex
  /** Rows fetched per tail round. */
  pageSize?: number
}

export interface TailRoundResult {
  /** Number of operations upserted into the index this round. */
  processed: number
  /** Number of rows this round encountered whose manifest could not be hydrated
   *  (unsupported format version, missing CAS object, incomplete sequence) --
   *  skipped, never indexed, but the tail advances past them regardless (see
   *  module doc's "Poison-row isolation"). */
  poisoned: number
  /** Cursor AFTER this round (persisted to disk); `null` if nothing has ever been tailed. */
  cursor: TailCursor | null
}

const DEFAULT_PAGE_SIZE = 256

interface TailRow {
  operation_id: string
  committed_at: number
  kind: string
  created_at: number
  manifest_gz: Uint8Array
}

/**
 * Rate-limit repeated poison-row log lines (2026-07-22, review "minor" follow-up):
 * a permanently-poisoned row would otherwise re-log its failure EVERY tail tick
 * (every `TAIL_INTERVAL_MS`, forever) since the tail cursor now legitimately
 * advances past it every round is a NEW round that re-tails from a cursor already
 * past it -- wait, more precisely: once skipped, a poisoned row is never
 * re-visited by a LATER round (the cursor is already past it) EXCEPT during the
 * SAME round it was first seen retried via `WHERE > cursor` still returning it if
 * the page boundary lands mid-poison -- in practice this set only needs to
 * suppress a poisoned id from being logged more than once per daemon instance
 * lifetime (cheap, small, process-lifetime `Set`, not persisted -- a restart
 * logging it once again is fine and arguably useful).
 */
function createPoisonLogDeduper(): (operationId: string, error: unknown) => void {
  const alreadyWarned = new Set<string>()
  return (operationId: string, error: unknown): void => {
    if (alreadyWarned.has(operationId)) return
    alreadyWarned.add(operationId)
    consola.warn(
      `[history-search-daemon] skipping unindexable operation ${operationId} (manifest could not be hydrated -- `
        + `this row will never be searchable, but the tail advances past it; further occurrences of this SAME `
        + `operation are logged only once per daemon lifetime):`,
      error,
    )
  }
}

/**
 * One independently-drivable sidecar daemon instance. Construction does NOT open a
 * database connection eagerly (`readonlyDb` is created lazily on first `tailOnce`) so
 * a caller building a daemon before `history-v3.db` exists (an ordering race the real
 * process entry point / supervisor must tolerate, P2/P3) does not fail at construction
 * time -- only a `tailOnce()` call needs the file to exist.
 */
export interface HistorySearchDaemon {
  /**
   * Run ONE tail round: read the persisted cursor, SELECT the next page of rows
   * strictly after it (single autocommit statement, no open transaction), hydrate +
   * project + upsert each into the native index, then persist the new cursor. Loops
   * internally until a page comes back short of `pageSize` (i.e. drains everything
   * currently available), so one call always catches the daemon fully up to "now".
   *
   * Does NOT call `index.flush()` -- flush cadence (debounce/batch) is the caller's
   * concern (mirrors `search-tantivy.ts`'s split between upsert and flush).
   */
  tailOnce: () => Promise<TailRoundResult>
  /** Current staged cursor, including upserts not yet durably flushed to Tantivy. */
  getCursor: () => TailCursor | null
  /** Last cursor whose corresponding index writes have durably flushed. */
  getFlushedCursor: () => TailCursor | null
  /** Flush the caller-owned index, then publish exactly the staged cursor captured before that flush. */
  flush: () => Promise<void>
  /** Release the daemon's own readonly db handle (does NOT touch `options.index` --
   *  the caller constructed it and owns its flush/close lifecycle). */
  close: () => void
  /**
   * Thin pass-through to the caller-owned native index's `search` (Phase 2's
   * `uds-server.ts` calls this instead of reaching into `options.index` directly, so
   * the transport layer stays agnostic of native-module shape). Does NOT tail/flush
   * first -- the caller decides tail/flush cadence independently of query cadence.
   */
  search: (query: string, operationKind: string | undefined, limit: number) => Promise<Array<TantivySearchHit>>
  /** Strict list search against the durably flushed index frontier. Throws while lagging. */
  listSearch: (request: HistorySearchListRequest) => Promise<HistorySearchListResponse["listSearch"]>
}

/**
 * Construct a standalone sidecar daemon. Pure library surface -- no process
 * lifecycle, no UDS, no supervisor (those are Phase 2/3). The caller supplies an
 * already-open native `HistoryIndex` handle (constructed via
 * `getNativeHistorySearch()` + `new native.HistoryIndex(indexPath)`) so this module
 * stays agnostic of native-module loading/caching policy.
 */
export function createHistorySearchDaemon(options: HistorySearchDaemonOptions): HistorySearchDaemon {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  let readonlyDb: Database | undefined
  let cursor: TailCursor | null = readTailCursor(options.indexPath)
  let flushedCursor: TailCursor | null = cursor
  const warnPoisonOnce = createPoisonLogDeduper()

  /**
   * Cursor↔index binding (A3 review finding 6). The persisted cursor is this daemon's
   * claim about what the index ALREADY holds, and `listSearch` turns that claim into the
   * freshness attestation the main process trusts to serve a strict, "complete or 503"
   * search. Nothing tied the two together, so an index that no longer matched its cursor
   * could certify itself complete and answer with a confident empty page.
   *
   * Two paths reach that state with the cursor file still in place (both verified against
   * the native layer, `native/history-search/src/lib.rs`): `open_index` falls back to
   * `Index::create_in_dir` — a brand-new EMPTY index — when `Index::open_in_dir` fails on
   * damaged metadata, and an index directory can be restored from an older snapshot while
   * the newer cursor survives. A FORMAT-marker bump is not one of them: `assert_identity`
   * wipes the whole directory, cursor included, and a non-empty directory it does not own
   * is refused outright.
   *
   * So the cursor is checked against the index's own commit state before anything uses
   * it. Both signals move one way within a single index's life, which is what makes them
   * comparable across restarts: `opstamp` only grows (commits, background merges), and an
   * index that has been tailed never falls back to zero documents. Failing either check
   * means this is not the index the cursor described — drop it, re-tail from the
   * beginning (upserts are delete-then-add idempotent), and let `listSearch` keep
   * refusing until the frontier has been rebuilt and flushed.
   *
   * Scope: this validates the cursor THIS process inherited from disk, once. An index
   * swapped underneath a running daemon is a different failure — one its own writer
   * surfaces directly on the next flush — not something a startup check can cover.
   */
  let cursorValidation: Promise<void> | undefined

  async function validateCursorAgainstIndex(): Promise<void> {
    const claimed = cursor
    if (claimed === null) return
    const generation = await options.index.generation()
    const rebuilt = claimed.indexOpstamp === undefined || generation.docCount === 0 || generation.opstamp < claimed.indexOpstamp
    if (!rebuilt) return
    consola.warn(
      `[history-search-daemon] discarding a tail cursor that outlived its index: the cursor claims committed_at=${claimed.committedAt} `
        + `at index opstamp=${claimed.indexOpstamp ?? "unrecorded"}, but the index reports opstamp=${generation.opstamp} `
        + `docCount=${generation.docCount}. Re-tailing from the beginning; strict list-search stays unavailable until it catches up.`,
    )
    cursor = null
    flushedCursor = null
  }

  function ensureCursorMatchesIndex(): Promise<void> {
    cursorValidation ??= validateCursorAgainstIndex().catch((error: unknown) => {
      // A failure to READ the index is an infra fault, not a verdict on the cursor —
      // clear the memo so the next round retries rather than treating an unchecked
      // cursor as validated.
      cursorValidation = undefined
      throw error
    })
    return cursorValidation
  }

  function db(): Database {
    // Constructed lazily (see interface doc) and cached for the daemon's lifetime --
    // one long-lived readonly connection tails many rounds; each round is still its
    // own independent autocommit statement (never a held BEGIN) against it.
    readonlyDb ??= openDatabaseReadonly(options.dbPath)
    return readonlyDb
  }

  /**
   * Advance the in-memory cursor past a just-processed row, maintaining
   * `indexedAtBoundaryMs` (blocker-2 fix): when the new row's `committed_at`
   * strictly advances past the previous cursor's millisecond, the boundary set
   * resets to `[row.operation_id]` (a fresh boundary millisecond, nothing else
   * seen at it yet); when it is the SAME millisecond as the current cursor, the
   * row's id is ADDED to the existing set rather than replacing it (both rows at
   * this millisecond must be remembered as indexed, or the overlap re-scan would
   * not fully believe either one is done).
   */
  function advanceCursorPastRow(row: TailRow, isPoisoned = false): void {
    const sameMillisecondAsCursor = cursor !== null && cursor.committedAt === row.committed_at
    const indexedAtBoundaryMs = sameMillisecondAsCursor ? [...(cursor?.indexedAtBoundaryMs ?? []), row.operation_id] : [row.operation_id]
    const poisoned = cursor?.poisoned ?? []
    const nextPoisoned =
      isPoisoned && !poisoned.some((entry) => entry.operationId === row.operation_id) ?
        [...poisoned, { operationId: row.operation_id, committedAt: row.committed_at }]
      : poisoned
    cursor = {
      committedAt: row.committed_at,
      operationId: row.operation_id,
      indexedAtBoundaryMs,
      ...(nextPoisoned.length > 0 ? { poisoned: nextPoisoned } : {}),
    }
  }

  /**
   * Fully drain every row sharing the cursor's EXACT `committed_at` millisecond
   * (blocker-2 fix, and its 2026-07-22 pagination follow-up -- see module doc).
   * Repeatedly queries `committed_at = ? AND operation_id NOT IN (<already-seen>)`
   * until nothing new turns up -- PROVABLY terminating, since every iteration that
   * finds any rows immediately folds their ids into `indexedAtBoundaryMs` (via
   * `advanceCursorPastRow`, called from `processRow`), so the very next query's
   * `NOT IN` excludes them: the candidate pool strictly shrinks every iteration and
   * cannot cycle, regardless of how many rows share one millisecond or how small
   * `pageSize` is relative to that count. Safe and cheap to call even when nothing
   * remains at the boundary (a no-op single query returning zero rows) -- callers
   * do not need to first check whether a drain is "needed".
   *
   * Used in TWO places: once as pass 1 (re-checking a PRE-EXISTING cursor's
   * boundary millisecond, in case rows landed there since the last call), and
   * again inside pass 2's forward loop after every FULL page (in case a page
   * boundary itself cut a millisecond in half -- pageSize rows fitting exactly at
   * a millisecond with MORE unprocessed rows at that same millisecond still to
   * come is otherwise silently left for a LATER `tailOnce()` call's pass 1 to
   * pick up, breaking this function's own documented "one call always catches up
   * fully" contract). Defined INSIDE `tailOnce()` (not a sibling closure) since it
   * needs that call's own `connection` and `processRow` (each `tailOnce()` call
   * accumulates its own `processed`/`poisoned` counters).
   */
  async function tailOnce(): Promise<TailRoundResult> {
    await ensureCursorMatchesIndex()
    const connection = db()
    let processed = 0
    let poisoned = 0

    async function processRow(row: TailRow): Promise<void> {
      let document: Parameters<NativeHistoryIndex["upsertSummary"]>[0]
      try {
        const record = hydrateManifest(connection, row.manifest_gz)
        const content = projectSearchableText(record)
        const summary = recordToEntrySummary(record)
        document = {
          operationId: row.operation_id,
          operationKind: row.kind,
          createdAt: row.created_at,
          committedAt: row.committed_at,
          content,
          endpoint: summary.endpoint,
          state: summary.state,
          pid: summary.pid,
          sessionId: summary.sessionId,
          agentId: summary.agentId,
          requestModel: summary.requestModel,
          responseModel: summary.responseModel,
        }
      } catch (error) {
        // Only canonical hydrate/projection failures are row-local poison. A native
        // index write failure is an infrastructure failure and must abort the round
        // before the cursor advances, so a later retry cannot silently skip the row.
        poisoned++
        warnPoisonOnce(row.operation_id, error)
        advanceCursorPastRow(row, true)
        return
      }
      await options.index.upsertSummary(document)
      processed++
      advanceCursorPastRow(row)
    }

    async function drainBoundaryMillisecond(): Promise<void> {
      if (cursor === null) return
      for (;;) {
        const excluded = cursor.indexedAtBoundaryMs ?? []
        const boundaryRows = (
          excluded.length > 0 ?
            connection
              .prepare(
                `SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations WHERE committed_at = ? AND operation_id NOT IN (${excluded.map(() => "?").join(",")}) ORDER BY operation_id LIMIT ?`,
              )
              .all(cursor.committedAt, ...excluded, pageSize)
          : connection
              .prepare("SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations WHERE committed_at = ? ORDER BY operation_id LIMIT ?")
              .all(cursor.committedAt, pageSize)) as Array<TailRow>
        if (boundaryRows.length === 0) break
        for (const row of boundaryRows) await processRow(row)
        if (boundaryRows.length < pageSize) break
      }
    }

    // PASS 1 -- boundary re-scan (blocker-2 fix). Only runs when there IS a cursor
    // (a fresh tail has no boundary millisecond to re-check). Drains every row that
    // shares the cursor's EXACT `committed_at` millisecond and is not yet recorded in
    // `indexedAtBoundaryMs` -- a later-committing row at that same millisecond whose
    // operation_id sorts lexicographically BEFORE the cursor's would otherwise be
    // permanently invisible to a plain `>` tuple comparison (see module doc).
    await drainBoundaryMillisecond()

    // PASS 2 -- the normal forward page loop. Everything queried here is STRICTLY
    // AFTER the boundary millisecond (pass 1 already fully drained it, and every
    // FULL page below re-drains its own new boundary before continuing -- see the
    // 2026-07-22 pagination fix below), so the simple monotonic `committed_at >
    // cursor.committedAt` filter has no same-millisecond tie-break hazard left --
    // `operation_id` is only used to ORDER the page deterministically, never as
    // part of the boundary comparison. Loops until a page comes back short of
    // `pageSize` -- drains everything currently committed, not just one page, so a
    // single `tailOnce()` call always catches up fully (the caller does not need
    // to know how many rounds "catching up" takes).
    for (;;) {
      const rows = (
        cursor === null ?
          connection
            .prepare("SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations ORDER BY committed_at,operation_id LIMIT ?")
            .all(pageSize)
        : connection
            .prepare(
              "SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations WHERE committed_at > ? ORDER BY committed_at,operation_id LIMIT ?",
            )
            .all(cursor.committedAt, pageSize)) as Array<TailRow>
      if (rows.length === 0) break
      for (const row of rows) await processRow(row)
      if (rows.length < pageSize) break
      // 2026-07-22 pagination fix (merged-state review major -- "tailOnce() single-
      // call full catch-up" contract, honored not just documented): a FULL page
      // (exactly `pageSize` rows) may have been cut off mid-millisecond -- more rows
      // could share the LAST processed row's exact `committed_at` but not have fit
      // in this page. Without this drain, they would be silently left for a LATER
      // `tailOnce()` call's pass 1 to discover -- which is correct eventually, but
      // breaks the "one call always catches up fully" guarantee this function
      // documents and callers (status reporting, tests) rely on. Cheap when nothing
      // remains (a single no-op query).
      await drainBoundaryMillisecond()
    }

    return { processed, poisoned, cursor }
  }

  function getCursor(): TailCursor | null {
    return cursor
  }

  function getFlushedCursor(): TailCursor | null {
    return flushedCursor
  }

  async function flush(): Promise<void> {
    const cursorToPublish = cursor
    await options.index.flush()
    if (cursorToPublish === null) return
    // Stamp the cursor with the commit it was published against, so a later process can
    // tell this index from a rebuilt one (see `validateCursorAgainstIndex`).
    const generation = await options.index.generation()
    const published: TailCursor = { ...cursorToPublish, indexOpstamp: generation.opstamp }
    flushedCursor = published
    writeTailCursor(options.indexPath, published)
  }

  function close(): void {
    readonlyDb?.close()
    readonlyDb = undefined
  }

  function search(query: string, operationKind: string | undefined, limit: number): Promise<Array<TantivySearchHit>> {
    return options.index.search(query, operationKind, limit)
  }

  async function listSearch(request: HistorySearchListRequest): Promise<HistorySearchListResponse["listSearch"]> {
    await ensureCursorMatchesIndex()
    const frontier = flushedCursor
    const targetCovered =
      frontier !== null
      && (frontier.committedAt > request.target.committedAt
        || (frontier.committedAt === request.target.committedAt
          && request.target.operationIdsAtBoundary.every((operationId) => frontier.indexedAtBoundaryMs?.includes(operationId))))
    if (!targetCovered) {
      throw new Error(
        `[history-search-daemon] index has not reached frozen target committed_at=${request.target.committedAt} boundary=${request.target.operationIdsAtBoundary.join(",")}`,
      )
    }
    const poison = (frontier.poisoned ?? []).filter(
      (entry) =>
        entry.committedAt < request.target.committedAt
        || (entry.committedAt === request.target.committedAt && request.target.operationIdsAtBoundary.includes(entry.operationId)),
    )
    const result = await listSearchOrInvalidQuery(options.index, {
      query: request.query,
      operationKinds: request.filters.operationKinds,
      endpoint: request.filters.endpoint,
      states: request.filters.states ?? [],
      pid: request.filters.pid,
      sessionId: request.filters.sessionId,
      agentId: request.filters.agentId,
      mainAgentOnly: request.filters.mainAgentOnly,
      model: request.filters.model,
      from: request.filters.from,
      to: request.filters.to,
      targetCommittedAt: request.target.committedAt,
      targetOperationIds: request.target.operationIdsAtBoundary,
      cursorStartedAt: request.cursor?.startedAt,
      cursorOperationId: request.cursor?.operationId,
      cursorRequireMatch: request.cursor?.requireMatch,
      direction: request.cursor?.direction ?? "older",
      limit: request.limit,
    })
    if (result.invalidCursor) {
      throw Object.assign(new Error(`Unknown or filtered summary cursor: ${request.cursor?.operationId ?? "unknown"}`), { code: "invalid-cursor" as const })
    }
    const { invalidCursor: _invalidCursor, ...page } = result
    return {
      ...page,
      attestation: {
        committedAt: frontier.committedAt,
        indexedAtBoundaryMs: frontier.indexedAtBoundaryMs ?? [],
        poison,
      },
    }
  }

  return { tailOnce, getCursor, getFlushedCursor, flush, close, search, listSearch }
}
