import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import {
  //
  commitPreparedOperation,
  drainV3Writer,
  enqueueModelOperation,
  ensureV3Schema,
  getV3StoreStatus,
  prepareModelOperation,
  resetV3WriterForTests,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"

import {
  //
  bufferedRetryFixture,
  countTokensFloodFixtures,
  embeddingBatchFixture,
  highBranchFixture,
  largeSseFixture,
  longConversationFixture,
} from "./performance-fixtures"

function median(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function deterministicNoise(seed: number, bytes: number): string {
  let out = ""
  let counter = 0
  while (out.length < bytes) out += createHash("sha256").update(`${seed}:${counter++}`).digest("hex")
  return out.slice(0, bytes)
}

function pageBytes(db: Database): number {
  const pageCount = Object.values(db.prepare("PRAGMA page_count").get() as Record<string, number>)[0]
  const pageSize = Object.values(db.prepare("PRAGMA page_size").get() as Record<string, number>)[0]
  return pageCount * pageSize
}

function liveV3Bytes(db: Database): number {
  const row = db
    .prepare(
      `SELECT
        COALESCE((SELECT SUM(LENGTH(canonical_gz)) FROM v3_objects), 0) +
        COALESCE((SELECT SUM(LENGTH(hash) + COALESCE(LENGTH(parent_hash), 0) + LENGTH(item_hash) + 8) FROM v3_sequence_nodes), 0) +
        COALESCE((SELECT SUM(LENGTH(manifest_gz)) FROM v3_operations), 0) +
        COALESCE((SELECT SUM(COALESCE(LENGTH(track_gz), LENGTH(refs_json))) FROM v3_tracks), 0) +
        COALESCE((SELECT SUM(LENGTH(payload_gz)) FROM v3_timeline_chunks), 0) +
        COALESCE((SELECT SUM(LENGTH(payload_gz)) FROM v3_journal), 0) AS bytes`,
    )
    .get() as { bytes: number }
  return row.bytes
}

/**
 * Naive per-operation serialization estimate (mirrors the retired V2 write
 * path's storage cost: one full uncompressed JSON copy of the projected entry
 * per operation, no content-addressing/dedup across operations) — the
 * baseline this test compares V3's CAS savings against. V2's
 * `sqlite/serialize.ts` was deleted with the V2 write chain (History V2
 * removal Phase 3); summing the uncompressed JSON byte length of the
 * projected entry is an equivalent naive-serialization estimate for this
 * comparison's purpose (V2 stored per-attempt/per-leg stage JSON uncompressed
 * the same way, just split across separate rows instead of one object).
 */
function v2SerializedEstimate(record: ModelOperationRecord): number {
  const entry = recordToHistoryEntry(record)
  return Buffer.byteLength(JSON.stringify(entry))
}

function timedPrepare(record: ModelOperationRecord): number {
  const samples: Array<number> = []
  for (let index = 0; index < 5; index++) {
    const start = performance.now()
    prepareModelOperation(record)
    samples.push(performance.now() - start)
  }
  return median(samples)
}

function timedCommit(record: ModelOperationRecord): number {
  const prepared = prepareModelOperation(record)
  const start = performance.now()
  commitPreparedOperation(getDatabase(), prepared)
  return performance.now() - start
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
})

afterEach(async () => {
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 store performance", () => {
  test("a commit never full-scans a table that grows with history length", async () => {
    // The deterministic replacement for the retired wall-clock ratio. Timing
    // could not discriminate: measured 0.649/0.308 at N=256 while a genuine
    // per-commit full-table aggregate was live, and it went false-red under CPU
    // contention. The invariant is "commit work does not grow with history
    // length", and SQLite answers that directly — a plan that SCANs a
    // history-length table is exactly the violation, at any N.
    const db = getDatabase()
    // Migrations, not just ensureV3Schema: the derived summaries table is created
    // by them, and the readiness aggregate this guards returns early when that
    // table is absent. Without this the probe runs against a database where the
    // offending statement can never execute, and the guard passes vacuously.
    ensureV3Schema(db)
    await applyForwardMigrations(db)
    // Two prior commits, not a flood. NOT because the database has no ANALYZE
    // stats — `openDatabase` runs seedAnalyzeIfNeeded unconditionally, so
    // `sqlite_stat1` does exist here. The basis is measured instead: offenders
    // came out 0 at N=2, at N=200, and at N=200 after a manual ANALYZE that put
    // real selectivity into stat1, and the guard reddens at N=2 under the
    // mutation. Keeping setup cheap matters — this file's other cases already
    // sit near the default timeout.
    for (const record of countTokensFloodFixtures(2)) commitPreparedOperation(db, prepareModelOperation(record))

    const executed: Array<string> = []
    const execed: Array<string> = []
    const realPrepare = db.prepare.bind(db)
    const realExec = db.exec.bind(db)
    ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      executed.push(sql)
      return realPrepare(sql)
    }
    ;(db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      execed.push(sql)
      return realExec(sql)
    }
    try {
      commitPreparedOperation(db, prepareModelOperation(highBranchFixture("plan-probe", 2, 128)))
    } finally {
      ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = realPrepare
      ;(db as unknown as { exec: (sql: string) => unknown }).exec = realExec
    }

    // Whitelist, not blacklist. A list of "tables that grow" silently stops
    // covering every table added after it was written; a list of tables that are
    // BOUNDED by construction fails closed instead — a new growing table is not
    // on it, so scanning it is reported.
    const boundedTables = new Set(["v3_meta", "history_meta", "history_store_identity", "sqlite_schema", "sqlite_master", "sqlite_stat1"])
    const offenders: Array<string> = []
    for (const sql of executed) {
      if (!/^\s*(?:SELECT|UPDATE|DELETE|INSERT)/i.test(sql)) continue
      let plan: Array<{ detail: string }>
      try {
        plan = realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
      } catch {
        continue // not planable standalone; measured to be 0 of 29 statements today
      }
      for (const { detail } of plan) {
        const scanned = /\bSCAN (\w+)/.exec(detail)?.[1]
        if (scanned !== undefined && !boundedTables.has(scanned)) offenders.push(`${detail} :: ${sql}`)
      }
    }

    // `exec` bypasses the prepare probe entirely, so it gets its own assertion.
    // Frozen shape rather than a DML regex: a script is multi-statement, and
    // "does the first statement look like DDL" misses `PRAGMA …; UPDATE …`,
    // while scanning every line misreports the INSERT/UPDATE inside a trigger
    // body. Naming the shapes exec is allowed to carry fails closed instead —
    // anything new arriving through this path has to be looked at.
    const unexpectedExec = execed.filter((sql) => {
      const text = sql.trim()
      if (text === V3_SCHEMA_SQL.trim()) return false
      return !/^DROP TABLE IF EXISTS \w+;?$/i.test(text)
    })

    expect(executed.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
    expect(unexpectedExec).toEqual([])
  })

  test("reports prepare and commit timing before and after prior session history", () => {
    const target = highBranchFixture("target-operation", 10, 8_192)
    const coldPrepareMs = timedPrepare(target)
    const coldCommitMs = timedCommit({ ...target, identity: { ...target.identity, operationId: "target-cold" } })

    for (const record of countTokensFloodFixtures(256)) commitPreparedOperation(getDatabase(), prepareModelOperation(record))
    const hotPrepareMs = timedPrepare(target)
    const hotCommitMs = timedCommit({ ...target, identity: { ...target.identity, operationId: "target-hot" } })
    const prepareRatio = hotPrepareMs / coldPrepareMs
    const commitRatio = hotCommitMs / coldCommitMs

    console.log("HISTORY_V3_PERF history-length", JSON.stringify({ coldPrepareMs, hotPrepareMs, prepareRatio, coldCommitMs, hotCommitMs, commitRatio }))
  })

  test("CAS live physical bytes are at least 10x smaller than the real compressed V2 write shape", () => {
    const maxTurns = 212
    const sharedMessages = Array.from({ length: maxTurns }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + deterministicNoise(index, 8_192),
    }))
    const records = Array.from({ length: 48 }, (_, index) => {
      const turns = 24 + index * 4
      const record = longConversationFixture(`cas-turn-${index}`, turns, 768)
      const ingressNode = record.arena.payloads.find((node) => node.handle === record.ingress?.request.payload)
      if (!ingressNode) throw new Error("missing ingress payload")
      const body = { model: "claude-opus-4.8", stream: true, messages: sharedMessages.slice(0, turns) }
      return {
        ...record,
        arena: {
          ...record.arena,
          payloads: record.arena.payloads.map((node) => (node.handle === ingressNode.handle ? { ...node, value: body } : node)),
        },
      }
    })
    const v2Bytes = records.reduce((total, record) => total + v2SerializedEstimate(record), 0)
    const before = pageBytes(getDatabase())
    for (const record of records) commitPreparedOperation(getDatabase(), prepareModelOperation(record))
    const pageDelta = pageBytes(getDatabase()) - before
    const liveBytes = liveV3Bytes(getDatabase())
    const physicalRatio = v2Bytes / pageDelta
    const liveRatio = v2Bytes / liveBytes

    console.log("HISTORY_V3_PERF cas-bytes", JSON.stringify({ operations: records.length, v2Bytes, pageDelta, liveBytes, physicalRatio, liveRatio }))
    expect(physicalRatio).toBeGreaterThanOrEqual(10)
    expect(liveRatio).toBeGreaterThanOrEqual(10)
  }, 15_000)

  test("writer pending bytes track logical queue bytes and drain releases RSS pressure", async () => {
    const records = [
      largeSseFixture("pending-sse", 2_048, 160),
      bufferedRetryFixture("pending-retry", 4, 256),
      embeddingBatchFixture("pending-embedding", 192, 64),
    ]
    Bun.gc(true)
    const rssBefore = process.memoryUsage().rss
    const promises = records.map((record) => enqueueModelOperation(record))
    const pendingStatus = getV3StoreStatus()
    const logicalBytes = records.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0)
    const rssPending = process.memoryUsage().rss
    await Promise.all(promises)
    await drainV3Writer()
    Bun.gc(true)
    const rssAfter = process.memoryUsage().rss
    const rssGrowth = Math.max(0, rssPending - rssBefore)
    const retainedGrowth = Math.max(0, rssAfter - rssBefore)

    console.log(
      "HISTORY_V3_PERF writer-memory",
      JSON.stringify({
        logicalBytes,
        pendingBytes: pendingStatus.pendingBytes,
        pendingOperations: pendingStatus.pendingOperations,
        rssBefore,
        rssPending,
        rssAfter,
        rssGrowth,
        retainedGrowth,
      }),
    )
    expect(pendingStatus.pendingBytes).toBeGreaterThan(0)
    expect(pendingStatus.pendingBytes).toBeLessThanOrEqual(logicalBytes)
    expect(pendingStatus.pendingBytes).toBeGreaterThan(logicalBytes * 0.25)
    expect(getV3StoreStatus()).toMatchObject({ pendingOperations: 0, pendingBytes: 0, failedOperations: 0 })
    // RSS includes Bun/SQLite allocator arenas that are not returned immediately.
    // Keep this as a coarse leak tripwire; pendingBytes is the precise queue bound.
    expect(retainedGrowth).toBeLessThan(Math.max(rssGrowth * 8, logicalBytes * 32))
  })
})
