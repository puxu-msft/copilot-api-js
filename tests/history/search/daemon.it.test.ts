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
import { isNativeHistorySearchAvailable } from "~/lib/history/search-native"
import {
  //
  createHistorySearchDaemon,
  readTailCursor,
  writeTailCursor,
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

// The native Tantivy `.node` is a gitignored build product and is no longer built by `bun install`
// (2026-07-28). These suites drive the real index, so they gate on its presence rather than fail:
// an environmental red is too easy to wave away as "pre-existing" — which is exactly what happened.
// Run them for real with `bun run build:history-search` first (CI's `test:ci` does).
const NATIVE = isNativeHistorySearchAvailable()

describe("history-search tail publication boundary", () => {
  test("does not publish the tail cursor before the caller durably flushes the index", async () => {
    const dbPath = path.join(freshDir("daemon-publication-db-"), "history-v3.db")
    const indexPath = path.join(freshDir("daemon-publication-index-"), "index")
    commitOperation(dbPath, "publication-op", { conversation: "publicationneedle", responseBody: "resp", upstreamOnly: "up" })

    const staged: Array<string> = []
    let committedDocs = 0
    let opstamp = 0
    const index: NativeHistoryIndex = {
      async upsert(operationId) {
        staged.push(operationId)
      },
      async upsertSummary(document) {
        staged.push(document.operationId)
      },
      async flush() {
        // Mirror the native protocol rather than being friendlier than it: a commit
        // publishes what was staged and advances the index's own opstamp, which is what
        // the tail cursor records to prove it still describes THIS index.
        committedDocs = staged.length
        opstamp += 1
      },
      async search() {
        return []
      },
      async listSearch() {
        return { operationIds: [], total: 0, hasOlder: false, hasNewer: false, invalidCursor: false }
      },
      async generation() {
        return { docCount: committedDocs, opstamp }
      },
      async close() {},
    }
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    const result = await daemon.tailOnce()

    expect(staged).toEqual(["publication-op"])
    expect(result.cursor?.operationId).toBe("publication-op")
    expect(readTailCursor(indexPath)).toBeNull()

    await daemon.flush()
    expect(readTailCursor(indexPath)?.operationId).toBe("publication-op")

    daemon.close()
  })
})

describe.skipIf(!NATIVE)("history-search native list-search", () => {
  test("returns the full filtered match set in stable newest-first tuple order with exact total", async () => {
    const indexPath = path.join(freshDir("native-list-search-index-"), "index")
    const index = await openIndex(indexPath)
    const extended = index as NativeHistoryIndex & {
      upsertSummary: (document: Record<string, unknown>) => Promise<void>
      listSearch: (request: Record<string, unknown>) => Promise<{ operationIds: Array<string>; total: number; hasOlder: boolean; hasNewer: boolean }>
    }

    expect(extended.upsertSummary).toBeFunction()
    expect(extended.listSearch).toBeFunction()
    await extended.upsertSummary({
      operationId: "op-a",
      operationKind: "generation",
      createdAt: 100,
      committedAt: 10,
      content: "native list needle",
      endpoint: "anthropic-messages",
      state: "completed",
      sessionId: "s1",
      requestModel: "model-a",
    })
    await extended.upsertSummary({
      operationId: "op-b",
      operationKind: "generation",
      createdAt: 100,
      committedAt: 11,
      content: "native list needle",
      endpoint: "anthropic-messages",
      state: "failed",
      sessionId: "s1",
      requestModel: "model-b",
    })
    await extended.upsertSummary({
      operationId: "op-c",
      operationKind: "count_tokens",
      createdAt: 101,
      committedAt: 11,
      content: "native list needle",
      endpoint: "anthropic-messages",
      state: "completed",
      sessionId: "s1",
      requestModel: "model-a",
    })
    await index.flush()

    const result = await extended.listSearch({
      query: "native list needle",
      operationKinds: ["generation"],
      states: [],
      endpoint: "anthropic-messages",
      sessionId: "s1",
      model: "model",
      targetCommittedAt: 11,
      targetOperationIds: ["op-b", "op-c"],
      direction: "older",
      limit: 10,
    })
    expect(result).toEqual({ operationIds: ["op-b", "op-a"], total: 2, hasOlder: false, hasNewer: false, invalidCursor: false })

    await index.close()
  })

  /**
   * A re-indexed operation must appear exactly once, carrying its NEW field values — the
   * read path evaluates filters against columnar fast fields, so a stale version surviving
   * anywhere would show up as a duplicate id or a match on a superseded `state`.
   *
   * What this does NOT cover: the alive-bitset branch in `list_search_blocking`. Probed
   * against tantivy 0.26.1, this write pattern materializes the delete during the commit
   * (live segments report `deletes: null`), so the superseded document is physically gone
   * rather than tombstoned, and disabling that branch leaves this test green. See the
   * comment on `let alive = ...` for why the branch is kept regardless.
   */
  test("returns only the surviving version of a re-indexed operation, across segment boundaries", async () => {
    const indexPath = path.join(freshDir("native-list-supersede-index-"), "index")
    const index = await openIndex(indexPath)
    const extended = index as NativeHistoryIndex & {
      upsertSummary: (document: Record<string, unknown>) => Promise<void>
      listSearch: (request: Record<string, unknown>) => Promise<{ operationIds: Array<string>; total: number }>
    }
    const base = { operationKind: "generation", createdAt: 100, committedAt: 10, content: "supersede needle", sessionId: "s1" }

    await extended.upsertSummary({ ...base, operationId: "op-a", state: "streaming" })
    await index.flush()
    // Second segment: the delete lands as a tombstone over segment one's document.
    await extended.upsertSummary({ ...base, operationId: "op-a", state: "completed" })
    await index.flush()

    const query = {
      query: "supersede needle",
      operationKinds: [],
      states: [] as Array<string>,
      targetCommittedAt: 10,
      targetOperationIds: ["op-a"],
      direction: "older",
      limit: 10,
    }
    expect(await extended.listSearch(query)).toMatchObject({ operationIds: ["op-a"], total: 1 })
    // The superseded document's state must not remain matchable.
    expect(await extended.listSearch({ ...query, states: ["streaming"] })).toMatchObject({ operationIds: [], total: 0 })
    expect(await extended.listSearch({ ...query, states: ["completed"] })).toMatchObject({ operationIds: ["op-a"], total: 1 })

    await index.close()
  })

  /**
   * Optional fields produce no columnar column at all in a segment where no document
   * carried them, which is distinct from "the column exists and every value differs".
   * Both must read as "absent", and neither may raise.
   */
  test("evaluates filters over fields absent from every document in the segment", async () => {
    const indexPath = path.join(freshDir("native-list-absent-index-"), "index")
    const index = await openIndex(indexPath)
    const extended = index as NativeHistoryIndex & {
      upsertSummary: (document: Record<string, unknown>) => Promise<void>
      listSearch: (request: Record<string, unknown>) => Promise<{ operationIds: Array<string>; total: number }>
    }
    const base = { operationKind: "generation", committedAt: 10, content: "absent needle" }

    // No document here carries pid; only one carries agentId.
    await extended.upsertSummary({ ...base, operationId: "op-main", createdAt: 100 })
    await extended.upsertSummary({ ...base, operationId: "op-sub", createdAt: 101, agentId: "agent-1" })
    await index.flush()

    const query = {
      query: "absent needle",
      operationKinds: [],
      states: [],
      targetCommittedAt: 10,
      targetOperationIds: ["op-main", "op-sub"],
      direction: "older",
      limit: 10,
    }
    expect(await extended.listSearch({ ...query, pid: 4242 })).toMatchObject({ operationIds: [], total: 0 })
    expect(await extended.listSearch({ ...query, mainAgentOnly: true })).toMatchObject({ operationIds: ["op-main"], total: 1 })
    expect(await extended.listSearch({ ...query, agentId: "agent-1" })).toMatchObject({ operationIds: ["op-sub"], total: 1 })
    expect(await extended.listSearch({ ...query, agentId: "agent-absent" })).toMatchObject({ operationIds: [], total: 0 })

    await index.close()
  })

  /** Each filter that is pushed into the query must still select exactly what the
   *  per-document filter selects — a pushed clause may narrow the candidate set, never the
   *  result set. */
  test("selects the same set whether a filter is answered by the index or per document", async () => {
    const indexPath = path.join(freshDir("native-list-pushdown-index-"), "index")
    const index = await openIndex(indexPath)
    const extended = index as NativeHistoryIndex & {
      upsertSummary: (document: Record<string, unknown>) => Promise<void>
      listSearch: (request: Record<string, unknown>) => Promise<{ operationIds: Array<string>; total: number }>
    }
    const base = { createdAt: 100, committedAt: 10, content: "pushdown needle" }
    await extended.upsertSummary({
      ...base,
      operationId: "op-1",
      operationKind: "generation",
      state: "completed",
      endpoint: "anthropic-messages",
      pid: 11,
      sessionId: "s1",
      requestModel: "claude-opus-4",
    })
    await extended.upsertSummary({
      ...base,
      operationId: "op-2",
      operationKind: "count_tokens",
      state: "failed",
      endpoint: "openai-responses",
      pid: 22,
      sessionId: "s2",
      responseModel: "gpt-5",
    })
    await index.flush()

    const query = {
      query: "pushdown needle",
      operationKinds: [] as Array<string>,
      states: [] as Array<string>,
      targetCommittedAt: 10,
      targetOperationIds: ["op-1", "op-2"],
      direction: "older",
      limit: 10,
    }
    expect(await extended.listSearch({ ...query, operationKinds: ["count_tokens"] })).toMatchObject({ operationIds: ["op-2"], total: 1 })
    expect(await extended.listSearch({ ...query, operationKinds: ["generation", "count_tokens"] })).toMatchObject({ total: 2 })
    expect(await extended.listSearch({ ...query, states: ["failed"] })).toMatchObject({ operationIds: ["op-2"], total: 1 })
    expect(await extended.listSearch({ ...query, endpoint: "anthropic-messages" })).toMatchObject({ operationIds: ["op-1"], total: 1 })
    expect(await extended.listSearch({ ...query, pid: 22 })).toMatchObject({ operationIds: ["op-2"], total: 1 })
    expect(await extended.listSearch({ ...query, sessionId: "s1" })).toMatchObject({ operationIds: ["op-1"], total: 1 })
    // Substring, case-insensitive, over either model field — never pushed into the query.
    expect(await extended.listSearch({ ...query, model: "OPUS" })).toMatchObject({ operationIds: ["op-1"], total: 1 })
    expect(await extended.listSearch({ ...query, model: "gpt" })).toMatchObject({ operationIds: ["op-2"], total: 1 })
    // A value no document carries selects nothing rather than everything.
    expect(await extended.listSearch({ ...query, sessionId: "s-absent" })).toMatchObject({ operationIds: [], total: 0 })

    await index.close()
  })

  /**
   * Operation ids are resolved from the term dictionary in one batched pass over ASCENDING
   * term ordinals, which is NOT the order the documents were visited in. Each resolved id
   * must land back on its own candidate.
   *
   * The fixture needs enough documents to matter: one `flush()` spreads documents across
   * several segments (measured — 3 documents produce three 1-document segments, 30 produce
   * 28/1/1), and a segment holding a single survivor maps trivially no matter how wrong the
   * mapping code is. Twelve documents put ten of them in one segment, with ids whose
   * lexicographic order is the exact REVERSE of their `created_at` order, so a mis-mapping
   * inverts the page instead of hiding.
   */
  test("pairs each batched-resolved operation id with its own document", async () => {
    const indexPath = path.join(freshDir("native-list-ordinal-map-index-"), "index")
    const index = await openIndex(indexPath)
    const extended = index as NativeHistoryIndex & {
      upsertSummary: (document: Record<string, unknown>) => Promise<void>
      listSearch: (request: Record<string, unknown>) => Promise<{ operationIds: Array<string>; total: number }>
    }
    const count = 12
    const ids = Array.from({ length: count }, (_, i) => `op-${String(count - 1 - i).padStart(2, "0")}`)
    for (const [i, operationId] of ids.entries()) {
      await extended.upsertSummary({
        operationId,
        operationKind: "generation",
        createdAt: 1000 - i,
        committedAt: 10,
        content: "ordinal needle",
      })
    }
    await index.flush()

    const query = {
      query: "ordinal needle",
      operationKinds: [],
      states: [],
      targetCommittedAt: 10,
      targetOperationIds: ids,
      direction: "older",
      limit: 100,
    }
    // Newest first by created_at, which is exactly the insertion order and the reverse of
    // the ordinal order the ids were resolved in.
    expect(await extended.listSearch(query)).toMatchObject({ operationIds: ids, total: count })
    // Paging pins the pairing rather than just the id set: the first page must be the id
    // whose OWN created_at is the largest, and the cursor must carry over to the next one.
    expect(await extended.listSearch({ ...query, limit: 1 })).toMatchObject({ operationIds: [ids[0]], total: count })
    expect(await extended.listSearch({ ...query, limit: 1, cursorStartedAt: 1000, cursorOperationId: ids[0] })).toMatchObject({
      operationIds: [ids[1]],
      total: count,
    })

    await index.close()
  })
})

describe.skipIf(!NATIVE)("history-search daemon freshness attestation", () => {
  test("accepts a covered frozen target and rejects a target beyond the durable flushed frontier", async () => {
    const dbPath = path.join(freshDir("daemon-attestation-db-"), "history-v3.db")
    const indexPath = path.join(freshDir("daemon-attestation-index-"), "index")
    commitOperation(dbPath, "attested-op", { conversation: "attestedneedle", responseBody: "resp", upstreamOnly: "up" })
    const db = openDatabase(dbPath)
    const row = db.prepare("SELECT committed_at FROM v3_operations WHERE operation_id=?").get("attested-op") as { committed_at: number }
    closeDatabase()

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    await daemon.tailOnce()
    await daemon.flush()

    const covered = await daemon.listSearch({
      type: "list-search",
      query: "attestedneedle",
      filters: { operationKinds: ["generation"] },
      limit: 10,
      target: { committedAt: row.committed_at, operationIdsAtBoundary: ["attested-op"] },
    })
    expect(covered.operationIds).toEqual(["attested-op"])
    expect(covered.attestation).toEqual({ committedAt: row.committed_at, indexedAtBoundaryMs: ["attested-op"], poison: [] })

    await expect(
      daemon.listSearch({
        type: "list-search",
        query: "attestedneedle",
        filters: { operationKinds: ["generation"] },
        limit: 10,
        target: { committedAt: row.committed_at + 1, operationIdsAtBoundary: ["future-op"] },
      }),
    ).rejects.toThrow(/has not reached frozen target/)

    daemon.close()
    await index.close()
  })

  test("reports a poisoned operation within the frozen target instead of certifying a complete empty result", async () => {
    const dbPath = path.join(freshDir("daemon-attestation-poison-db-"), "history-v3.db")
    const indexPath = path.join(freshDir("daemon-attestation-poison-index-"), "index")
    commitOperation(dbPath, "attested-poison", { conversation: "poisonattestationneedle", responseBody: "resp", upstreamOnly: "up" })
    const poisonDb = openDatabase(dbPath)
    const poisonRow = poisonDb.prepare("SELECT manifest_gz,committed_at FROM v3_operations WHERE operation_id=?").get("attested-poison") as {
      manifest_gz: Uint8Array
      committed_at: number
    }
    const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(poisonRow.manifest_gz))) as { formatVersion: number }
    manifest.formatVersion = 999
    poisonDb
      .prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?")
      .run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), "attested-poison")
    closeDatabase()

    const index = await openIndex(indexPath)
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    await daemon.tailOnce()
    await daemon.flush()

    const result = await daemon.listSearch({
      type: "list-search",
      query: "poisonattestationneedle",
      filters: { operationKinds: ["generation"] },
      limit: 10,
      target: { committedAt: poisonRow.committed_at, operationIdsAtBoundary: ["attested-poison"] },
    })
    expect(result.operationIds).toEqual([])
    expect(result.attestation.poison).toEqual([{ operationId: "attested-poison", committedAt: poisonRow.committed_at }])

    daemon.close()
    await index.close()
  })
})

