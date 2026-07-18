import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import {
  //
  commitPreparedOperation,
  drainV3Writer,
  enqueueModelOperation,
  getV3StoreStatus,
  prepareModelOperation,
  resetV3WriterForTests,
  searchV3OperationIds,
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

function p95(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
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
        COALESCE((SELECT SUM(LENGTH(manifest_gz)) FROM v3_operations), 0) +
        COALESCE((SELECT SUM(LENGTH(refs_json)) FROM v3_tracks), 0) +
        COALESCE((SELECT SUM(LENGTH(payload_gz)) FROM v3_timeline_chunks), 0) +
        COALESCE((SELECT SUM(LENGTH(payload_gz)) FROM v3_journal), 0) +
        COALESCE((SELECT SUM(LENGTH(document_gz)) FROM v3_search_objects), 0) +
        COALESCE((SELECT SUM(LENGTH(operation_id) + LENGTH(object_hash)) FROM v3_search_membership), 0) AS bytes`,
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
  test("prepare and commit do not depend on prior session history length", () => {
    const target = highBranchFixture("target-operation", 10, 8_192)
    const coldPrepareMs = timedPrepare(target)
    const coldCommitMs = timedCommit({ ...target, identity: { ...target.identity, operationId: "target-cold" } })

    for (const record of countTokensFloodFixtures(256)) commitPreparedOperation(getDatabase(), prepareModelOperation(record))
    const hotPrepareMs = timedPrepare(target)
    const hotCommitMs = timedCommit({ ...target, identity: { ...target.identity, operationId: "target-hot" } })
    const prepareRatio = hotPrepareMs / coldPrepareMs
    const commitRatio = hotCommitMs / coldCommitMs

    console.log("HISTORY_V3_PERF history-length", JSON.stringify({ coldPrepareMs, hotPrepareMs, prepareRatio, coldCommitMs, hotCommitMs, commitRatio }))
    expect(prepareRatio).toBeLessThan(3)
    expect(commitRatio).toBeLessThan(5)
  })

  test("CAS live physical bytes are at least 10x smaller than repeated V2 serialization estimate", () => {
    const maxTurns = 116
    const sharedMessages = Array.from({ length: maxTurns }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "history-context ".repeat(96),
    }))
    const records = Array.from({ length: 24 }, (_, index) => {
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
  })

  test("search p95 scales sublinearly with corpus size", () => {
    const seedCorpus = (offset: number, count: number): void => {
      for (let index = 0; index < count; index++) {
        const record = longConversationFixture(`search-${offset + index}`, 12, 384)
        commitPreparedOperation(getDatabase(), prepareModelOperation(record))
      }
    }
    const sample = (needle: string): number => {
      const latencies = Array.from({ length: 80 }, () => {
        const start = performance.now()
        searchV3OperationIds(needle, undefined, 25)
        return performance.now() - start
      })
      return p95(latencies)
    }

    seedCorpus(0, 64)
    const smallP95Ms = sample("no-such-search-token")
    seedCorpus(64, 192)
    const largeP95Ms = sample("no-such-search-token")
    const corpusRatio = 4
    const latencyRatio = largeP95Ms / smallP95Ms

    console.log("HISTORY_V3_PERF search", JSON.stringify({ smallOperations: 64, largeOperations: 256, smallP95Ms, largeP95Ms, corpusRatio, latencyRatio }))
    expect(latencyRatio).toBeLessThan(corpusRatio)
  })

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
