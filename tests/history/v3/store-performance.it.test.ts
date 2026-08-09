import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
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
import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import {
  //
  commitPreparedOperation,
  drainV3Writer,
  enqueueModelOperation,
  getV3StoreStatus,
  prepareModelOperation,
  resetV3WriterForTests,
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

// Every criterion in this file is a RATIO — CAS byte savings, cold-vs-hot cost, retained-vs-peak
// RSS. How long the work takes is NOT one of them: the CAS case alone hashes and compresses tens of
// megabytes of fixture text, which costs ~4.5s of real CPU in isolation. Bun's per-test budget is a
// wall-clock quantity, and under the 16-shard runner (`scripts/parallel-test.ts`) contention
// stretched that case to 18.03s and timed it out at 15s while its actual ratios were 112x and 219x
// against a 10x threshold — a healthy mechanism starved by an unrelated budget. Budget the file for
// its real cost instead (>=10x the isolated worst case AND >=3x the worst observed under sharding);
// never relax the ratios themselves. Same shape as `tests/infra/validate-entry-evidence.unit.test.ts`.
setDefaultTimeout(60_000)

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

/** Number of commit samples per measurement — matches `timedPrepare`. */
const COMMIT_SAMPLES = 5

/**
 * Same shape, DIFFERENT content for every sample. This matters more than it looks:
 * `highBranchFixture` seeds its payload text from constants (`deterministicText(1, …)`,
 * `index + 10`, `index + 100`) and NOT from the record id, so two fixtures built with different
 * names are byte-identical inside. Varying only `operationId` would leave samples 2..N hitting
 * existing CAS objects — `insertObject` returns early on a hash it already has — and the median
 * would measure dedup lookups instead of inserts. Salting each payload keeps the shape and size
 * while forcing every sample to do the real insert work.
 */
function saltedSample(base: ModelOperationRecord, sampleId: string): ModelOperationRecord {
  return {
    ...base,
    identity: { ...base.identity, operationId: sampleId },
    arena: {
      ...base.arena,
      payloads: base.arena.payloads.map((node) =>
        typeof node.value === "object" && node.value !== null && !Array.isArray(node.value) ?
          { ...node, value: { ...(node.value as Record<string, unknown>), __sample: sampleId } }
        : node,
      ),
    },
  }
}

function timedCommit(base: ModelOperationRecord, label: string): number {
  const samples: Array<number> = []
  for (let index = 0; index < COMMIT_SAMPLES; index++) {
    const prepared = prepareModelOperation(saltedSample(base, `${label}-${index}`))
    const start = performance.now()
    commitPreparedOperation(getDatabase(), prepared)
    samples.push(performance.now() - start)
  }
  return median(samples)
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
  test("commit never scans a history-sized table (deterministic query-plan oracle)", () => {
    // WHY THIS EXISTS: the timing test below expresses the same intent — "commit cost does not grow
    // with prior history length" — but it does so by dividing two ~2ms wall-clock readings, which on
    // a contended box is noise (measured false-red about 1 run in 5). This oracle is the part of that
    // intent that can be checked DETERMINISTICALLY, so the backend tier gates on this one.
    //
    // BOUNDARY — read before assuming this replaces the timing test. It is strictly NARROWER:
    // "no query plan degrades to a full scan" is not "cost does not grow". It COVERS the SELECT,
    // DELETE and UPDATE statements this commit issues against history-sized tables — all three run a
    // plan, and the journal DELETE on this path is exactly the case an earlier SELECT-only filter
    // missed. It does NOT catch cost growth that keeps an indexed plan — an N+1 loop of point
    // lookups, per-operation work in JS, growth in row SIZE, a scan issued through a code path this
    // commit does not execute, or a plan that is indexed but poorly selective. Those remain the
    // timing test's job, which is why that test is kept (gated into the perf tier) rather than
    // deleted.
    //
    // It observes the statements PRODUCTION actually prepares, rather than re-stating SQL here — a
    // copy of the query would prove things about the copy.
    const db = getDatabase()
    const seeded = highBranchFixture("plan-oracle-seed", 10, 8_192)
    commitPreparedOperation(db, prepareModelOperation(seeded))
    for (const record of countTokensFloodFixtures(64)) commitPreparedOperation(db, prepareModelOperation(record))

    const prepared = prepareModelOperation(highBranchFixture("plan-oracle-target", 10, 8_192))
    const originalPrepare = db.prepare.bind(db)
    const statements: Array<string> = []
    ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      statements.push(sql)
      return originalPrepare(sql)
    }
    try {
      commitPreparedOperation(db, prepared)
    } finally {
      ;(db as unknown as { prepare: unknown }).prepare = originalPrepare
    }

    const HISTORY_SIZED = /v3_(?:objects|operations|sequence_nodes|tracks|timeline_chunks|journal)/
    // SELECT is not the only statement whose plan can degrade: a DELETE or UPDATE with a WHERE runs
    // a plan too, and `DELETE FROM v3_journal WHERE operation_id=? AND revision=?` is on this very
    // path. An earlier revision filtered on SELECT alone and silently excluded five such statements.
    const planned = statements.filter((sql) => /^\s*(?:SELECT|DELETE|UPDATE)/i.test(sql) && HISTORY_SIZED.test(sql))
    // Positive control for the oracle itself: if the commit path stopped issuing planned statements
    // against these tables at all, every assertion below would pass vacuously.
    expect(planned.length).toBeGreaterThan(0)

    const scans = planned
      .map((sql) => ({ sql, plan: (originalPrepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail) }))
      .filter(({ plan }) => plan.some((detail) => /^SCAN\b/.test(detail)))

    console.log("HISTORY_V3_PLAN", JSON.stringify({ statementsSeen: statements.length, planInspected: planned.length, scans: scans.length }))
    expect(scans).toEqual([])
  })
})

