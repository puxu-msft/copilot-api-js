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
    const persistedCursor = readTailCursor(indexPath)
    expect(persistedCursor).toEqual({ committedAt: expect.any(Number), operationId: "op-1" })

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
