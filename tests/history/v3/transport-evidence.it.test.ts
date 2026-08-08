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
import {
  //
  commitPreparedOperation,
  ensureV3Schema,
  garbageCollectTransportEvidence,
  getV3Operation,
  hydrateTransportEvidence,
  prepareModelOperationWithTransportEvidence,
  recoverV3Journal,
  resetV3WriterForTests,
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
    getDatabase().prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(digest)
    expect(() => hydrateTransportEvidence(getDatabase(), prepared.id)).toThrow(/missing transport evidence/i)
    expect(() => getV3Operation(prepared.id)).toThrow(/missing transport evidence/i)
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

  test("garbage collection fails loud before deleting when any root has invalid refs or missing evidence", () => {
    const bytes = new Uint8Array([41])
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("gc-missing-root"), [captured(bytes, 0, 1)])
    commitPreparedOperation(getDatabase(), prepared)
    getDatabase().prepare("DELETE FROM v3_transport_evidence WHERE digest=?").run(prepared.transportEvidence[0].capture.digest)
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