/**
 * The timing half of "commit cost does not grow with prior history length". It is kept because the
 * query-plan oracle above is strictly narrower, but it is GATED OUT of the backend tier: it divides
 * two ~2ms wall-clock readings, which is noise on a contended box (measured false-red about 1 run in
 * 5, and it was a real T0.0f blocker). Gating, not deleting — the invariant is not abandoned, only
 * moved off the gate.
 *
 * Run it with `bun run test:perf`. The suffix and file are deliberately unchanged: `.it.test.ts`
 * keeps it inside the discovery baseline's `files` set, so it surfaces in the backend tier as an
 * explicit, allow-listed skip rather than silently disappearing.
 */
const PERF_TIER = process.env.RUN_PERF_TESTS === "1"

describe.skipIf(!PERF_TIER)("History V3 store performance (timing — perf tier only)", () => {
  test("prepare and commit do not depend on prior session history length", () => {
    const target = highBranchFixture("target-operation", 10, 8_192)
    const coldPrepareMs = timedPrepare(target)
    const coldCommitMs = timedCommit(target, "target-cold")

    for (const record of countTokensFloodFixtures(256)) commitPreparedOperation(getDatabase(), prepareModelOperation(record))
    const hotPrepareMs = timedPrepare(target)
    const hotCommitMs = timedCommit(target, "target-hot")
    const prepareRatio = hotPrepareMs / coldPrepareMs
    const commitRatio = hotCommitMs / coldCommitMs

    console.log("HISTORY_V3_PERF history-length", JSON.stringify({ coldPrepareMs, hotPrepareMs, prepareRatio, coldCommitMs, hotCommitMs, commitRatio }))
    expect(prepareRatio).toBeLessThan(3)
    // Criterion and threshold are the ORIGINAL ones. A previous revision replaced them with
    // `hotCommitMs < Math.max(coldCommitMs * 5, 60)`, which was a PURE LOOSENING and is reverted
    // here: cold is 2-4ms in this fixture, so the floor won every time and the budget was a constant
    // 60ms. Measured under one injected O(prior operations) defect, the two forms disagree exactly as
    // that predicts — ratio form red at 6.76, floor form green while itself reporting ratio 5.20.
    //
    // KNOWN LIMITATION, deliberately left in place rather than papered over: this ratio divides two
    // ~2ms wall-clock measurements on a contended 16-core box, so it still false-reds — measured 1
    // run in 5 in isolation (cold 2.07, hot 24.61, ratio 11.88), which is the same signature as the
    // merged-state failure this was first raised for. Median-of-5 sampling below reduces that but
    // does not remove it. Two alternatives were measured and both rejected: the floor (loosening,
    // above) and enlarging the fixture to 80x64KB (cold 26-56ms makes the ratio participate, but the
    // raised baseline dilutes history-dependent cost to invisibility — the same injected defect moved
    // the ratio only to 0.94/0.81). A timing ratio at this scale cannot be both stable and sensitive;
    // the way out is a deterministic oracle (asserting the hot-path statements keep an indexed plan
    // rather than degrading to a scan) — that oracle now exists above and is what the backend tier
    // gates on; this timing check is retained here for the part the oracle cannot see.
    expect(commitRatio).toBeLessThan(5)
  })
})

// Back in the backend tier: these two are byte/ratio criteria, not wall-clock ones.
describe("History V3 store performance", () => {
  test("CAS live physical bytes stay far below the real compressed V2 write shape (>=30x physical, >=50x live)", () => {
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
    // Calibrated against both ends, not picked round. Healthy: 109.68 physical / 218.58 live,
    // reproducible to 7 digits across trees. Totally broken (content-addressing disabled so every
    // operation stores its own copy): 9.51 physical / 10.79 live -- measured, not assumed. So the
    // former 10x threshold discriminated on physical by 0.49, and on live NOT AT ALL: a COMPLETE
    // dedup failure still cleared it. These sit near the geometric mean of the two ends (~32 and
    // ~49), leaving ~3x margin on each side.
    //
    // Scope of that claim, because the stronger version was refuted: this says nothing about where
    // in between the axes start reddening. A 47-of-48 partial degradation measured 9.516 physical,
    // i.e. the OLD threshold already caught that one. Two endpoints do not establish the curve
    // between them.
    //
    // Wall clock is NOT a criterion here -- see the file-level setDefaultTimeout note at the top.
    expect(physicalRatio).toBeGreaterThanOrEqual(30)
    expect(liveRatio).toBeGreaterThanOrEqual(50)
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