describe.skipIf(!NATIVE)("history-search cursor is bound to the index that produced it", () => {
  test("a cursor that outlived its index cannot certify the rebuilt one — while an intact index keeps its cursor", async () => {
    const dbPath = path.join(freshDir("daemon-generation-db-"), "history-v3.db")
    const indexPath = path.join(freshDir("daemon-generation-index-"), "index")
    commitOperation(dbPath, "generation-op", { conversation: "generationneedle", responseBody: "resp", upstreamOnly: "up" })
    const db = openDatabase(dbPath)
    const row = db.prepare("SELECT committed_at FROM v3_operations WHERE operation_id=?").get("generation-op") as { committed_at: number }
    closeDatabase()
    const request = {
      type: "list-search" as const,
      query: "generationneedle",
      filters: { operationKinds: ["generation"] },
      limit: 10,
      target: { committedAt: row.committed_at, operationIdsAtBoundary: ["generation-op"] },
    }

    const first = await openIndex(indexPath)
    const building = createHistorySearchDaemon({ dbPath, indexPath, index: first })
    await building.tailOnce()
    await building.flush()
    building.close()
    await first.close()
    expect(readTailCursor(indexPath)?.indexOpstamp).toBeGreaterThan(0)

    // Positive control FIRST: a restart over the intact index must keep its cursor and
    // attest immediately, with no re-tail. Without this, the rejection below would also
    // be satisfied by a binding that simply distrusts every restart.
    const intact = await openIndex(indexPath)
    const restarted = createHistorySearchDaemon({ dbPath, indexPath, index: intact })
    expect((await restarted.listSearch(request)).operationIds).toEqual(["generation-op"])
    restarted.close()
    await intact.close()

    // The failure the binding exists for, reproduced through a path the native layer
    // actually takes: with Tantivy's `meta.json` damaged, `open_index` falls back to
    // `Index::create_in_dir` — a brand-new EMPTY index — while FORMAT and the cursor file
    // survive. (Wiping the directory outright is NOT this case: the native refuses a
    // non-empty directory it does not own, and a FORMAT bump deletes the cursor with it.)
    fs.rmSync(path.join(indexPath, "meta.json"), { force: true })
    expect(readTailCursor(indexPath)?.operationId).toBe("generation-op")

    const rebuilt = await openIndex(indexPath)
    const afterRebuild = createHistorySearchDaemon({ dbPath, indexPath, index: rebuilt })
    await expect(afterRebuild.listSearch(request)).rejects.toThrow(/has not reached frozen target/)

    // …and it recovers by re-tailing, rather than staying refused forever.
    await afterRebuild.tailOnce()
    await afterRebuild.flush()
    expect((await afterRebuild.listSearch(request)).operationIds).toEqual(["generation-op"])

    afterRebuild.close()
    await rebuilt.close()
  })
})

