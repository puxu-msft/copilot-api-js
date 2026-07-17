import { createHash } from "node:crypto"

import type {
  //
  ArenaNodeReference,
  ModelOperationRecord,
} from "~/lib/context/model-operation-record"

import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

import type { Database } from "../sqlite/connection"

import { getDatabase } from "../sqlite/connection"

const FORMAT_VERSION = 1
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface V3StoredOperation {
  record: ModelOperationRecord
  pinned: boolean
}

export interface V3StoreStatus {
  pendingOperations: number
  pendingBytes: number
  persistedOperations: number
  failedOperations: number
  conflicts: number
  searchBacklog: number
  lastError?: string
}

interface PreparedObject {
  hash: string
  kind: "payload" | "frame"
  canonical: Uint8Array
  compressed: Uint8Array
}

interface PreparedOperation {
  id: string
  revision: number
  digest: string
  kind: string
  createdAt: number
  terminalSequence: number
  manifest: Uint8Array
  compressedManifest: Uint8Array
  compressedJournalRecord: Uint8Array
  objects: PreparedObject[]
  tracks: Array<{ name: string; attemptIndex: number; refs: string }>
  timeline: Array<{ chunkIndex: number; firstSequence: number; lastSequence: number; payload: Uint8Array; compressed: Uint8Array }>
  searchObjects: Array<{ hash: string; document: string }>
  byteLength: number
}

interface PendingOperation {
  record: ModelOperationRecord
  estimatedBytes: number
  resolve: () => void
}

const pending: PendingOperation[] = []
const pendingDrains = new Set<Promise<void>>()
let pendingBytes = 0
let draining = false
let status: V3StoreStatus = {
  pendingOperations: 0,
  pendingBytes: 0,
  persistedOperations: 0,
  failedOperations: 0,
  conflicts: 0,
  searchBacklog: 0,
}

