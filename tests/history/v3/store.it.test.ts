import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  clearV3Store,
  commitPreparedOperation,
  drainV3SummaryBackfill,
  drainV3Writer,
  enqueueModelOperation,
  ensureV3Schema,
  getV3Operation,
  getV3StoredOperation,
  getV3StoreStatus,
  listV3Operations,
  prepareModelOperation,
  prepareModelOperationWithTransportEvidence,
  recoverV3Journal,
  resetV3WriterForTests,
  startV3SummaryBackfill,
  type TransportEvidenceInput,
  validateAndMarkSummaryProjectionReady,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"
import { SUMMARY_PROJECTION_READY_KEY } from "~/lib/history/v3/summary-store"
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

function capturedEvidence(bytes: Uint8Array): TransportEvidenceInput {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return {
    dispatchIndex: 0,
    sequence: 1,
    capture: { availability: "captured", digest, byteLength: bytes.byteLength, encoding: "binary" },
    bytes,
  }
}

function terminalRecord(id: string, shared = "same prompt") {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload({ prompt: shared }, { origin: { stage: "ingress", track: "client" } })
  const frame = recorder.registerFrame({ event: "message", data: `hello-${id}` }, { origin: { stage: "upstream", track: "upstream" } })
  recorder.recordIngress({ request: { payload: request } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { frames: [frame] } })
  recorder.recordEgress({ upstream: { frames: [frame] }, client: { frames: [frame] } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt, extensions: { "future.field": { kept: true } } })
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
})

