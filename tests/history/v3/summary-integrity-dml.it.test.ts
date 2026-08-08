import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getMeta } from "~/lib/history/sqlite/meta"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { ensureV3Schema } from "~/lib/history/v3/store"
import {
  //
  SUMMARY_PROJECTION_READY_KEY,
  tryMarkSummaryProjectionReady,
} from "~/lib/history/v3/summary-store"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

function entry(id: string): HistoryEntry {
  return {
    id,
    operationKind: "generation",
    startedAt: 1_000,
    endedAt: 1_250,
    durationMs: 250,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    pinned: false,
    clientRequest: { model: "gpt-5.6-sol", stream: true, messages: [{ role: "user", content: "dml integrity" }] },
    clientResponse: { status: 200, body: { type: "message", content: [{ type: "text", text: "ok" }] } },
    attempts: [],
    process: { pid: 123, bootTime: 10, version: "test" },
    model: { requested: "gpt-5.6-sol", resolved: "gpt-5.6-sol" },
  }
}

async function seedReady(id = "dml-op"): Promise<void> {
  const db = getDatabase()
  await applyForwardMigrations(db)
  commitV3HistoryEntry(entry(id))
  expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
  expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
}

function projection(id = "dml-op"): { projection_status: string; pinned: number } | null {
  return getDatabase().prepare("SELECT projection_status,pinned FROM v3_operation_summaries WHERE operation_id=?").get(id) as {
    projection_status: string
    pinned: number
  } | null
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  ensureV3Schema(getDatabase())
})

afterEach(() => closeDatabase())

describe("History V3 canonical operation DML final states", () => {
  test("trusted production insert publishes one ready summary and preserves readiness", async () => {
    await seedReady()

    expect(projection()).toEqual({ projection_status: "ready", pinned: 0 })
    expect(getMeta(getDatabase(), SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("direct new-key insert is pending and revokes readiness", async () => {
    await seedReady()
    const db = getDatabase()

    db.prepare(
      `INSERT INTO v3_operations(
      operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
    ) SELECT ?,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
      FROM v3_operations WHERE operation_id=?`,
    ).run("direct-insert", "dml-op")

    expect(projection("direct-insert")?.projection_status).toBe("pending")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test("plain existing-key insert aborts without changing canonical or derived state", async () => {
    await seedReady()
    const db = getDatabase()
    const before = db.prepare("SELECT * FROM v3_operations WHERE operation_id=?").get("dml-op")

    expect(() =>
      db
        .prepare(
          `INSERT INTO v3_operations(
        operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
      ) SELECT operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
        FROM v3_operations WHERE operation_id=?`,
        )
        .run("dml-op"),
    ).toThrow()
    expect(db.prepare("SELECT * FROM v3_operations WHERE operation_id=?").get("dml-op")).toEqual(before)
    expect(projection()).toEqual({ projection_status: "ready", pinned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test.each([
    ["manifest_gz", "manifest_gz"],
    ["revision", "revision"],
    ["digest", "digest"],
    ["kind", "kind"],
    ["created_at", "created_at"],
    ["terminal_sequence", "terminal_sequence"],
    ["ended_at", "ended_at"],
    ["timing_source", "timing_source"],
    ["committed_at", "committed_at"],
    ["summary_json", "summary_json"],
  ])("updating protected operation column %s poisons its summary and revokes readiness", async (_name, column) => {
    await seedReady()
    const db = getDatabase()

    db.exec(`UPDATE v3_operations SET ${column}=${column} WHERE operation_id='dml-op'`)

    expect(projection()?.projection_status).toBe("poisoned")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test.each(["ON", "OFF"])("operation identity rename aborts with foreign_keys=%s", async (foreignKeys) => {
    await seedReady()
    const db = getDatabase()
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`)

    expect(() => db.prepare("UPDATE v3_operations SET operation_id='renamed' WHERE operation_id='dml-op'").run()).toThrow(/identity/i)
    expect(projection()).toEqual({ projection_status: "ready", pinned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("pinned is a legal overlay that updates only the projection pin", async () => {
    await seedReady()
    const db = getDatabase()

    db.prepare("UPDATE v3_operations SET pinned=1 WHERE operation_id='dml-op'").run()

    expect(projection()).toEqual({ projection_status: "ready", pinned: 1 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("delete removes canonical refs and summary without revoking global readiness", async () => {
    await seedReady()
    const db = getDatabase()

    db.prepare("DELETE FROM v3_operations WHERE operation_id='dml-op'").run()

    expect(db.prepare("SELECT 1 FROM v3_operations WHERE operation_id='dml-op'").get()).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_operation_evidence_refs WHERE operation_id='dml-op'").get()).toBeNull()
    expect(projection()).toBeNull()
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test.each(["ON", "OFF"])(
    "existing-key REPLACE clears stale refs, creates pending summary, and revokes readiness with foreign_keys=%s",
    async (foreignKeys) => {
      await seedReady()
      const db = getDatabase()
      db.exec(`PRAGMA foreign_keys = ${foreignKeys}`)

      db.prepare(
        `INSERT OR REPLACE INTO v3_operations(
      operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
    ) SELECT operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,pinned,committed_at
      FROM v3_operations WHERE operation_id=?`,
      ).run("dml-op")

      expect(projection()?.projection_status).toBe("pending")
      expect(db.prepare("SELECT 1 FROM v3_operation_evidence_refs WHERE operation_id='dml-op'").get()).toBeNull()
      expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    },
  )
})