export const V3_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS v3_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_objects (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_gz BLOB NOT NULL,
  canonical_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_operations (
  operation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  terminal_sequence INTEGER NOT NULL,
  manifest_gz BLOB NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  committed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_operations_created ON v3_operations(created_at DESC, operation_id DESC);
CREATE INDEX IF NOT EXISTS idx_v3_operations_kind ON v3_operations(kind, created_at DESC);
CREATE TABLE IF NOT EXISTS v3_tracks (
  operation_id TEXT NOT NULL REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
  track_name TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  refs_json TEXT NOT NULL,
  PRIMARY KEY(operation_id, track_name, attempt_index)
);
CREATE TABLE IF NOT EXISTS v3_timeline_chunks (
  operation_id TEXT NOT NULL REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  payload_gz BLOB NOT NULL,
  PRIMARY KEY(operation_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS v3_journal (
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  phase TEXT NOT NULL,
  payload_gz BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  error TEXT,
  PRIMARY KEY(operation_id, revision)
);
CREATE TABLE IF NOT EXISTS v3_search_objects (
  object_hash TEXT PRIMARY KEY,
  document_gz BLOB NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_search_membership (
  operation_id TEXT NOT NULL REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
  object_hash TEXT NOT NULL,
  PRIMARY KEY(operation_id, object_hash)
);
CREATE TABLE IF NOT EXISTS v3_search_backlog (
  operation_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`

function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input
    if (seen.has(input as object)) throw new Error("[history/v3] cyclic semantic value")
    seen.add(input as object)
    if (Array.isArray(input)) return input.map(normalize)
    if (ArrayBuffer.isView(input)) return { $bytes: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64") }
    return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, normalize(nested)]))
  }
  return JSON.stringify(normalize(value))
}

function digestBytes(domain: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`history-v3:${FORMAT_VERSION}:${domain}\0`).update(bytes).digest("hex")
}

function objectHash(kind: string, value: unknown): PreparedObject {
  const canonical = encoder.encode(canonicalize(value))
  return { hash: digestBytes(`object:${kind}`, canonical), kind: kind as "payload" | "frame", canonical, compressed: compressBytes(canonical) }
}

function refs(track: { payload?: string; frames: ReadonlyArray<string> } | undefined): string {
  return JSON.stringify(track ? { payload: track.payload, frames: track.frames } : { frames: [] })
}

function collectTracks(record: ModelOperationRecord): PreparedOperation["tracks"] {
  const out: PreparedOperation["tracks"] = []
  if (record.ingress) out.push({ name: "client-ingress", attemptIndex: -1, refs: refs(record.ingress.request) })
  for (const [index, attempt] of record.attempts.entries()) {
    out.push({ name: "effective-request", attemptIndex: index, refs: refs(attempt.effectiveRequest) })
    out.push({ name: "upstream-request", attemptIndex: index, refs: refs(attempt.upstreamRequest) })
    out.push({ name: "upstream-response", attemptIndex: index, refs: refs(attempt.upstreamResponse) })
  }
  if (record.egress) {
    out.push({ name: "upstream-egress", attemptIndex: -1, refs: refs(record.egress.upstream) })
    out.push({ name: "client-egress", attemptIndex: -1, refs: refs(record.egress.client) })
  }
  return out
}

function references(record: ModelOperationRecord): Set<string> {
  const handles = new Set<string>()
  const add = (reference: ArenaNodeReference): void => void handles.add(reference.handle)
  for (const transform of record.transforms) {
    transform.inputs.forEach(add)
    transform.outputs.forEach(add)
  }
  const addTrack = (track: { payload?: string; frames: ReadonlyArray<string> } | undefined): void => {
    if (track?.payload) handles.add(track.payload)
    track?.frames.forEach((handle) => handles.add(handle))
  }
  if (record.ingress) addTrack(record.ingress.request)
  record.attempts.forEach((attempt) => {
    addTrack(attempt.effectiveRequest)
    addTrack(attempt.upstreamRequest)
    addTrack(attempt.upstreamResponse)
  })
  if (record.egress) {
    addTrack(record.egress.upstream)
    addTrack(record.egress.client)
  }
  return handles
}

function searchObjects(record: ModelOperationRecord, objectHashes: Map<string, string>): PreparedOperation["searchObjects"] {
  const documents = new Map<string, string>()
  const used = references(record)
  for (const node of record.arena.payloads) {
    const hash = objectHashes.get(node.handle)
    if (hash && used.has(node.handle)) documents.set(hash, canonicalize(node.value))
  }
  return [...documents].map(([hash, document]) => ({ hash, document }))
}

export function prepareModelOperation(record: ModelOperationRecord): PreparedOperation {
  if (!record.terminal) throw new Error("[history/v3] terminal record required")
  const objects = [
    ...record.arena.payloads.map((node) => objectHash("payload", node.value)),
    ...record.arena.frames.map((node) => objectHash("frame", node.value)),
  ]
  const objectHashes = new Map<string, string>()
  record.arena.payloads.forEach((node, index) => objectHashes.set(node.handle, objects[index].hash))
  record.arena.frames.forEach((node, index) => objectHashes.set(node.handle, objects[record.arena.payloads.length + index].hash))
  // Values live only in v3_objects. The manifest retains node metadata + the
  // handle→hash map, avoiding a second full copy of every payload/frame.
  const manifestValue = {
    ...record,
    arena: {
      payloads: record.arena.payloads.map(({ value: _value, ...node }) => node),
      frames: record.arena.frames.map(({ value: _value, ...node }) => node),
    },
  }
  const manifestText = JSON.stringify({ formatVersion: FORMAT_VERSION, record: manifestValue, objectHashes: Object.fromEntries(objectHashes) })
  const manifest = encoder.encode(manifestText)
  const journalRecord = encoder.encode(JSON.stringify(record))
  const digest = digestBytes("operation", manifest)
  const timelineEvents = [
    ...record.arena.payloads.map((node) => ({ sequence: node.sequence, type: "payload", handle: node.handle })),
    ...record.arena.frames.map((node) => ({ sequence: node.sequence, type: "frame", handle: node.handle })),
    ...record.transforms.map((event) => ({ sequence: event.sequence, type: "transform", value: event })),
    ...record.attempts.flatMap((attempt) => [
      { sequence: attempt.sequence, type: "attempt", handle: attempt.handle },
      ...attempt.diagnostics.map((diagnostic) => ({ sequence: diagnostic.sequence, type: "diagnostic", value: diagnostic })),
      ...(attempt.settledSequence ? [{ sequence: attempt.settledSequence, type: "attempt-settled", handle: attempt.handle, verdict: attempt.verdict }] : []),
    ]),
    { sequence: record.terminal.sequence, type: "terminal", value: record.terminal },
  ].sort((a, b) => a.sequence - b.sequence)
  const chunkSize = 128
  const timeline = Array.from({ length: Math.ceil(timelineEvents.length / chunkSize) }, (_, chunkIndex) => {
    const chunk = timelineEvents.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize)
    return {
      chunkIndex,
      firstSequence: chunk[0]?.sequence ?? 0,
      lastSequence: chunk.at(-1)?.sequence ?? 0,
      payload: encoder.encode(JSON.stringify(chunk)),
      compressed: compressBytes(encoder.encode(JSON.stringify(chunk))),
    }
  })
  // Tracks use compact operation-local handles; the manifest owns the single
  // handle→CAS hash dictionary. Repeating 64-byte hashes per occurrence defeats
  // CAS for long SSE tracks.
  const tracks = collectTracks(record)
  return {
    id: record.identity.operationId,
    revision: record.lastSequence,
    digest,
    kind: record.identity.kind,
    createdAt: record.identity.createdAt,
    terminalSequence: record.terminal.sequence,
    manifest,
    compressedManifest: compressBytes(manifest),
    compressedJournalRecord: compressBytes(journalRecord),
    objects,
    tracks,
    timeline,
    searchObjects: searchObjects(record, objectHashes),
    byteLength: manifest.byteLength + objects.reduce((sum, object) => sum + object.canonical.byteLength, 0),
  }
}

function insertObject(db: Database, object: PreparedObject): void {
  const existing = db.prepare("SELECT canonical_gz FROM v3_objects WHERE hash = ?").get(object.hash) as { canonical_gz: Uint8Array } | undefined
  if (existing) {
    const existingBytes = decompressBytes(existing.canonical_gz)
    if (!Buffer.from(existingBytes).equals(Buffer.from(object.canonical))) throw new Error(`[history/v3] object hash collision: ${object.hash}`)
    return
  }
  db.prepare("INSERT INTO v3_objects(hash,kind,canonical_gz,canonical_bytes) VALUES(?,?,?,?)").run(
    object.hash,
    object.kind,
    object.compressed,
    object.canonical.byteLength,
  )
}

export function commitPreparedOperation(db: Database, prepared: PreparedOperation): "inserted" | "idempotent" {
  db.exec(V3_SCHEMA_SQL)
  const existing = db.prepare("SELECT revision,digest FROM v3_operations WHERE operation_id = ?").get(prepared.id) as { revision: number; digest: string } | undefined
  if (existing) {
    if (existing.revision === prepared.revision && existing.digest === prepared.digest) return "idempotent"
    status = { ...status, conflicts: status.conflicts + 1, lastError: `operation conflict: ${prepared.id}` }
    throw new Error(`[history/v3] operation conflict: ${prepared.id}`)
  }
  // Journal is self-contained: operation tx rollback may remove every CAS object,
  // so recovery cannot depend on value-stripped manifest + v3_objects.
  const journalPayload = prepared.compressedJournalRecord
  db.prepare("INSERT OR REPLACE INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,committed_at,error) VALUES(?,?,?,?,?,?,NULL,NULL)").run(
    prepared.id,
    prepared.revision,
    prepared.digest,
    "terminal",
    journalPayload,
    Date.now(),
  )
  const tx = db.transaction(() => {
    for (const object of prepared.objects) insertObject(db, object)
    db.prepare("INSERT INTO v3_operations(operation_id,revision,digest,kind,created_at,terminal_sequence,manifest_gz,committed_at) VALUES(?,?,?,?,?,?,?,?)").run(
      prepared.id,
      prepared.revision,
      prepared.digest,
      prepared.kind,
      prepared.createdAt,
      prepared.terminalSequence,
      prepared.compressedManifest,
      Date.now(),
    )
    const trackStmt = db.prepare("INSERT INTO v3_tracks(operation_id,track_name,attempt_index,refs_json) VALUES(?,?,?,?)")
    for (const track of prepared.tracks) trackStmt.run(prepared.id, track.name, track.attemptIndex, track.refs)
    const timelineStmt = db.prepare("INSERT INTO v3_timeline_chunks(operation_id,chunk_index,first_sequence,last_sequence,payload_gz) VALUES(?,?,?,?,?)")
    for (const chunk of prepared.timeline) timelineStmt.run(prepared.id, chunk.chunkIndex, chunk.firstSequence, chunk.lastSequence, chunk.compressed)
    try {
      const existingSearch = db.prepare("SELECT 1 FROM v3_search_objects WHERE object_hash=?")
      const insertSearch = db.prepare("INSERT INTO v3_search_objects(object_hash,document_gz,version) VALUES(?,?,?)")
      const insertMembership = db.prepare("INSERT INTO v3_search_membership(operation_id,object_hash) VALUES(?,?)")
      for (const object of prepared.searchObjects) {
        if (!existingSearch.get(object.hash)) insertSearch.run(object.hash, compressBytes(encoder.encode(object.document)), FORMAT_VERSION)
        insertMembership.run(prepared.id, object.hash)
      }
    } catch (error) {
      db.prepare("INSERT OR REPLACE INTO v3_search_backlog(operation_id,reason,attempts,updated_at) VALUES(?,?,COALESCE((SELECT attempts FROM v3_search_backlog WHERE operation_id=?),0)+1,?)").run(
        prepared.id,
        error instanceof Error ? error.message : String(error),
        prepared.id,
        Date.now(),
      )
    }
    // Once the operation transaction commits, the durable manifest + CAS objects are the
    // recovery source. Keeping the self-contained journal payload after this point would
    // duplicate every semantic value forever and defeat content-addressed storage.
    db.prepare("DELETE FROM v3_journal WHERE operation_id=? AND revision=?").run(prepared.id, prepared.revision)
  })
  tx()
  return "inserted"
}

function estimateRecordBytes(record: ModelOperationRecord): number {
  try {
    return Buffer.byteLength(JSON.stringify(record))
  } catch {
    return 1024
  }
}

async function runDrain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.length > 0) {
      const item = pending.shift()!
      pendingBytes -= item.estimatedBytes
      status = { ...status, pendingOperations: pending.length, pendingBytes }
      try {
        const prepared = await Promise.resolve().then(() => prepareModelOperation(item.record))
        const result = commitPreparedOperation(getDatabase(), prepared)
        if (result === "inserted") status = { ...status, persistedOperations: status.persistedOperations + 1 }
      } catch (error) {
        status = {
          ...status,
          failedOperations: status.failedOperations + 1,
          lastError: error instanceof Error ? error.message : String(error),
        }
      } finally {
        item.resolve()
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    draining = false
    status = { ...status, pendingOperations: pending.length, pendingBytes }
  }
}

/** Enqueue a terminal record; resolves after its commit attempt without throwing. */
export function enqueueModelOperation(record: ModelOperationRecord): Promise<void> {
  const estimatedBytes = estimateRecordBytes(record)
  let resolve!: () => void
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve
  })
  pending.push({ record, estimatedBytes, resolve })
  pendingBytes += estimatedBytes
  status = { ...status, pendingOperations: pending.length, pendingBytes }
  let drain: Promise<void>
  drain = runDrain()
    .catch(() => undefined)
    .finally(() => pendingDrains.delete(drain))
  pendingDrains.add(drain)
  return done
}

export async function drainV3Writer(): Promise<void> {
  while (pending.length > 0 || pendingDrains.size > 0) {
    await Promise.allSettled([...pendingDrains])
    if (pending.length > 0) await runDrain()
  }
}

export function getV3StoreStatus(): V3StoreStatus {
  const db = getDatabase()
  db.exec(V3_SCHEMA_SQL)
  const searchBacklog = (db.prepare("SELECT COUNT(*) AS n FROM v3_search_backlog").get() as { n: number }).n
  return { ...status, pendingOperations: pending.length, pendingBytes, searchBacklog }
}

export function getV3StoredOperation(operationId: string): V3StoredOperation | undefined {
  const db = getDatabase()
  db.exec(V3_SCHEMA_SQL)
  const row = db.prepare("SELECT manifest_gz,pinned FROM v3_operations WHERE operation_id=?").get(operationId) as
    | { manifest_gz: Uint8Array; pinned: number }
    | undefined
  if (!row) return undefined
  return { record: hydrateManifest(db, row.manifest_gz), pinned: row.pinned === 1 }
}

export function getV3Operation(operationId: string): ModelOperationRecord | undefined {
  return getV3StoredOperation(operationId)?.record
}

export function listV3StoredOperations(kind?: string, limit = 100): V3StoredOperation[] {
  const db = getDatabase()
  db.exec(V3_SCHEMA_SQL)
  const rows = kind ?
      db.prepare("SELECT manifest_gz,pinned FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ?").all(kind, limit)
    : db.prepare("SELECT manifest_gz,pinned FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ?").all(limit)
  return (rows as Array<{ manifest_gz: Uint8Array; pinned: number }>).map((row) => ({
    record: hydrateManifest(db, row.manifest_gz),
    pinned: row.pinned === 1,
  }))
}

export function listV3Operations(kind?: string, limit = 100): ModelOperationRecord[] {
  return listV3StoredOperations(kind, limit).map(({ record }) => record)
}

export function setV3OperationPinned(operationId: string, pinned: boolean): boolean {
  const db = getDatabase()
  db.exec(V3_SCHEMA_SQL)
  const exists = db.prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(operationId)
  if (!exists) return false
  db.prepare("UPDATE v3_operations SET pinned=? WHERE operation_id=?").run(pinned ? 1 : 0, operationId)
  return true
}

export function searchV3OperationIds(query: string, kind: string | undefined, limit: number): string[] {
  const rows = kind ?
      getDatabase()
        .prepare("SELECT m.operation_id,s.document_gz FROM v3_search_objects s JOIN v3_search_membership m ON m.object_hash=s.object_hash JOIN v3_operations o ON o.operation_id=m.operation_id WHERE o.kind=? ORDER BY o.created_at DESC")
        .all(kind)
    : getDatabase()
        .prepare("SELECT m.operation_id,s.document_gz FROM v3_search_objects s JOIN v3_search_membership m ON m.object_hash=s.object_hash JOIN v3_operations o ON o.operation_id=m.operation_id ORDER BY o.created_at DESC")
        .all()
  const needle = query.toLowerCase()
  const matched = new Set<string>()
  for (const row of rows as Array<{ operation_id: string; document_gz: Uint8Array }>) {
    if (decoder.decode(decompressBytes(row.document_gz)).toLowerCase().includes(needle)) matched.add(row.operation_id)
    if (matched.size >= limit) break
  }
  return [...matched]
}

export function containingV3OperationIds(objectHash: string): string[] {
  const rows = getDatabase().prepare("SELECT operation_id,manifest_gz FROM v3_operations ORDER BY operation_id").all() as Array<{ operation_id: string; manifest_gz: Uint8Array }>
  return rows
    .filter((row) => {
      const manifest = JSON.parse(decoder.decode(decompressBytes(row.manifest_gz))) as { objectHashes?: Record<string, string> }
      return Object.values(manifest.objectHashes ?? {}).includes(objectHash)
    })
    .map((row) => row.operation_id)
}

function hydrateManifest(db: Database, manifestBlob: Uint8Array): ModelOperationRecord {
  const manifest = JSON.parse(decoder.decode(decompressBytes(manifestBlob))) as {
    record: Omit<ModelOperationRecord, "arena"> & {
      arena: {
        payloads: Array<Omit<ModelOperationRecord["arena"]["payloads"][number], "value">>
        frames: Array<Omit<ModelOperationRecord["arena"]["frames"][number], "value">>
      }
    }
    objectHashes: Record<string, string>
  }
  const hashes = [...new Set(Object.values(manifest.objectHashes))]
  const values = new Map<string, unknown>()
  if (hashes.length > 0) {
    const placeholders = hashes.map(() => "?").join(",")
    const rows = db.prepare(`SELECT hash,canonical_gz FROM v3_objects WHERE hash IN (${placeholders})`).all(...hashes) as Array<{
      hash: string
      canonical_gz: Uint8Array
    }>
    for (const object of rows) values.set(object.hash, JSON.parse(decoder.decode(decompressBytes(object.canonical_gz))))
  }
  const valueFor = (handle: string): unknown => {
    const hash = manifest.objectHashes[handle]
    if (!hash || !values.has(hash)) throw new Error(`[history/v3] missing CAS object for ${handle}`)
    return values.get(hash)
  }
  return {
    ...manifest.record,
    arena: {
      payloads: manifest.record.arena.payloads.map((node) => ({ ...node, value: valueFor(node.handle) })) as ModelOperationRecord["arena"]["payloads"],
      frames: manifest.record.arena.frames.map((node) => ({ ...node, value: valueFor(node.handle) })) as ModelOperationRecord["arena"]["frames"],
    },
  }
}

/** Resume terminal journal rows that were appended but never committed. */
export function recoverV3Journal(db: Database = getDatabase()): number {
  db.exec(V3_SCHEMA_SQL)
  const rows = db.prepare("SELECT operation_id,revision,digest,payload_gz FROM v3_journal WHERE committed_at IS NULL ORDER BY created_at").all() as Array<{
    operation_id: string
    revision: number
    digest: string
    payload_gz: Uint8Array
  }>
  let recovered = 0
  for (const row of rows) {
    try {
      const recoveredRecord = JSON.parse(decoder.decode(decompressBytes(row.payload_gz))) as ModelOperationRecord
      const prepared = prepareModelOperation(recoveredRecord)
      if (prepared.revision !== row.revision || prepared.digest !== row.digest) throw new Error("journal digest mismatch")
      commitPreparedOperation(db, prepared)
      recovered++
    } catch (error) {
      db.prepare("UPDATE v3_journal SET error=? WHERE operation_id=? AND revision=?").run(error instanceof Error ? error.message : String(error), row.operation_id, row.revision)
    }
  }
  return recovered
}

export function resetV3WriterForTests(): void {
  pending.length = 0
  pendingDrains.clear()
  pendingBytes = 0
  draining = false
  status = { pendingOperations: 0, pendingBytes: 0, persistedOperations: 0, failedOperations: 0, conflicts: 0, searchBacklog: 0 }
}