afterEach(async () => {
  await drainV3Writer()
  await drainV3SummaryBackfill()
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 semantic store", () => {
  test("accepts JSON-compatible shared references instead of misclassifying them as cycles", () => {
    const shared = { type: "text", text: "same block" }
    const recorder = createModelOperationRecorder({ identity: { operationId: "shared-dag", kind: "generation", createdAt: 100 } })
    const payload = recorder.registerPayload({ content: [shared], mirrored: shared }, { origin: { stage: "ingress", track: "client" } })
    recorder.recordIngress({ request: { payload } })
    const operation = recorder.commitTerminal({ outcome: "completed" })

    const prepared = prepareModelOperation(operation)
    commitPreparedOperation(getDatabase(), prepared)
    expect(getV3Operation("shared-dag")?.arena.payloads[0]?.value).toEqual({
      content: [{ type: "text", text: "same block" }],
      mirrored: { type: "text", text: "same block" },
    })
  })

  test("does not mutate a pre-current schema before forward migrations own the transition", () => {
    closeDatabase()
    openInMemoryDatabase()
    const db = getDatabase()
    db.exec(`
      CREATE TABLE v3_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO v3_meta(key,value) VALUES('schema_version','5');
      CREATE TABLE v3_journal (
        operation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_gz BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        committed_at INTEGER,
        error TEXT,
        PRIMARY KEY(operation_id,revision)
      );
    `)

    ensureV3Schema(db)

    expect(db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "5" })
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_transport_evidence'").get()).toBeNull()
    expect((db.prepare("PRAGMA table_info(v3_journal)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("format_version")
  })

  test("drops an embedded search projection only on the current schema", () => {
    const db = getDatabase()
    ensureV3Schema(db)
    commitPreparedOperation(db, prepareModelOperation(terminalRecord("keep-canonical")))
    db.exec(`
      CREATE TABLE v3_search_objects(object_hash TEXT PRIMARY KEY, document_gz BLOB NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE v3_search_membership(operation_id TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(operation_id,object_hash));
      CREATE TABLE v3_search_backlog(operation_id TEXT PRIMARY KEY, reason TEXT NOT NULL, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `)
    db.prepare("INSERT INTO v3_search_objects VALUES(?,?,?)").run("obsolete", new Uint8Array([1]), 2)

    ensureV3Schema(db)

    const tableExists = (name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
    expect(tableExists("v3_search_objects")).toBe(false)
    expect(tableExists("v3_search_membership")).toBe(false)
    expect(tableExists("v3_search_backlog")).toBe(false)
    expect(getV3Operation("keep-canonical")?.identity.operationId).toBe("keep-canonical")
  })

  test("keeps newly imported records without canonical terminal time explicitly unavailable", () => {
    const current = terminalRecord("legacy-terminal-time")
    // Intentionally model an already-persisted JSON record from before canonical event clocks.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const legacy = JSON.parse(JSON.stringify(current)) as typeof current
    if (legacy.terminal) delete (legacy.terminal as { occurredAt?: number }).occurredAt
    const prepared = prepareModelOperation(legacy)
    commitPreparedOperation(getDatabase(), prepared)

    const stored = getV3StoredOperation("legacy-terminal-time")!
    expect(stored.timingSource).toBe("unavailable")
    expect(stored.endedAt).toBeUndefined()
  })

  test("round-trips the canonical record and keeps unknown extensions", async () => {
    const record = terminalRecord("op-roundtrip")
    await enqueueModelOperation(record)
    await drainV3Writer()

    // Persistence-neutral JSON wire oracle: stored records are JSON semantic documents.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(getV3Operation(record.identity.operationId)).toEqual(JSON.parse(JSON.stringify(record)))
    expect(listV3Operations("generation").map((item) => item.identity.operationId)).toEqual(["op-roundtrip"])
    expect(getV3StoreStatus()).toMatchObject({ persistedOperations: 1, failedOperations: 0, pendingOperations: 0 })
  })

  test("rejects unsupported future manifest formats instead of guessing their layout", () => {
    const prepared = prepareModelOperation(terminalRecord("future-format"))
    commitPreparedOperation(getDatabase(), prepared)
    const row = getDatabase().prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(prepared.id) as { manifest_gz: Uint8Array }
    const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as { formatVersion: number }
    manifest.formatVersion = 999
    getDatabase()
      .prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?")
      .run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), prepared.id)

    expect(() => getV3Operation(prepared.id)).toThrow(/unsupported manifest format version: 999/i)
  })

  test("persists lightweight summaries and backfills pre-summary V3 rows without touching canonical data", async () => {
    const record = terminalRecord("summary-backfill")
    commitPreparedOperation(getDatabase(), prepareModelOperation(record))
    const before = getDatabase().prepare("SELECT digest,summary_json FROM v3_operations WHERE operation_id=?").get(record.identity.operationId) as {
      digest: string
      summary_json: string | null
    }
    expect(before.summary_json).not.toBeNull()
    getDatabase().prepare("UPDATE v3_operations SET summary_json=NULL WHERE operation_id=?").run(record.identity.operationId)
    await applyForwardMigrations(getDatabase())

    startV3SummaryBackfill(getDatabase(), 1)
    await drainV3SummaryBackfill()
    const after = getDatabase().prepare("SELECT digest,summary_json FROM v3_operations WHERE operation_id=?").get(record.identity.operationId) as {
      digest: string
      summary_json: string | null
    }
    expect(after.digest).toBe(before.digest)
    expect(JSON.parse(after.summary_json ?? "null")).toMatchObject({ id: record.identity.operationId, operationKind: "generation" })
    expect(getV3StoreStatus().summaryBacklog).toBe(0)
  })

  test("deduplicates canonical semantic objects across operations", async () => {
    await enqueueModelOperation(terminalRecord("op-a"))
    await enqueueModelOperation(terminalRecord("op-b"))
    await drainV3Writer()

    const objectCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_objects").get() as { n: number }).n
    expect(objectCount).toBe(3) // one shared request + two distinct frames
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n).toBe(2)
  })

  test("clears every V3 data table and readiness marker while retaining schema metadata", async () => {
    const db = getDatabase()
    ensureV3Schema(db)
    await applyForwardMigrations(db)
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("op-clear"), [capturedEvidence(new Uint8Array([31, 32]))])
    commitPreparedOperation(db, prepared)
    db.prepare("INSERT INTO v3_summary_backlog(operation_id,reason,updated_at) VALUES(?,?,?)").run("summary-poison", "test", 100)
    db.prepare("INSERT INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at) VALUES(?,?,?,?,?,?)").run(
      "journal-only",
      1,
      "digest",
      "terminal",
      new Uint8Array([1]),
      100,
    )
    const evidence = prepared.transportEvidence[0]
    db.prepare("INSERT INTO v3_journal_evidence_refs(operation_id,revision,dispatch_index,sequence,digest,byte_length,encoding) VALUES(?,?,?,?,?,?,?)").run(
      "journal-only",
      1,
      evidence.dispatchIndex,
      evidence.sequence,
      evidence.capture.digest,
      evidence.capture.byteLength,
      evidence.capture.encoding,
    )
    expect(validateAndMarkSummaryProjectionReady(db).ready).toBe(true)

    clearV3Store(db)

    for (const table of [
      "v3_summary_backlog",
      "v3_operation_summaries",
      "v3_timeline_chunks",
      "v3_tracks",
      "v3_operations",
      "v3_operation_evidence_refs",
      "v3_sequence_nodes",
      "v3_objects",
      "v3_journal_evidence_refs",
      "v3_journal",
      "v3_transport_evidence",
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0)
    }
    expect(db.prepare("SELECT value FROM history_meta WHERE key=?").get(SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    expect((db.prepare("SELECT COUNT(*) AS n FROM v3_meta").get() as { n: number }).n).toBeGreaterThan(0)
  })

  test("keeps large semantic values out of the operation manifest and externalizes ordered tracks", () => {
    const body = {
      model: "claude-opus-4.8",
      messages: Array.from({ length: 64 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn-${index}-` + "payload ".repeat(2048),
      })),
    }
    const recorder = createModelOperationRecorder({ identity: { operationId: "value-free-manifest", kind: "generation", createdAt: 100 } })
    const payload = recorder.registerPayload(body, { origin: { stage: "ingress", track: "client" } })
    recorder.recordIngress({ request: { payload, metadata: { ...body, payload: body } } })
    const attempt = recorder.beginAttempt({
      effectiveRequest: { payload, metadata: { ...body, payload: body } },
      upstreamRequest: { payload, metadata: { ...body, payload: body } },
    })
    recorder.settleAttempt(attempt, { verdict: "committed" })
    recorder.recordEgress({ client: { payload, metadata: { content: body } } })
    const prepared = prepareModelOperation(recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt }))
    commitPreparedOperation(getDatabase(), prepared)

    const row = getDatabase().prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get("value-free-manifest") as { manifest_gz: Uint8Array }
    const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as {
      formatVersion: number
      record: Record<string, unknown>
      tracksExternal?: boolean
    }
    const semanticBytes = Buffer.byteLength(JSON.stringify(body))
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest))
    expect(manifest.formatVersion).toBeGreaterThanOrEqual(2)
    expect(manifest.tracksExternal).toBe(true)
    expect(manifestBytes).toBeLessThan(semanticBytes / 4)
    expect(getV3Operation("value-free-manifest")?.ingress?.request.metadata).toEqual({ ...body, payload: body })
  })

  test("shares clean sequence prefixes while restoring per-occurrence volatile overlays", () => {
    const firstBody = {
      model: "claude-opus-4.8",
      messages: [
        { role: "user", content: [{ type: "text", text: "same first", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "same second" }] },
      ],
    }
    const secondBody = {
      model: "claude-opus-4.8",
      messages: [
        { role: "user", content: [{ type: "text", text: "same first" }] },
        { role: "assistant", content: [{ type: "text", text: "same second", cache_control: { type: "ephemeral", ttl: "5m" } }] },
        { role: "user", content: [{ type: "text", text: "fork tail" }] },
      ],
    }
    const make = (id: string, body: unknown) => {
      const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
      const payload = recorder.registerPayload(body, { origin: { stage: "ingress", track: "client" } })
      recorder.recordIngress({ request: { payload } })
      return recorder.commitTerminal({ outcome: "completed" })
    }
    commitPreparedOperation(getDatabase(), prepareModelOperation(make("overlay-a", firstBody)))
    commitPreparedOperation(getDatabase(), prepareModelOperation(make("overlay-b", secondBody)))

    expect(getV3Operation("overlay-a")?.arena.payloads[0]?.value).toEqual(firstBody)
    expect(getV3Operation("overlay-b")?.arena.payloads[0]?.value).toEqual(secondBody)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_sequence_nodes").get() as { n: number }).n).toBe(3)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_objects WHERE kind='sequence-item'").get() as { n: number }).n).toBe(3)
  })

  test("is idempotent for the same revision and rejects a conflicting digest", () => {
    const original = prepareModelOperation(terminalRecord("op-idempotent"))
    expect(commitPreparedOperation(getDatabase(), original)).toBe("inserted")
    expect(commitPreparedOperation(getDatabase(), original)).toBe("idempotent")

    const conflicting = { ...original, digest: "different" }
    expect(() => commitPreparedOperation(getDatabase(), conflicting)).toThrow(/operation conflict/i)
  })

  test("recovers a self-contained uncommitted journal after the operation transaction fails", () => {
    const prepared = prepareModelOperation(terminalRecord("op-failpoint"))
    getDatabase().exec(V3_SCHEMA_SQL)
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'failpoint'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/failpoint/i)
    const row = getDatabase().prepare("SELECT committed_at FROM v3_journal WHERE operation_id=?").get(prepared.id) as { committed_at: number | null }
    expect(row.committed_at).toBeNull()

    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    expect(recoverV3Journal()).toEqual({ recovered: 1, failures: [] })
    expect(getV3Operation(prepared.id)?.identity.operationId).toBe(prepared.id)
    expect(getDatabase().prepare("SELECT 1 FROM v3_journal WHERE operation_id=?").get(prepared.id)).toBeNull()
  })
})
