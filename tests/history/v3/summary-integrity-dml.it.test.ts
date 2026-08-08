import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getMeta } from "~/lib/history/sqlite/meta"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  ensureV3Schema,
  validateAndMarkSummaryProjectionReady,
  visitV3Summaries,
} from "~/lib/history/v3/store"
import { SUMMARY_PROJECTION_READY_KEY } from "~/lib/history/v3/summary-store"
import { compressBytes } from "~/lib/sqlite/compression"

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
  expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
  expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
}

function projection(id = "dml-op"): { projection_status: string; pinned: number } | null {
  return getDatabase().prepare("SELECT projection_status,pinned FROM v3_operation_summaries WHERE operation_id=?").get(id) as {
    projection_status: string
    pinned: number
  } | null
}

function seedReferencedEvidence(): { digest: string; bytes: Uint8Array } {
  const db = getDatabase()
  const bytes = new Uint8Array([81, 82, 83])
  const digest = createHash("sha256").update(bytes).digest("hex")
  db.prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
    digest,
    "binary",
    compressBytes(bytes),
    bytes.byteLength,
  )
  db.prepare("INSERT INTO v3_operation_evidence_refs(operation_id,dispatch_index,sequence,digest,byte_length,encoding) VALUES('dml-op',0,1,?,?,?)").run(
    digest,
    bytes.byteLength,
    "binary",
  )
  return { digest, bytes }
}

function evidence(digest: string): { encoding: string; evidence_gz: Uint8Array; byte_length: number } | null {
  return getDatabase().prepare("SELECT encoding,evidence_gz,byte_length FROM v3_transport_evidence WHERE digest=?").get(digest) as {
    encoding: string
    evidence_gz: Uint8Array
    byte_length: number
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

  test("the marker-absent fallback publishes the canonical reprojection, never the tampered cached summary", async () => {
    await seedReady()
    const db = getDatabase()

    // Every readiness criterion fires correctly here: the protected-update
    // trigger poisons the derived row and revokes the marker. What this guards
    // is the next question — what the read path actually hands the client once
    // the marker says the cached projection is not to be trusted.
    db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=?").run(
      JSON.stringify({ id: "dml-op", endpoint: "ATTACKER-CONTROLLED", previewText: "FABRICATED PREVIEW" }),
      "dml-op",
    )
    expect(projection()?.projection_status).toBe("poisoned")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()

    const published: Array<{ id: string; endpoint: string; previewText?: string }> = []
    visitV3Summaries((summary) => {
      published.push({ id: summary.id, endpoint: summary.endpoint, previewText: summary.previewText })
    })

    expect(published).toHaveLength(1)
    expect(published[0].endpoint).toBe("anthropic-messages")
    expect(published[0].endpoint).not.toBe("ATTACKER-CONTROLLED")
    expect(published[0].previewText ?? "").not.toBe("FABRICATED PREVIEW")
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

describe("History V3 canonical evidence DML final states", () => {
  test("new evidence INSERT commits without disturbing ready summaries", async () => {
    await seedReady()
    const db = getDatabase()
    const bytes = new Uint8Array([91])
    const digest = createHash("sha256").update(bytes).digest("hex")

    db.prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
      digest,
      "binary",
      compressBytes(bytes),
      bytes.byteLength,
    )

    expect(evidence(digest)).not.toBeNull()
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("plain existing-digest INSERT aborts without changing canonical or derived state", async () => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()
    const before = evidence(seeded.digest)

    expect(() =>
      db
        .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
        .run(seeded.digest, "binary", compressBytes(seeded.bytes), seeded.bytes.byteLength),
    ).toThrow()
    expect(evidence(seeded.digest)).toEqual(before)
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test.each(["evidence_gz", "byte_length", "encoding"])("updating referenced evidence column %s poisons every dependent summary", async (column) => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()

    db.exec(`UPDATE v3_transport_evidence SET ${column}=${column} WHERE digest='${seeded.digest}'`)

    expect(projection()?.projection_status).toBe("poisoned")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test.each(["evidence_gz", "byte_length", "encoding"])("updating unreferenced evidence column %s does not revoke readiness", async (column) => {
    await seedReady()
    const db = getDatabase()
    const bytes = new Uint8Array([92])
    const digest = createHash("sha256").update(bytes).digest("hex")
    db.prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
      digest,
      "binary",
      compressBytes(bytes),
      bytes.byteLength,
    )

    db.exec(`UPDATE v3_transport_evidence SET ${column}=${column} WHERE digest='${digest}'`)

    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("evidence identity rename aborts without changing dependents", async () => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()

    expect(() => db.prepare("UPDATE v3_transport_evidence SET digest=? WHERE digest=?").run("f".repeat(64), seeded.digest)).toThrow(/identity/i)
    expect(evidence(seeded.digest)).not.toBeNull()
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("referenced evidence DELETE aborts with foreign_keys=ON and rolls back trigger side effects", async () => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()
    db.exec("PRAGMA foreign_keys = ON")

    expect(() => db.prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(seeded.digest)).toThrow()
    expect(evidence(seeded.digest)).not.toBeNull()
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("referenced evidence DELETE commits fail-closed with foreign_keys=OFF", async () => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()
    db.exec("PRAGMA foreign_keys = OFF")

    db.prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(seeded.digest)

    expect(evidence(seeded.digest)).toBeNull()
    expect(projection()?.projection_status).toBe("poisoned")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test("unreferenced evidence DELETE commits without disturbing readiness", async () => {
    await seedReady()
    const db = getDatabase()
    const bytes = new Uint8Array([93])
    const digest = createHash("sha256").update(bytes).digest("hex")
    db.prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
      digest,
      "binary",
      compressBytes(bytes),
      bytes.byteLength,
    )

    db.prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(digest)

    expect(evidence(digest)).toBeNull()
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("new evidence REPLACE commits without disturbing readiness", async () => {
    await seedReady()
    const db = getDatabase()
    const bytes = new Uint8Array([94])
    const digest = createHash("sha256").update(bytes).digest("hex")

    db.prepare("INSERT OR REPLACE INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
      digest,
      "binary",
      compressBytes(bytes),
      bytes.byteLength,
    )

    expect(evidence(digest)).not.toBeNull()
    expect(projection()?.projection_status).toBe("ready")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test.each([
    ["ON", "OFF"],
    ["ON", "ON"],
    ["OFF", "OFF"],
    ["OFF", "ON"],
  ])("existing evidence REPLACE commits fail-closed with foreign_keys=%s recursive_triggers=%s", async (foreignKeys, recursiveTriggers) => {
    await seedReady()
    const db = getDatabase()
    const seeded = seedReferencedEvidence()
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`)
    db.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`)

    db.prepare("INSERT OR REPLACE INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
      seeded.digest,
      "binary",
      compressBytes(seeded.bytes),
      seeded.bytes.byteLength,
    )

    expect(evidence(seeded.digest)).not.toBeNull()
    expect(projection()?.projection_status).toBe("poisoned")
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })
})
