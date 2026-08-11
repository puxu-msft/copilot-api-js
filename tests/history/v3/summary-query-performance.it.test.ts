import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Database } from "~/lib/history/sqlite/connection"

import { clearInFlight } from "~/lib/history/in-flight"
import { getHistorySummaries } from "~/lib/history/queries"
import { getSessionSummaries } from "~/lib/history/sessions"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { setMeta } from "~/lib/history/sqlite/meta"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { getStats } from "~/lib/history/stats"
import {
  //
  countV3Operations,
  ensureV3Schema,
  getV3StoreStatus,
} from "~/lib/history/v3/store"
import { SUMMARY_PROJECTION_READY_KEY } from "~/lib/history/v3/summary-store"
import { clearRecentModelOperationTerminalsForTests } from "~/lib/history/v3/terminal-bus"

const ROW_COUNT = 512
const LARGE_MANIFEST_BYTES = 256 * 1024

interface ReadSnapshot {
  listIds: Array<string>
  sessionCount: number
  totalRequests: number
  statusCount: number
  projectionReady: boolean
}

interface Measurement<T> {
  value: T
  elapsedMs: number
  maxEventLoopGapMs: number
}

function summaryJson(index: number): string {
  return JSON.stringify({
    id: `perf-${index.toString().padStart(4, "0")}`,
    operationKind: "generation",
    sessionId: `session-${index % 32}`,
    startedAt: index,
    endedAt: index + 1,
    endpoint: "anthropic-messages",
    state: "completed",
    messageCount: 1,
    requestModel: "perf-model",
    responseModel: "perf-model",
    responseSuccess: true,
    durationMs: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    previewText: `prompt-${index}`,
    responsePreviewText: `response-${index}`,
  })
}

function seedRows(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO v3_operations(
       operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,
       manifest_gz,summary_json,pinned,committed_at
     ) VALUES(?,1,?,'generation',?,1,?,'canonical',zeroblob(1),?,0,?)`,
  )
  const seed = db.transaction(() => {
    for (let index = 0; index < ROW_COUNT; index++) {
      const id = `perf-${index.toString().padStart(4, "0")}`
      insert.run(id, `digest-${index}`, index, index + 1, summaryJson(index), index + 1)
    }
  })
  seed()
  db.prepare("UPDATE v3_operation_summaries SET projection_status='ready',projection_error=NULL").run()
  setMeta(db, SUMMARY_PROJECTION_READY_KEY, "1")
}

function readBundle(): ReadSnapshot {
  const list = getHistorySummaries({ limit: 50 })
  const sessions = getSessionSummaries(200)
  const stats = getStats()
  const storeStatus = getV3StoreStatus()
  return {
    listIds: list.entries.map((entry) => entry.id),
    sessionCount: sessions.length,
    totalRequests: stats.totalRequests,
    statusCount: countV3Operations(),
    projectionReady: storeStatus.summaryProjectionReady,
  }
}

async function measure<T>(action: () => T): Promise<Measurement<T>> {
  let maxEventLoopGapMs = 0
  let lastTick = performance.now()
  const ticker = setInterval(() => {
    const now = performance.now()
    maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick)
    lastTick = now
  }, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  const started = performance.now()
  const value = action()
  const elapsedMs = performance.now() - started
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  clearInterval(ticker)
  return { value, elapsedMs, maxEventLoopGapMs }
}

beforeEach(async () => {
  clearInFlight()
  clearRecentModelOperationTerminalsForTests()
  closeDatabase()
  openInMemoryDatabase()
  ensureV3Schema(getDatabase())
  await applyForwardMigrations(getDatabase())
  seedRows(getDatabase())
})

afterEach(() => {
  closeDatabase()
})

describe("History summary read performance", () => {
  test("list, sessions, stats, and status stay independent of canonical manifest size", async () => {
    const db = getDatabase()
    const small = await measure(readBundle)
    db.prepare("UPDATE v3_operations SET manifest_gz=zeroblob(?)").run(LARGE_MANIFEST_BYTES)
    db.prepare("UPDATE v3_operation_summaries SET projection_status='ready',projection_error=NULL").run()
    setMeta(db, SUMMARY_PROJECTION_READY_KEY, "1")
    const large = await measure(readBundle)
    const legacy = await measure(() => {
      const rows = db.prepare("SELECT manifest_gz FROM v3_operations").all() as Array<{ manifest_gz: Uint8Array }>
      return rows.reduce((total, row) => total + row.manifest_gz.byteLength, 0)
    })

    console.log(
      "HISTORY_V3_PERF summary-read",
      JSON.stringify({
        rows: ROW_COUNT,
        manifestBytes: legacy.value,
        small: { elapsedMs: small.elapsedMs, maxEventLoopGapMs: small.maxEventLoopGapMs },
        large: { elapsedMs: large.elapsedMs, maxEventLoopGapMs: large.maxEventLoopGapMs },
        injectedLegacyScan: { elapsedMs: legacy.elapsedMs, maxEventLoopGapMs: legacy.maxEventLoopGapMs },
      }),
    )

    expect(large.value).toEqual(small.value)
    expect(large.value).toEqual({
      listIds: Array.from({ length: 50 }, (_, offset) => `perf-${(ROW_COUNT - 1 - offset).toString().padStart(4, "0")}`),
      sessionCount: 32,
      totalRequests: ROW_COUNT,
      statusCount: ROW_COUNT,
      projectionReady: true,
    })
    expect(large.elapsedMs).toBeLessThan(Math.max(50, small.elapsedMs * 5))
    expect(large.maxEventLoopGapMs).toBeLessThan(Math.max(50, small.maxEventLoopGapMs * 5))
    expect(legacy.value).toBe(ROW_COUNT * LARGE_MANIFEST_BYTES)
    expect(legacy.elapsedMs).toBeGreaterThan(large.elapsedMs * 2)
    expect(legacy.maxEventLoopGapMs).toBeGreaterThan(large.maxEventLoopGapMs * 2)
  }, 15_000)
})
