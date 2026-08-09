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

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  ensureV3Schema,
  getV3Operation,
  legacyManifestV1Digest,
  legacyManifestV2Digest,
  recoverV3Journal,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import { compressBytes } from "~/lib/sqlite/compression"

import frozenDigests from "./fixtures/transport-evidence/legacy-digests.json"
import frozenRecordJson from "./fixtures/transport-evidence/legacy-record.json"

const frozenRecord = frozenRecordJson as unknown as ModelOperationRecord
const encoder = new TextEncoder()

/** Independent frozen writer-v1 oracle. It intentionally does not call store.ts digest helpers. */
function fixtureWriterV1Digest(record: ModelOperationRecord): string {
  const canonicalize = (value: unknown): string => {
    const normalize = (input: unknown): unknown => {
      if (input === null || typeof input !== "object") return input
      if (Array.isArray(input)) return input.map(normalize)
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, normalize(value)]),
      )
    }
    return JSON.stringify(normalize(value))
  }
  const hash = (version: number, domain: string, bytes: Uint8Array): string =>
    createHash("sha256").update(`history-v3:${version}:${domain}\0`).update(bytes).digest("hex")
  const objectHashes = new Map<string, string>()
  for (const node of record.arena.payloads) objectHashes.set(node.handle, hash(1, "object:payload", encoder.encode(canonicalize(node.value))))
  for (const node of record.arena.frames) objectHashes.set(node.handle, hash(1, "object:frame", encoder.encode(canonicalize(node.value))))
  const manifestRecord = {
    ...record,
    arena: {
      payloads: record.arena.payloads.map(({ value: _value, ...node }) => node),
      frames: record.arena.frames.map(({ value: _value, ...node }) => node),
    },
  }
  const manifest = encoder.encode(JSON.stringify({ formatVersion: 1, record: manifestRecord, objectHashes: Object.fromEntries(objectHashes) }))
  return hash(1, "operation", manifest)
}

function insertLegacyJournal(digest: string): void {
  ensureV3Schema(getDatabase())
  getDatabase()
    .prepare("INSERT INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,format_version) VALUES(?,?,?,?,?,?,1)")
    .run(frozenRecord.identity.operationId, frozenRecord.lastSequence, digest, "terminal", compressBytes(encoder.encode(JSON.stringify(frozenRecord))), 2_000)
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

describe("frozen History V3 transport-evidence legacy fixtures", () => {
  test("keeps two independent frozen legacy digest oracles stable", () => {
    expect(fixtureWriterV1Digest(frozenRecord)).toBe(frozenDigests.manifestV1)
    expect(legacyManifestV1Digest(frozenRecord)).toBe(frozenDigests.manifestV1)
    expect(legacyManifestV2Digest(frozenRecord)).toBe(frozenDigests.manifestV2)
    expect(frozenDigests.manifestV1).not.toBe(frozenDigests.manifestV2)
  })

  for (const [label, digest] of [
    ["manifest-v1", frozenDigests.manifestV1],
    ["manifest-v2", frozenDigests.manifestV2],
  ] as const) {
    test(`recovers frozen journal-v1 whose digest came from ${label}`, () => {
      insertLegacyJournal(digest)
      expect(recoverV3Journal().recovered).toBe(1)
      const hydrated = getV3Operation(frozenRecord.identity.operationId)
      expect(hydrated?.identity).toEqual(frozenRecord.identity)
      expect(hydrated?.arena).toEqual(frozenRecord.arena)
      expect(hydrated?.terminal).toEqual(frozenRecord.terminal)
      expect(getDatabase().prepare("SELECT 1 FROM v3_journal WHERE operation_id=?").get(frozenRecord.identity.operationId)).toBeNull()
    })
  }

  test("does not accept a manifest-v3 digest as a journal-v1 oracle", () => {
    insertLegacyJournal("0".repeat(64))
    expect(recoverV3Journal().recovered).toBe(0)
    expect(getV3Operation(frozenRecord.identity.operationId)).toBeUndefined()
    expect(
      (getDatabase().prepare("SELECT error FROM v3_journal WHERE operation_id=?").get(frozenRecord.identity.operationId) as { error: string }).error,
    ).toMatch(/journal digest mismatch/i)
  })
})
