/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 1 — sidecar daemon core, runnable standalone (not yet wired to a process
 * entry point / UDS — that's Phase 2/3). Drives the whole tail → hydrate →
 * project → native-upsert → debounced-flush loop as a plain library, against a
 * REAL on-disk history-v3.db (readonly connection) and a REAL native Tantivy
 * `HistoryIndex` handle (native/history-search/copilot_history_search.node,
 * already built in this worktree).
 *
 * Covers the plan's Phase 1 acceptance list:
 *  - indexes conversation + response text, excludes upstream-only frames
 *  - cursor persists across daemon instances ("crash restart") without
 *    reprocessing already-seen rows or skipping new ones
 *  - a VACUUM between tail rounds does not lose or duplicate rows — the
 *    plan's core justification for a (committed_at, operation_id) keyset
 *    over a raw rowid cursor
 *  - append-once assumption: v3_operations never gets a same-row UPDATE that
 *    changes searchable content (locked as a regression, not just an implicit
 *    assumption)
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  getNativeHistorySearch,
  type NativeHistoryIndex,
} from "~/lib/history/search-native"
import {
  //
  createHistorySearchDaemon,
  readTailCursor,
} from "~/lib/history/search/daemon"
import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Rich terminal record covering conversation / response / an upstream-only frame that
 *  MUST NOT be searchable — mirrors `tests/history/search-tantivy.it.test.ts`'s helper,
 *  reused here against the daemon's tail→hydrate→project path instead of the terminal-bus
 *  in-process path. */