describe("history-search cursor without a recorded index opstamp", () => {
  test("re-tails from the beginning instead of trusting a cursor it cannot check", async () => {
    const dbPath = path.join(freshDir("daemon-legacy-cursor-db-"), "history-v3.db")
    const indexPath = path.join(freshDir("daemon-legacy-cursor-index-"), "index")
    commitOperation(dbPath, "legacy-op", { conversation: "legacyneedle", responseBody: "resp", upstreamOnly: "up" })
    // A cursor written before the binding existed: it claims a frontier past this row.
    writeTailCursor(indexPath, { committedAt: Date.now() + 60_000, operationId: "legacy-op", indexedAtBoundaryMs: ["legacy-op"] })

    const staged: Array<string> = []
    const index: NativeHistoryIndex = {
      async upsert(operationId) {
        staged.push(operationId)
      },
      async upsertSummary(document) {
        staged.push(document.operationId)
      },
      async flush() {},
      async search() {
        return []
      },
      async listSearch() {
        return { operationIds: [], total: 0, hasOlder: false, hasNewer: false, invalidCursor: false }
      },
      // A healthy-looking index — documents present, opstamp far ahead — so the discard
      // below can only come from the cursor being uncheckable, not from the index.
      async generation() {
        return { docCount: 5, opstamp: 99 }
      },
      async close() {},
    }

    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index })
    await daemon.tailOnce()

    expect(staged).toEqual(["legacy-op"])
    daemon.close()
  })
})

