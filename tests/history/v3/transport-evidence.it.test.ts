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
  commitPreparedOperation,
  ensureV3Schema,
  garbageCollectTransportEvidence,
  getV3Operation,
  hydrateManifest,
  hydrateTransportEvidence,
  prepareModelOperationWithTransportEvidence,
  recoverV3Journal,
  resetV3WriterForTests,
  setV3TransactionBFailureInjectorForTests,
  type TransactionBStage,
  type TransportEvidenceInput,
  visitV3Summaries,
} from "~/lib/history/v3/store"
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

function terminalRecord(id: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload({ prompt: "transport evidence" }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload: request } })
  const dispatch = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(dispatch, { verdict: "committed" })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: dispatch })
}

function captured(bytes: Uint8Array, dispatchIndex: number, sequence: number): TransportEvidenceInput {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return {
    dispatchIndex,
    sequence,
    capture: { availability: "captured", digest, byteLength: bytes.byteLength, encoding: "binary" },
    bytes,
  }
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
})

afterEach(() => {
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 transport evidence substrate", () => {
  test("rolls back transaction A when evidence CAS insertion fails before journal insertion", () => {
    ensureV3Schema(getDatabase())
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-cas-failure"), [captured(new Uint8Array([51]), 0, 1)])
    getDatabase().exec(`CREATE TRIGGER fail_evidence_insert BEFORE INSERT ON v3_transport_evidence BEGIN SELECT RAISE(ABORT, 'evidence CAS failed'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/evidence CAS failed/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_journal").get() as { n: number }).n).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n).toBe(0)
  })

  test("rolls back transaction A evidence when journal insertion fails", () => {
    ensureV3Schema(getDatabase())
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-journal-failure"), [captured(new Uint8Array([52]), 0, 1)])
    getDatabase().exec(`CREATE TRIGGER fail_journal_insert BEFORE INSERT ON v3_journal BEGIN SELECT RAISE(ABORT, 'journal insert failed'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/journal insert failed/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_journal").get() as { n: number }).n).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n).toBe(0)
  })

  test("persists manifest-v3 ordered event refs while CAS-deduplicating identical evidence bytes", () => {
    const bytes = new Uint8Array([0, 255, 1, 2])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-order"), [captured(bytes, 0, 1), captured(bytes, 0, 2)])

    expect(commitPreparedOperation(getDatabase(), prepared)).toBe("inserted")

    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(1)
    const row = getDatabase().prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(prepared.id) as { manifest_gz: Uint8Array }
    const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as {
      formatVersion: number
      transportEvidenceRefs: Array<{ dispatchIndex: number; sequence: number; digest: string }>
    }
    expect(manifest.formatVersion).toBe(3)
    expect(manifest.transportEvidenceRefs.map(({ dispatchIndex, sequence, digest }) => ({ dispatchIndex, sequence, digest }))).toEqual([
      { dispatchIndex: 0, sequence: 1, digest: prepared.transportEvidence[0].capture.digest },
      { dispatchIndex: 0, sequence: 2, digest: prepared.transportEvidence[1].capture.digest },
    ])
    expect(hydrateTransportEvidence(getDatabase(), prepared.id)).toEqual([
      { dispatchIndex: 0, sequence: 1, capture: prepared.transportEvidence[0].capture, bytes },
      { dispatchIndex: 0, sequence: 2, capture: prepared.transportEvidence[1].capture, bytes },
    ])
  })

  test("writes normalized operation refs from the same ordered manifest source, retaining a shared digest at both sequences", () => {
    const bytes = new Uint8Array([19, 20])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("normalized-operation-refs"), [captured(bytes, 0, 1), captured(bytes, 0, 2)])

    commitPreparedOperation(getDatabase(), prepared)

    expect(
      getDatabase()
        .prepare(
          "SELECT dispatch_index,sequence,digest,byte_length,encoding FROM v3_operation_evidence_refs WHERE operation_id=? ORDER BY dispatch_index,sequence",
        )
        .all(prepared.id),
    ).toEqual([
      { dispatch_index: 0, sequence: 1, digest: prepared.transportEvidence[0].capture.digest, byte_length: 2, encoding: "binary" },
      { dispatch_index: 0, sequence: 2, digest: prepared.transportEvidence[1].capture.digest, byte_length: 2, encoding: "binary" },
    ])
  })

  test.each([
    {
      name: "missing normalized operation ref",
      mutate: (operationId: string) => {
        getDatabase().prepare("DELETE FROM v3_operation_evidence_refs WHERE operation_id=? AND sequence=2").run(operationId)
      },
    },
    {
      name: "extra normalized operation ref",
      mutate: (operationId: string) => {
        const source = getDatabase()
          .prepare("SELECT digest,byte_length,encoding FROM v3_operation_evidence_refs WHERE operation_id=? AND sequence=1")
          .get(operationId) as { digest: string; byte_length: number; encoding: string }
        getDatabase()
          .prepare("INSERT INTO v3_operation_evidence_refs(operation_id,dispatch_index,sequence,digest,byte_length,encoding) VALUES(?,?,?,?,?,?)")
          .run(operationId, 0, 3, source.digest, source.byte_length, source.encoding)
      },
    },
    {
      name: "changed normalized operation ref field",
      mutate: (operationId: string) => {
        getDatabase().prepare("UPDATE v3_operation_evidence_refs SET byte_length=99 WHERE operation_id=? AND sequence=2").run(operationId)
      },
    },
  ])("rejects $name before hydrating canonical detail", ({ mutate }) => {
    const bytes = new Uint8Array([71, 72])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("strict-operation-ref-mismatch"), [captured(bytes, 0, 1), captured(bytes, 0, 2)])
    commitPreparedOperation(getDatabase(), prepared)
    mutate(prepared.id)

    expect(() => getV3Operation(prepared.id)).toThrow(/operation evidence refs mismatch/i)
  })

  test.each([
    {
      name: "stored operation digest",
      mutate: (operationId: string) => {
        getDatabase().prepare("UPDATE v3_operations SET digest=? WHERE operation_id=?").run("0".repeat(64), operationId)
      },
    },
    {
      name: "decodable manifest bytes",
      mutate: (operationId: string) => {
        const row = getDatabase().prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(operationId) as { manifest_gz: Uint8Array }
        const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as { record: Record<string, unknown> }
        manifest.record = { ...manifest.record, strictMutation: true }
        getDatabase()
          .prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?")
          .run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), operationId)
      },
    },
  ])("rejects a changed $name before hydrating canonical detail", ({ mutate }) => {
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("strict-operation-digest-mismatch"), [])
    commitPreparedOperation(getDatabase(), prepared)
    mutate(prepared.id)

    expect(() => getV3Operation(prepared.id)).toThrow(/operation digest mismatch/i)
  })

  test("shares one evidence entity across operations without merging either operation's event sequence", () => {
    const bytes = new Uint8Array([7, 8, 9])
    const first = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-shared-a"), [captured(bytes, 0, 3), captured(bytes, 1, 1)])
    const second = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-shared-b"), [captured(bytes, 0, 9)])

    commitPreparedOperation(getDatabase(), first)
    commitPreparedOperation(getDatabase(), second)

    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(1)
    expect(hydrateTransportEvidence(getDatabase(), first.id).map(({ dispatchIndex, sequence }) => ({ dispatchIndex, sequence }))).toEqual([
      { dispatchIndex: 0, sequence: 3 },
      { dispatchIndex: 1, sequence: 1 },
    ])
    expect(hydrateTransportEvidence(getDatabase(), second.id).map(({ dispatchIndex, sequence }) => ({ dispatchIndex, sequence }))).toEqual([
      { dispatchIndex: 0, sequence: 9 },
    ])
  })

  test("rejects digest, byte-length, encoding, and missing-entity mismatches during hydrate", () => {
    const bytes = new Uint8Array([10, 11, 12])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-corrupt"), [captured(bytes, 0, 1)])
    commitPreparedOperation(getDatabase(), prepared)
    const digest = prepared.transportEvidence[0].capture.digest

    getDatabase().prepare("UPDATE v3_transport_evidence SET byte_length=99 WHERE digest=?").run(digest)
    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow(/byte length mismatch/i)
    getDatabase().prepare("UPDATE v3_transport_evidence SET byte_length=?,encoding='text' WHERE digest=?").run(bytes.byteLength, digest)
    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow(/encoding mismatch/i)
    getDatabase()
      .prepare("UPDATE v3_transport_evidence SET encoding='binary',evidence_gz=? WHERE digest=?")
      .run(new Uint8Array([1]), digest)
    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow()
    getDatabase().exec("PRAGMA foreign_keys = OFF")
    getDatabase().prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(digest)
    getDatabase().exec("PRAGMA foreign_keys = ON")
    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow(/missing transport evidence/i)
    expect(() => getV3Operation(prepared.id)).toThrow(/missing transport evidence/i)
  })

  test.each(
    (["canonical", "tracks", "refs", "strict", "summary"] as const).flatMap((stage) => [
      { stage, markerBefore: false },
      { stage, markerBefore: true },
    ]),
  )("transaction B failure at $stage rolls back B, preserves A, and restores marker=$markerBefore", async ({ stage, markerBefore }) => {
    const db = getDatabase()
    ensureV3Schema(db)
    await applyForwardMigrations(db)
    if (markerBefore) db.prepare("INSERT OR REPLACE INTO history_meta(key,value) VALUES('summary_projection_ready','1')").run()
    const bytes = new Uint8Array([101, 102])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord(`b-fail-${stage}-${markerBefore}`), [captured(bytes, 0, 1)])
    setV3TransactionBFailureInjectorForTests((current: TransactionBStage) => {
      if (current === stage) throw new Error(`transaction B ${stage} failed`)
    })

    expect(() => commitPreparedOperation(db, prepared)).toThrow(new RegExp(`transaction B ${stage} failed`, "i"))

    expect(db.prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_tracks WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_timeline_chunks WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_operation_evidence_refs WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_operation_summaries WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT format_version FROM v3_journal WHERE operation_id=? AND revision=?").get(prepared.id, prepared.revision)).toEqual({
      format_version: 2,
    })
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM v3_journal_evidence_refs WHERE operation_id=? AND revision=?").get(prepared.id, prepared.revision) as {
          n: number
        }
      ).n,
    ).toBe(1)
    expect(db.prepare("SELECT digest FROM v3_transport_evidence WHERE digest=?").get(prepared.transportEvidence[0].capture.digest)).toEqual({
      digest: prepared.transportEvidence[0].capture.digest,
    })
    expect(db.prepare("SELECT value FROM history_meta WHERE key='summary_projection_ready'").get()).toEqual(markerBefore ? { value: "1" } : null)
  })

  test("recovers journal-v2 after transaction B fails, retaining evidence refs", () => {
    const bytes = new Uint8Array([21, 22, 23])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-recovery"), [captured(bytes, 0, 1)])
    ensureV3Schema(getDatabase())
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'transaction B failed'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/transaction B failed/i)
    expect(getDatabase().prepare("SELECT format_version FROM v3_journal WHERE operation_id=?").get(prepared.id)).toEqual({ format_version: 2 })
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(1)

    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    expect(recoverV3Journal()).toBe(1)
    expect(hydrateTransportEvidence(getDatabase(), prepared.id).map(({ sequence }) => sequence)).toEqual([1])
  })

  test("rejects journal recovery when persisted normalized refs are missing, reordered, or extra", () => {
    const evidence = [captured(new Uint8Array([61]), 0, 1), captured(new Uint8Array([62]), 0, 2)]
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("journal-normalized-ref-mismatch"), evidence)
    ensureV3Schema(getDatabase())
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'transaction B failed'); END;`)
    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/transaction B failed/i)
    getDatabase().exec("DROP TRIGGER fail_v3_operation")

    getDatabase().prepare("DELETE FROM v3_journal_evidence_refs WHERE operation_id=? AND revision=? AND sequence=2").run(prepared.id, prepared.revision)

    expect(recoverV3Journal()).toBe(0)
    expect(getDatabase().prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect((getDatabase().prepare("SELECT error FROM v3_journal WHERE operation_id=?").get(prepared.id) as { error: string }).error).toMatch(
      /journal evidence refs mismatch/i,
    )
  })

  test("rejects journal recovery when a persisted normalized ref has an unsupported encoding", () => {
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("journal-normalized-ref-encoding"), [captured(new Uint8Array([63]), 0, 1)])
    ensureV3Schema(getDatabase())
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'transaction B failed'); END;`)
    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/transaction B failed/i)
    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    getDatabase().prepare("UPDATE v3_journal_evidence_refs SET encoding='text' WHERE operation_id=? AND revision=?").run(prepared.id, prepared.revision)

    expect(recoverV3Journal()).toBe(0)
    expect(getDatabase().prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect((getDatabase().prepare("SELECT error FROM v3_journal WHERE operation_id=?").get(prepared.id) as { error: string }).error).toMatch(
      /invalid journal evidence ref encoding: text/i,
    )
  })

  test("rejects invalid manifest versions from detail, evidence, and summary consumers", () => {
    const invalidVersions = [0, -1, 1.5, 999]
    for (const version of invalidVersions) {
      const prepared = prepareModelOperationWithTransportEvidence(terminalRecord(`invalid-manifest-${version}`), [])
      commitPreparedOperation(getDatabase(), prepared)
      const row = getDatabase().prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(prepared.id) as { manifest_gz: Uint8Array }
      const manifest = JSON.parse(new TextDecoder().decode(decompressBytes(row.manifest_gz))) as { formatVersion: number }
      manifest.formatVersion = version
      getDatabase()
        .prepare("UPDATE v3_operations SET manifest_gz=? WHERE operation_id=?")
        .run(compressBytes(new TextEncoder().encode(JSON.stringify(manifest))), prepared.id)

      expect(() => getV3Operation(prepared.id), `detail version ${version}`).toThrow(/unsupported manifest format version/i)
      expect(() => hydrateTransportEvidence(getDatabase(), prepared.id), `evidence version ${version}`).toThrow(/unsupported manifest format version/i)
      expect(() => {
        const summaries: Array<string> = []
        visitV3Summaries((summary) => summaries.push(summary.id))
      }, `summary version ${version}`).toThrow(/unsupported manifest format version/i)
    }
  })

  test("rejects future journal formats without publishing an operation", () => {
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-future-journal"), [])
    ensureV3Schema(getDatabase())
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'transaction B failed'); END;`)
    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/transaction B failed/i)
    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    getDatabase().prepare("UPDATE v3_journal SET format_version=999 WHERE operation_id=?").run(prepared.id)

    expect(recoverV3Journal()).toBe(0)
    expect(getV3Operation(prepared.id)).toBeUndefined()
    expect((getDatabase().prepare("SELECT error FROM v3_journal WHERE operation_id=?").get(prepared.id) as { error: string }).error).toMatch(
      /unsupported journal format version: 999/i,
    )
  })

  test("garbage collection keeps the union of manifest and journal roots and deletes only unreachable evidence", () => {
    const manifestBytes = new Uint8Array([31])
    const journalBytes = new Uint8Array([32])
    const unreachableBytes = new Uint8Array([33])
    const manifestPrepared = prepareModelOperationWithTransportEvidence(terminalRecord("gc-manifest-root"), [captured(manifestBytes, 0, 1)])
    commitPreparedOperation(getDatabase(), manifestPrepared)
    const journalPrepared = prepareModelOperationWithTransportEvidence(terminalRecord("gc-journal-root"), [captured(journalBytes, 0, 1)])
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'transaction B failed'); END;`)
    expect(() => commitPreparedOperation(getDatabase(), journalPrepared)).toThrow(/transaction B failed/i)
    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    const unreachable = captured(unreachableBytes, 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(unreachable.capture.digest, "binary", compressBytes(unreachableBytes), 1)

    expect(garbageCollectTransportEvidence(getDatabase())).toBe(1)
    expect(
      (getDatabase().prepare("SELECT digest FROM v3_transport_evidence ORDER BY digest").all() as Array<{ digest: string }>).map(({ digest }) => digest).sort(),
    ).toEqual([manifestPrepared.transportEvidence[0].capture.digest, journalPrepared.transportEvidence[0].capture.digest].sort())
  })

  test("transport evidence hydration refuses normalized refs that diverge from the manifest", () => {
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-normalized-ref-mismatch"), [
      captured(new Uint8Array([56]), 0, 1),
      captured(new Uint8Array([57]), 0, 2),
    ])
    commitPreparedOperation(getDatabase(), prepared)
    getDatabase().prepare("DELETE FROM v3_operation_evidence_refs WHERE operation_id=? AND sequence=2").run(prepared.id)

    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow(/operation evidence refs mismatch/i)
  })

  test("transport evidence hydration refuses a manifest whose embedded identity belongs to another row", () => {
    const shared = captured(new Uint8Array([58]), 0, 1)
    const first = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-identity-first"), [shared])
    const second = prepareModelOperationWithTransportEvidence(terminalRecord("evidence-identity-second"), [shared])
    commitPreparedOperation(getDatabase(), first)
    commitPreparedOperation(getDatabase(), second)
    expect(hydrateTransportEvidence(getDatabase(), first.id)).toHaveLength(1)
    getDatabase()
      .prepare(
        `UPDATE v3_operations
         SET manifest_gz=(SELECT manifest_gz FROM v3_operations WHERE operation_id=?),
             digest=(SELECT digest FROM v3_operations WHERE operation_id=?)
         WHERE operation_id=?`,
      )
      .run(second.id, second.id, first.id)

    expect(() => hydrateTransportEvidence(getDatabase(), first.id)).toThrow(/manifest operation identity mismatch/i)
  })

  test("garbage collection refuses a manifest whose embedded identity belongs to another row before deleting", () => {
    const shared = captured(new Uint8Array([59]), 0, 1)
    const first = prepareModelOperationWithTransportEvidence(terminalRecord("gc-identity-first"), [shared])
    const second = prepareModelOperationWithTransportEvidence(terminalRecord("gc-identity-second"), [shared])
    commitPreparedOperation(getDatabase(), first)
    commitPreparedOperation(getDatabase(), second)
    getDatabase()
      .prepare(
        `UPDATE v3_operations
         SET manifest_gz=(SELECT manifest_gz FROM v3_operations WHERE operation_id=?),
             digest=(SELECT digest FROM v3_operations WHERE operation_id=?)
         WHERE operation_id=?`,
      )
      .run(second.id, second.id, first.id)
    const orphan = captured(new Uint8Array([60]), 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(orphan.capture.digest, orphan.capture.encoding, compressBytes(orphan.bytes), orphan.capture.byteLength)

    expect(() => garbageCollectTransportEvidence(getDatabase())).toThrow(/manifest operation identity mismatch/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(2)
  })

  test("garbage collection refuses normalized operation refs that diverge from the manifest before deleting", () => {
    const referenced = prepareModelOperationWithTransportEvidence(terminalRecord("gc-normalized-ref-mismatch"), [
      captured(new Uint8Array([61]), 0, 1),
      captured(new Uint8Array([62]), 0, 2),
    ])
    commitPreparedOperation(getDatabase(), referenced)
    const orphan = captured(new Uint8Array([63]), 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(orphan.capture.digest, orphan.capture.encoding, compressBytes(orphan.bytes), orphan.capture.byteLength)
    getDatabase().prepare("DELETE FROM v3_operation_evidence_refs WHERE operation_id=? AND sequence=2").run(referenced.id)

    expect(() => garbageCollectTransportEvidence(getDatabase())).toThrow(/operation evidence refs mismatch/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(3)
  })

  test("a v3 manifest is still reconciled when the normalized ref table is missing", async () => {
    const db = getDatabase()
    ensureV3Schema(db)
    await applyForwardMigrations(db)
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("v3-missing-ref-table"), [captured(new Uint8Array([130]), 0, 1)])
    commitPreparedOperation(db, prepared)
    const row = db.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(prepared.id) as { manifest_gz: Uint8Array }
    expect(hydrateManifest(db, row.manifest_gz, prepared.id).identity.operationId).toBe(prepared.id)

    // The legacy allowance is "pre-schema-6 has nothing to reconcile against".
    // A v3 envelope carries a non-empty ref set, so if the table it must be
    // reconciled against is gone, that is a missing counterpart — not an
    // exemption. Skipping here would fail OPEN on exactly the input the check
    // exists for.
    db.exec("DROP TABLE v3_operation_evidence_refs")

    expect(() => hydrateManifest(db, row.manifest_gz, prepared.id)).toThrow()
  })

  test("the commit-time strict gate aborts transaction B when persisted refs stop matching the manifest", async () => {
    const db = getDatabase()
    ensureV3Schema(db)
    await applyForwardMigrations(db)
    db.prepare("INSERT OR REPLACE INTO history_meta(key,value) VALUES('summary_projection_ready','1')").run()
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("b-strict-gate"), [
      captured(new Uint8Array([120]), 0, 1),
      captured(new Uint8Array([121]), 0, 2),
    ])
    // Corrupt REAL data inside transaction B rather than throwing at a stage
    // marker. A thrown injector proves only "we roll back at this point" — it
    // stays green even if the strict re-hydrate is deleted outright, because the
    // two are independent. Deleting a ref the manifest still claims is the only
    // shape that fails iff the gate actually runs.
    setV3TransactionBFailureInjectorForTests((stage) => {
      if (stage === "refs") db.prepare("DELETE FROM v3_operation_evidence_refs WHERE operation_id=? AND sequence=2").run(prepared.id)
    })

    expect(() => commitPreparedOperation(db, prepared)).toThrow(/operation evidence refs mismatch/i)
    setV3TransactionBFailureInjectorForTests(null)

    // Fail-closed: nothing canonical or derived is published, and the global
    // marker keeps the value it had before the attempt.
    expect(db.prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_operation_summaries WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT 1 FROM v3_operation_evidence_refs WHERE operation_id=?").get(prepared.id)).toBeNull()
    expect(db.prepare("SELECT value FROM history_meta WHERE key='summary_projection_ready'").get()).toEqual({ value: "1" })
    expect(db.prepare("SELECT format_version FROM v3_journal WHERE operation_id=? AND revision=?").get(prepared.id, prepared.revision)).toEqual({
      format_version: 2,
    })
  })

  test("rejects journal recovery when the payload's embedded identity belongs to another journal row", () => {
    const shared = captured(new Uint8Array([90]), 0, 1)
    const first = prepareModelOperationWithTransportEvidence(terminalRecord("journal-identity-first"), [shared])
    const second = prepareModelOperationWithTransportEvidence(terminalRecord("journal-identity-second"), [shared])
    setV3TransactionBFailureInjectorForTests((stage) => {
      if (stage === "canonical") throw new Error("leave transaction A pending")
    })
    expect(() => commitPreparedOperation(getDatabase(), first)).toThrow(/leave transaction A pending/i)
    expect(() => commitPreparedOperation(getDatabase(), second)).toThrow(/leave transaction A pending/i)
    setV3TransactionBFailureInjectorForTests(null)
    // Both rows are individually well-formed and share one evidence set, so their
    // normalized refs stay equal after the swap: refs/revision/digest checks all
    // agree and only an owner-identity binding can reject it.
    getDatabase()
      .prepare(
        `UPDATE v3_journal
         SET payload_gz=(SELECT payload_gz FROM v3_journal WHERE operation_id=?),
             digest=(SELECT digest FROM v3_journal WHERE operation_id=?)
         WHERE operation_id=?`,
      )
      .run(second.id, second.id, first.id)

    expect(recoverV3Journal()).toBe(1)
    expect(getDatabase().prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(first.id)).toBeNull()
    expect((getDatabase().prepare("SELECT error FROM v3_journal WHERE operation_id=?").get(first.id) as { error: string }).error).toMatch(
      // Pinned to the decode-time assertion's own wording. The adjacent
      // `prepared.id` check raises the same sentence without the expected/got
      // detail, so a looser pattern would pass on either and this case would
      // stop being a positive control for the decode-side binding.
      /journal operation identity mismatch: expected .*, got /,
    )
  })

  test("garbage collection refuses a journal payload whose embedded identity belongs to another row before deleting", () => {
    const shared = captured(new Uint8Array([91]), 0, 1)
    const first = prepareModelOperationWithTransportEvidence(terminalRecord("gc-journal-identity-first"), [shared])
    const second = prepareModelOperationWithTransportEvidence(terminalRecord("gc-journal-identity-second"), [shared])
    setV3TransactionBFailureInjectorForTests((stage) => {
      if (stage === "canonical") throw new Error("leave transaction A pending")
    })
    expect(() => commitPreparedOperation(getDatabase(), first)).toThrow(/leave transaction A pending/i)
    expect(() => commitPreparedOperation(getDatabase(), second)).toThrow(/leave transaction A pending/i)
    setV3TransactionBFailureInjectorForTests(null)
    getDatabase()
      .prepare(
        `UPDATE v3_journal
         SET payload_gz=(SELECT payload_gz FROM v3_journal WHERE operation_id=?),
             digest=(SELECT digest FROM v3_journal WHERE operation_id=?)
         WHERE operation_id=?`,
      )
      .run(second.id, second.id, first.id)
    const orphan = captured(new Uint8Array([92]), 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(orphan.capture.digest, orphan.capture.encoding, compressBytes(orphan.bytes), orphan.capture.byteLength)

    expect(() => garbageCollectTransportEvidence(getDatabase())).toThrow(/journal operation identity mismatch/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(2)
  })

  test("garbage collection refuses normalized journal refs that diverge from the payload before deleting", () => {
    const referenced = prepareModelOperationWithTransportEvidence(terminalRecord("gc-journal-ref-mismatch"), [
      captured(new Uint8Array([64]), 0, 1),
      captured(new Uint8Array([65]), 0, 2),
    ])
    setV3TransactionBFailureInjectorForTests((stage) => {
      if (stage === "canonical") throw new Error("leave transaction A pending")
    })
    expect(() => commitPreparedOperation(getDatabase(), referenced)).toThrow(/leave transaction A pending/i)
    setV3TransactionBFailureInjectorForTests(null)
    getDatabase().prepare("DELETE FROM v3_journal_evidence_refs WHERE operation_id=? AND revision=? AND sequence=2").run(referenced.id, referenced.revision)
    const orphan = captured(new Uint8Array([66]), 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(orphan.capture.digest, orphan.capture.encoding, compressBytes(orphan.bytes), orphan.capture.byteLength)

    expect(() => garbageCollectTransportEvidence(getDatabase())).toThrow(/journal evidence refs mismatch/i)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_transport_evidence").get() as { n: number }).n).toBe(3)
  })

  test("garbage collection fails loud before deleting when any root has invalid refs or missing evidence", () => {
    const bytes = new Uint8Array([41])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("gc-missing-root"), [captured(bytes, 0, 1)])
    commitPreparedOperation(getDatabase(), prepared)
    getDatabase().exec("PRAGMA foreign_keys = OFF")
    getDatabase().prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(prepared.transportEvidence[0].capture.digest)
    getDatabase().exec("PRAGMA foreign_keys = ON")
    const orphan = captured(new Uint8Array([42]), 0, 1)
    getDatabase()
      .prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)")
      .run(orphan.capture.digest, "binary", compressBytes(orphan.bytes), 1)

    expect(() => garbageCollectTransportEvidence(getDatabase())).toThrow(/missing transport evidence/i)
    expect(getDatabase().prepare("SELECT 1 FROM v3_transport_evidence WHERE digest=?").get(orphan.capture.digest)).not.toBeNull()
  })

  test("fails before writing when the supplied bytes do not match the captured digest", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const bad = captured(bytes, 0, 1)
    bad.capture = { ...bad.capture, digest: "0".repeat(64) }
    expect(() => prepareModelOperationWithTransportEvidence(terminalRecord("evidence-bad-input"), [bad])).toThrow(/digest mismatch/i)
  })
})