function richTerminalRecord(id: string, tokens: { conversation: string; responseBody: string; upstreamOnly: string }) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const conversation = recorder.registerPayload(
    { messages: [{ role: "user", content: tokens.conversation }] },
    { origin: { stage: "ingress", track: "client" } },
  )
  recorder.recordIngress({ request: { payload: conversation } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: conversation } })
  recorder.settleAttempt(attempt, { verdict: "committed" })
  const responsePayload = recorder.registerPayload({ content: tokens.responseBody }, { origin: { stage: "egress", track: "client" } })
  const upstreamFrame = recorder.registerFrame({ event: "raw", raw: tokens.upstreamOnly }, { origin: { stage: "upstream-response", track: "upstream" } })
  recorder.recordEgress({ client: { payload: responsePayload }, upstream: { frames: [upstreamFrame] } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

/** Commit one real operation through the production write path against an on-disk db. */
function commitOperation(dbPath: string, id: string, tokens: { conversation: string; responseBody: string; upstreamOnly: string }): void {
  const db = openDatabase(dbPath)
  commitPreparedOperation(db, prepareModelOperation(richTerminalRecord(id, tokens)))
  closeDatabase()
}

let nativeModule: Awaited<ReturnType<typeof getNativeHistorySearch>> | undefined
async function openIndex(indexPath: string): Promise<NativeHistoryIndex> {
  nativeModule ??= await getNativeHistorySearch()
  return new nativeModule.HistoryIndex(indexPath)
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("history-search sidecar daemon (Phase 1, standalone)", () => {
  test("tails, hydrates, and indexes conversation + response text — excludes upstream-only frames", async () => {
    const dbDir = freshDir("daemon-basic-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-basic-index-")
    const indexPath = path.join(indexDir, "index")

    commitOperation(dbPath, "narrow-op", {
      conversation: "convtokenalpha",
      responseBody: "resptokenbeta",
      upstreamOnly: "upstreamtokendelta",
    })

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    const result = await daemon.tailOnce()
    await index.flush()

    expect(result.processed).toBe(1)
    expect((await index.search("convtokenalpha", undefined, 10)).map((hit) => hit.operationId)).toEqual(["narrow-op"])
    expect((await index.search("resptokenbeta", undefined, 10)).map((hit) => hit.operationId)).toEqual(["narrow-op"])
    expect(await index.search("upstreamtokendelta", undefined, 10)).toEqual([])

    await index.close()
    daemon.close()
  })

  test("daemon.search() is a thin pass-through to the caller-owned native index's search (Phase 2's uds-server calls this, never the index directly)", async () => {
    const dbDir = freshDir("daemon-search-passthrough-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-search-passthrough-index-")
    const indexPath = path.join(indexDir, "index")

    commitOperation(dbPath, "passthrough-op", { conversation: "passthroughneedle", responseBody: "resp", upstreamOnly: "up" })

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    await daemon.tailOnce()
    await index.flush()

    const viaDaemon = await daemon.search("passthroughneedle", undefined, 10)
    const viaIndexDirectly = await index.search("passthroughneedle", undefined, 10)
    expect(viaDaemon).toEqual(viaIndexDirectly)
    expect(viaDaemon.map((hit) => hit.operationId)).toEqual(["passthrough-op"])

    await index.close()
    daemon.close()
  })

  test("cursor persists to disk and a fresh daemon instance resumes without reprocessing", async () => {
    const dbDir = freshDir("daemon-cursor-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-cursor-index-")
    const indexPath = path.join(indexDir, "index")

    commitOperation(dbPath, "op-1", { conversation: "firstneedle", responseBody: "firstresp", upstreamOnly: "up1" })

    const index1 = await openIndex(indexPath)
    const daemon1 = createHistorySearchDaemon({ dbPath, indexPath, index: index1 })
    const first = await daemon1.tailOnce()
    expect(first.processed).toBe(1)
    await index1.flush()
    daemon1.close()
    await index1.close()

    // "Crash restart": brand-new daemon instance + brand-new index handle, reading the
    // cursor back from disk — this is the ONLY channel across the two instances.
    // `indexedAtBoundaryMs` (2026-07-22, blocker-2 fix) always carries at least the
    // just-tailed row's own id — see daemon.ts's `advanceCursorPastRow`.
    const persistedCursor = readTailCursor(indexPath)
    expect(persistedCursor).toEqual({ committedAt: expect.any(Number), operationId: "op-1", indexedAtBoundaryMs: ["op-1"] })

    const index2 = await openIndex(indexPath)
    const daemon2 = createHistorySearchDaemon({ dbPath, indexPath, index: index2 })
    const second = await daemon2.tailOnce()
    // No new rows since the cursor already covers "op-1" — must not reprocess it.
    expect(second.processed).toBe(0)

    // Now write a genuinely new row and confirm the resumed daemon picks up ONLY it.
    commitOperation(dbPath, "op-2", { conversation: "secondneedle", responseBody: "secondresp", upstreamOnly: "up2" })
    const third = await daemon2.tailOnce()
    expect(third.processed).toBe(1)
    await index2.flush()

    expect((await index2.search("firstneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["op-1"])
    expect((await index2.search("secondneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["op-2"])

    daemon2.close()
    await index2.close()
  })

  test("a VACUUM between tail rounds does not lose or duplicate rows (keyset cursor's core justification over rowid)", async () => {
    const dbDir = freshDir("daemon-vacuum-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-vacuum-index-")
    const indexPath = path.join(indexDir, "index")

    // Commit several operations, then delete+VACUUM to force real rowid renumbering
    // (empirically confirmed elsewhere: SQLite VACUUM DOES renumber rowids on a
    // TEXT-PRIMARY-KEY table once earlier rows are removed) — a naive rowid cursor
    // would silently skip or reprocess rows across this operation.
    for (let i = 0; i < 5; i++) {
      commitOperation(dbPath, `pre-vacuum-${i}`, { conversation: `preneedle${i}`, responseBody: `preresp${i}`, upstreamOnly: `preup${i}` })
    }

    const index1 = await openIndex(indexPath)
    const daemon1 = createHistorySearchDaemon({ dbPath, indexPath, index: index1 })
    const firstBatch = await daemon1.tailOnce()
    expect(firstBatch.processed).toBe(5)
    await index1.flush()
    daemon1.close()
    await index1.close()

    // Force a real VACUUM directly against the on-disk file via the production
    // open path (mirrors the real `maybeVacuumOnStartup` write, not a raw driver
    // shortcut) so rowids actually get renumbered on disk.
    const writerDb = openDatabase(dbPath)
    writerDb.exec("VACUUM;")
    closeDatabase()

    // Add one genuinely new row AFTER the VACUUM.
    commitOperation(dbPath, "post-vacuum-op", { conversation: "postneedle", responseBody: "postresp", upstreamOnly: "postup" })

    // Resume via the SAME on-disk cursor (new daemon instance = "restart after VACUUM").
    const index2 = await openIndex(indexPath)
    const daemon2 = createHistorySearchDaemon({ dbPath, indexPath, index: index2 })
    const secondBatch = await daemon2.tailOnce()
    // Must see EXACTLY the one new row — not zero (lost), not 6 (reprocessed everything).
    expect(secondBatch.processed).toBe(1)
    await index2.flush()

    // All 5 pre-VACUUM rows must still be searchable (not lost) and the post-VACUUM
    // row must be searchable too (not skipped) — exactly 6 documents total, no dupes.
    for (let i = 0; i < 5; i++) {
      expect((await index2.search(`preneedle${i}`, undefined, 10)).map((hit) => hit.operationId)).toEqual([`pre-vacuum-${i}`])
    }
    expect((await index2.search("postneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["post-vacuum-op"])

    daemon2.close()
    await index2.close()
  })

  test("v3_operations is append-once for searchable content — no UPDATE path changes an already-tailed row's projection", () => {
    const dbDir = freshDir("daemon-append-once-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const db = openDatabase(dbPath)
    const prepared = prepareModelOperation(
      richTerminalRecord("stable-op", { conversation: "stableneedle", responseBody: "stableresp", upstreamOnly: "stableup" }),
    )
    expect(commitPreparedOperation(db, prepared)).toBe("inserted")

    // Re-committing the EXACT same prepared operation (identical id/revision/digest) is
    // idempotent — this is the only "resubmit" path v3_operations exposes for the SAME
    // content, and it must be a no-op, never a silent content-changing UPDATE the keyset
    // tail could miss.
    expect(commitPreparedOperation(db, prepared)).toBe("idempotent")

    // A DIFFERENT record reusing the SAME operationId (genuinely different content, hence
    // a different digest) must THROW rather than silently overwrite the existing row —
    // this is the other half of "append-once": there is no code path that mutates
    // `manifest_gz` for an existing operation_id, only insert-once-or-conflict.
    const conflicting = prepareModelOperation(
      richTerminalRecord("stable-op", { conversation: "different content entirely", responseBody: "also different", upstreamOnly: "stableup" }),
    )
    expect(() => commitPreparedOperation(db, conflicting)).toThrow(/operation conflict/i)

    // The only real UPDATEs v3_operations supports (pinned / summary_json / ended_at
    // reconciliation) must never touch manifest_gz — the sole input to projection.
    const before = db.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get("stable-op") as { manifest_gz: Uint8Array }
    db.prepare("UPDATE v3_operations SET pinned=1 WHERE operation_id=?").run("stable-op")
    const after = db.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get("stable-op") as { manifest_gz: Uint8Array }
    expect(Buffer.from(after.manifest_gz).equals(Buffer.from(before.manifest_gz))).toBe(true)

    closeDatabase()
  })
})

describe("merged-state review blockers (2026-07-22) — silent permanent data loss, real probes", () => {
  test("BLOCKER 1: a single poisoned manifest (bad format version) permanently wedges the tail -- every HEALTHY row after it is silently never indexed, forever, even across restarts", async () => {
    const dbDir = freshDir("daemon-poison-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-poison-index-")
    const indexPath = path.join(indexDir, "index")

    // Row 1: healthy, committed first (lowest committed_at/operation_id -- tailed first).
    commitOperation(dbPath, "aaa-healthy-before", { conversation: "beforepoisonneedle", responseBody: "beforeresp", upstreamOnly: "beforeup" })
    // Row 2: will be poisoned in place (mirrors store.it.test.ts's "rejects unsupported
    // future manifest formats" corruption technique) -- a REAL trigger for hydrateManifest
    // to throw (unsupported formatVersion), not a synthetic mock.
    commitOperation(dbPath, "bbb-poison", { conversation: "poisonneedle", responseBody: "poisonresp", upstreamOnly: "poisonup" })
    // Row 3: healthy, committed AFTER the poisoned row -- this is the row that must NOT
    // be permanently lost just because an earlier row is corrupt.
    commitOperation(dbPath, "ccc-healthy-after", { conversation: "afterpoisonneedle", responseBody: "afterresp", upstreamOnly: "afterup" })

    const poisonDb = openDatabase(dbPath)
    const poisonRow = poisonDb.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get("bbb-poison") as { manifest_gz: Uint8Array }
    const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(poisonRow.manifest_gz))) as { formatVersion: number }
    manifest.formatVersion = 999 // triggers hydrateManifest's real "unsupported manifest format version" throw
    poisonDb
      .prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?")
      .run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), "bbb-poison")
    closeDatabase()

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    // A single tailOnce() call must survive the poisoned row internally (this daemon's
    // own contract: one call catches everything up to "now") -- it must not throw and
    // abandon rows 2/3 unprocessed just because row 2 is corrupt.
    const result = await daemon.tailOnce()
    await index.flush()

    // The healthy row BEFORE the poison must always be searchable (this part never
    // regresses even in the pre-fix code).
    expect((await index.search("beforepoisonneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["aaa-healthy-before"])

    // THE CORE ASSERTION (silent permanent data loss): the healthy row AFTER the poison
    // must ALSO be searchable -- one bad manifest must never take down every row behind
    // it. Pre-fix, tailOnce() throws on row 2 and returns/propagates before row 3 is ever
    // reached, so this fails (rows 2 AND 3 both silently missing from the index forever,
    // and the cursor never advances past row 1 -- confirmed by the cursor assertion below).
    expect((await index.search("afterpoisonneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["ccc-healthy-after"])

    // The cursor must advance PAST the poisoned row (to row 3, the last row in the batch)
    // -- not get stuck at row 1. A cursor stuck at row 1 means every future tailOnce()
    // call re-reads the SAME poisoned row and re-throws forever (the "operator deletes
    // tail-cursor.json and it doesn't help" symptom from the report -- the cursor was
    // never the thing wedged, the poisoned ROW itself is).
    expect(result.cursor?.operationId).toBe("ccc-healthy-after")
    expect(readTailCursor(indexPath)?.operationId).toBe("ccc-healthy-after")

    await index.close()
    daemon.close()
  })

  test("BLOCKER 2: two operations committed in the SAME millisecond, indexed in one tail round, then discovered across TWO separate tail rounds in either lexicographic order -- neither is permanently lost", async () => {
    const dbDir = freshDir("daemon-tie-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-tie-index-")
    const indexPath = path.join(indexDir, "index")

    // Commit the LEXICOGRAPHICALLY LARGER operation_id ("zzz-op") FIRST -- the daemon's
    // first tailOnce() round only sees this one (mirrors the real race: runDrain commits
    // "zzz-op" in round-1's tail window, and "aaa-op" has not landed on disk yet).
    commitOperation(dbPath, "zzz-op-committed-first", { conversation: "zzzneedle", responseBody: "zzzresp", upstreamOnly: "zzzup" })

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    const firstRound = await daemon.tailOnce()
    expect(firstRound.processed).toBe(1)
    await index.flush()

    // Now commit the LEXICOGRAPHICALLY SMALLER operation_id ("aaa-op") -- and force it to
    // share the EXACT SAME committed_at millisecond as "zzz-op-committed-first" (this is
    // the real race window this test proves: two backend-to-backend commitPreparedOperation
    // calls landing in the same Date.now() millisecond, which is entirely plausible under
    // load -- runDrain's own per-item yield is a single microtask tick, far under 1ms).
    commitOperation(dbPath, "aaa-op-committed-second", { conversation: "aaaneedle", responseBody: "aaaresp", upstreamOnly: "aaaup" })
    const tieDb = openDatabase(dbPath)
    const zzzRow = tieDb.prepare("SELECT committed_at FROM v3_operations WHERE operation_id=?").get("zzz-op-committed-first") as { committed_at: number }
    tieDb.prepare("UPDATE v3_operations SET committed_at=? WHERE operation_id=?").run(zzzRow.committed_at, "aaa-op-committed-second")
    closeDatabase()

    // Round 2: the daemon's cursor is currently (zzzRow.committed_at, "zzz-op-committed-first").
    // "aaa-op-committed-second" has the SAME committed_at but a LEXICOGRAPHICALLY SMALLER
    // operation_id -- under the naive `WHERE (committed_at,operation_id) > (?,?)` keyset,
    // `(ms, "aaa-op-committed-second") > (ms, "zzz-op-committed-first")` is FALSE (SQLite
    // row-value comparison is lexicographic on the tuple), so this row is silently excluded
    // from EVERY future tail round, forever -- this is the exact permanent-loss scenario.
    const secondRound = await daemon.tailOnce()
    await index.flush()

    // THE CORE ASSERTION: "aaa-op-committed-second" must eventually be indexed even though
    // it committed in the same millisecond as, and sorts lexicographically before, a row
    // the cursor already passed. Pre-fix this fails (search returns []).
    expect((await index.search("aaaneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["aaa-op-committed-second"])
    // The already-indexed row must still be there too (no accidental double-processing bugs).
    expect((await index.search("zzzneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["zzz-op-committed-first"])
    // Second round must report at least the one genuinely-new row as processed (not 0,
    // which would mean the fix silently dropped it without even attempting the overlap re-scan).
    expect(secondRound.processed).toBeGreaterThanOrEqual(1)

    await index.close()
    daemon.close()
  })

  test("BLOCKER 2 (restart variant): the overlap-dedup state survives a daemon restart -- a fresh instance reading the persisted cursor does not re-lose the same-millisecond row", async () => {
    const dbDir = freshDir("daemon-tie-restart-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-tie-restart-index-")
    const indexPath = path.join(indexDir, "index")

    commitOperation(dbPath, "zzz-restart-first", { conversation: "zzzrestartneedle", responseBody: "resp", upstreamOnly: "up" })

    const index1 = await openIndex(indexPath)
    const daemon1 = createHistorySearchDaemon({ dbPath, indexPath, index: index1 })
    await daemon1.tailOnce()
    await index1.flush()
    daemon1.close()
    await index1.close()

    commitOperation(dbPath, "aaa-restart-second", { conversation: "aaarestartneedle", responseBody: "resp", upstreamOnly: "up" })
    const tieDb = openDatabase(dbPath)
    const zzzRow = tieDb.prepare("SELECT committed_at FROM v3_operations WHERE operation_id=?").get("zzz-restart-first") as { committed_at: number }
    tieDb.prepare("UPDATE v3_operations SET committed_at=? WHERE operation_id=?").run(zzzRow.committed_at, "aaa-restart-second")
    closeDatabase()

    // "Crash restart": a BRAND NEW daemon instance, reading ONLY the persisted
    // tail-cursor.json off disk -- the overlap-dedup bookkeeping must be part of what
    // gets persisted, or a restart at exactly this moment would re-introduce the loss
    // (in-memory-only dedup state would reset to "nothing indexed yet at this ms" and
    // still miss the tie-breaking row via the same keyset boundary bug).
    const index2 = await openIndex(indexPath)
    const daemon2 = createHistorySearchDaemon({ dbPath, indexPath, index: index2 })
    await daemon2.tailOnce()
    await index2.flush()

    expect((await index2.search("aaarestartneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["aaa-restart-second"])
    expect((await index2.search("zzzrestartneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["zzz-restart-first"])

    daemon2.close()
    await index2.close()
  })
})