describe.skipIf(!NATIVE)("history-search sidecar daemon (Phase 1, standalone)", () => {
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
    await daemon1.flush()
    daemon1.close()
    await index1.close()

    // "Crash restart": brand-new daemon instance + brand-new index handle, reading the
    // cursor back from disk — this is the ONLY channel across the two instances.
    // `indexedAtBoundaryMs` (2026-07-22, blocker-2 fix) always carries at least the
    // just-tailed row's own id — see daemon.ts's `advanceCursorPastRow`.
    const persistedCursor = readTailCursor(indexPath)
    // `indexOpstamp` (2026-08-08) binds the cursor to the index commit that published it —
    // see daemon.ts's `validateCursorAgainstIndex`. It is part of the cross-instance
    // channel this test pins, so it is asserted here rather than loosened away.
    expect(persistedCursor).toEqual({
      committedAt: expect.any(Number),
      operationId: "op-1",
      indexedAtBoundaryMs: ["op-1"],
      indexOpstamp: expect.any(Number),
    })

    const index2 = await openIndex(indexPath)
    const daemon2 = createHistorySearchDaemon({ dbPath, indexPath, index: index2 })
    const second = await daemon2.tailOnce()
    // No new rows since the cursor already covers "op-1" — must not reprocess it.
    expect(second.processed).toBe(0)

    // Now write a genuinely new row and confirm the resumed daemon picks up ONLY it.
    commitOperation(dbPath, "op-2", { conversation: "secondneedle", responseBody: "secondresp", upstreamOnly: "up2" })
    const third = await daemon2.tailOnce()
    expect(third.processed).toBe(1)
    await daemon2.flush()

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
    await daemon1.flush()
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
    await daemon2.flush()

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

describe.skipIf(!NATIVE)("merged-state review blockers (2026-07-22) — silent permanent data loss, real probes", () => {
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
    await daemon.flush()

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
    await daemon.flush()

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
    await daemon.flush()

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
    await daemon1.flush()
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
    await daemon2.flush()

    expect((await index2.search("aaarestartneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["aaa-restart-second"])
    expect((await index2.search("zzzrestartneedle", undefined, 10)).map((hit) => hit.operationId)).toEqual(["zzz-restart-first"])

    daemon2.close()
    await index2.close()
  })

  test("BLOCKER 2 (page-boundary follow-up, 2026-07-22 merged-state review major): THREE same-millisecond rows, with pageSize smaller than that count, are ALL indexed by a SINGLE tailOnce() call -- not left for a second call to finish", async () => {
    const dbDir = freshDir("daemon-tie-page-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const indexDir = freshDir("daemon-tie-page-index-")
    const indexPath = path.join(indexDir, "index")

    // Three operation_ids in strict lexicographic order -- with pageSize:2 (below),
    // a page-oblivious pass-2 loop grabs exactly ["op-a","op-b"] on its first (and
    // only, since 2 === pageSize triggers "keep going") full page, leaving "op-c"
    // (the same millisecond's third row) for whatever tail round comes next. THE
    // CORE ASSERTION this test locks in: a single tailOnce() call must not leave
    // ANY same-millisecond row for later -- the interface's own documented "one
    // call always catches up fully" contract, honored rather than merely written.
    commitOperation(dbPath, "op-a", { conversation: "pageboundaryneedleA", responseBody: "respA", upstreamOnly: "upA" })
    commitOperation(dbPath, "op-b", { conversation: "pageboundaryneedleB", responseBody: "respB", upstreamOnly: "upB" })
    commitOperation(dbPath, "op-c", { conversation: "pageboundaryneedleC", responseBody: "respC", upstreamOnly: "upC" })

    // Force all three onto the EXACT SAME committed_at millisecond (real sequential
    // commits could occasionally collide on their own, but this test must not
    // depend on that timing luck -- mirrors the existing BLOCKER 2 tests' technique).
    const tieDb = openDatabase(dbPath)
    const anchor = tieDb.prepare("SELECT committed_at FROM v3_operations WHERE operation_id=?").get("op-a") as { committed_at: number }
    tieDb.prepare("UPDATE v3_operations SET committed_at=? WHERE operation_id IN ('op-b','op-c')").run(anchor.committed_at)
    closeDatabase()

    const index = await openIndex(indexPath)
    // pageSize:2 -- strictly fewer than the 3 same-millisecond rows, so the fix
    // under test (drainBoundaryMillisecond() called after every FULL page, not
    // just once as pass 1) is the ONLY thing standing between this test passing
    // and a page boundary silently splitting the millisecond across two rounds.
    const daemon = createHistorySearchDaemon({ dbPath, indexPath, index, pageSize: 2 })

    // ONE tailOnce() call -- deliberately not looped, not retried, not followed by
    // a second call before asserting. This is the exact distinction from the
    // pre-existing BLOCKER 2 tests above, which explicitly split the tie-breaking
    // discovery across TWO separate tailOnce() calls (correct for THAT scenario --
    // a row committed strictly after the first round began). This test's row is
    // committed BEFORE `tailOnce()` is ever called even once, so a single call
    // finishing incompletely would be a REGRESSION of the "one call always
    // catches up fully" contract, not an acceptable multi-round scenario.
    const result = await daemon.tailOnce()
    await daemon.flush()

    expect(result.processed).toBe(3)
    expect((await index.search("pageboundaryneedleA", undefined, 10)).map((hit) => hit.operationId)).toEqual(["op-a"])
    expect((await index.search("pageboundaryneedleB", undefined, 10)).map((hit) => hit.operationId)).toEqual(["op-b"])
    // THE row a page-oblivious fix would have left behind for a SECOND tailOnce() call.
    expect((await index.search("pageboundaryneedleC", undefined, 10)).map((hit) => hit.operationId)).toEqual(["op-c"])

    await index.close()
    daemon.close()
  })
})
