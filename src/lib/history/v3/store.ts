import { consola } from "consola"
import { createHash } from "node:crypto"

import type {
  //
  ArenaNodeReference,
  ModelOperationRecord,
  OperationTrack,
} from "~/lib/context/model-operation-record"
import type { EntrySummary } from "~/lib/history/types"

import {
  //
  runHistoryWrite,
  runHistoryWriteAsync,
} from "~/lib/history/persist-guard"
import {
  //
  compressBytes,
  decompressBytes,
} from "~/lib/sqlite/compression"

import type { Database } from "../sqlite/connection"

import { getDatabase } from "../sqlite/connection"
import { recordToEntrySummary } from "./projection"

const FORMAT_VERSION = 2
const SEARCH_VERSION = 2
const SCHEMA_VERSION = "4"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Captured at module load — BEFORE any test can monkey-patch `globalThis.setTimeout`
 * (e.g. `tests/helpers/fake-clock.ts`, used by streaming-cadence/keepalive tests to
 * fake-drive application-level heartbeat timers). `runDrain`'s per-item yield below
 * is an internal event-loop-courtesy mechanism, not a timer any caller should be able
 * to fake/freeze — a faked global `setTimeout` that never auto-fires would otherwise
 * hang `drainV3Writer()` forever (surfaced as a `useIsolatedRuntime()` afterEach
 * timeout once its teardown started awaiting the real V3 writer drain).
 */
const realSetTimeout = globalThis.setTimeout

export interface V3StoredOperation {
  record: ModelOperationRecord
  pinned: boolean
  endedAt?: number
  timingSource: V3TimingSource
}

export type V3TimingSource = "canonical" | "storage-commit-upper-bound" | "terminal-log-rounded" | "unavailable"

export interface V3StoreStatus {
  pendingOperations: number
  pendingBytes: number
  persistedOperations: number
  failedOperations: number
  conflicts: number
  searchBacklog: number
  summaryBacklog: number
  lastError?: string
}

/**
 * A programming-error signal: the same `operationId` was submitted twice with
 * DIFFERING revision/digest — i.e. the caller violated the "an operation is
 * only ever committed with a monotonically increasing revision" contract.
 * This is NOT a persistence failure (SQLite worked fine; the DATA was wrong),
 * so it is deliberately kept OUTSIDE the persist-guard's never-throw
 * transient/permanent classification (History V2 removal Phase 4c) — a
 * `V3OperationConflictError` must propagate all the way to the caller
 * (`runDrain` classifies it into `status.conflicts` FIRST, before any
 * persist-guard wrapping), never get silently downgraded to
 * `{ ok: false, transient: false }`.
 */
export class V3OperationConflictError extends Error {}

interface PreparedObject {
  hash: string
  kind: string
  canonical: Uint8Array
  compressed: Uint8Array
}

interface PreparedSequenceNode {
  hash: string
  parentHash: string | null
  itemHash: string
  depth: number
}

interface SequenceOverlay {
  index: number
  path: Array<string | number>
  value: unknown
}

interface PreparedSequenceRef {
  path: Array<string | number>
  rootHash: string | null
  length: number
  overlays: Array<SequenceOverlay>
}

interface PreparedPayloadValue {
  object: PreparedObject
  sequences: Array<PreparedSequenceRef>
  objects: Array<PreparedObject>
  sequenceNodes: Array<PreparedSequenceNode>
  searchObjects: Array<{ hash: string; document: string }>
}

interface PreparedOperation {
  id: string
  revision: number
  digest: string
  kind: string
  createdAt: number
  terminalSequence: number
  endedAt?: number
  timingSource: V3TimingSource
  summaryJson: string
  manifest: Uint8Array
  compressedManifest: Uint8Array
  compressedJournalRecord: Uint8Array
  objects: Array<PreparedObject>
  sequenceNodes: Array<PreparedSequenceNode>
  tracks: Array<{ name: string; attemptIndex: number; refs: string; compressed: Uint8Array }>
  timeline: Array<{ chunkIndex: number; firstSequence: number; lastSequence: number; payload: Uint8Array; compressed: Uint8Array }>
  searchObjects: Array<{ hash: string; document: string }>
  byteLength: number
}

interface PendingOperation {
  record: ModelOperationRecord
  estimatedBytes: number
  resolve: () => void
}

const pending: Array<PendingOperation> = []
const pendingDrains = new Set<Promise<void>>()
let pendingBytes = 0
let draining = false
let summaryBackfillStop = false
let summaryBackfill: Promise<void> | null = null
let status: V3StoreStatus = {
  pendingOperations: 0,
  pendingBytes: 0,
  persistedOperations: 0,
  failedOperations: 0,
  conflicts: 0,
  searchBacklog: 0,
  summaryBacklog: 0,
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
CREATE TABLE IF NOT EXISTS v3_sequence_nodes (
  hash TEXT PRIMARY KEY,
  parent_hash TEXT,
  item_hash TEXT NOT NULL,
  depth INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_operations (
  operation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  terminal_sequence INTEGER NOT NULL,
  ended_at INTEGER,
  timing_source TEXT NOT NULL DEFAULT 'storage-commit-upper-bound',
  manifest_gz BLOB NOT NULL,
  summary_json TEXT,
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
  track_gz BLOB,
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
CREATE TABLE IF NOT EXISTS v3_summary_backlog (
  operation_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * Reconcile the V3 schema floor and correct pre-timing rows in place. Historical
 * `committed_at` is the closest durable upper bound on terminal time; it is
 * explicitly labelled so consumers never mistake persistence time for an exact
 * model-operation boundary.
 */
export function ensureV3Schema(db: Database = getDatabase()): void {
  db.exec(V3_SCHEMA_SQL)
  const version = db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get() as { value: string } | undefined
  if (version?.value === SCHEMA_VERSION) return
  const columns = new Set((db.prepare("PRAGMA table_info(v3_operations)").all() as Array<{ name: string }>).map((column) => column.name))
  const trackColumns = new Set((db.prepare("PRAGMA table_info(v3_tracks)").all() as Array<{ name: string }>).map((column) => column.name))
  const migrate = db.transaction(() => {
    if (!columns.has("ended_at")) db.exec("ALTER TABLE v3_operations ADD COLUMN ended_at INTEGER")
    if (!columns.has("timing_source")) db.exec("ALTER TABLE v3_operations ADD COLUMN timing_source TEXT NOT NULL DEFAULT 'storage-commit-upper-bound'")
    if (!columns.has("summary_json")) db.exec("ALTER TABLE v3_operations ADD COLUMN summary_json TEXT")
    if (!trackColumns.has("track_gz")) db.exec("ALTER TABLE v3_tracks ADD COLUMN track_gz BLOB")
    db.prepare("UPDATE v3_operations SET ended_at=committed_at WHERE ended_at IS NULL AND timing_source='storage-commit-upper-bound'").run()
    db.prepare("INSERT OR REPLACE INTO v3_meta(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION)
  })
  migrate()
}

function canonicalize(value: unknown): string {
  const active = new WeakSet<object>()
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input
    const object = input
    if (active.has(object)) throw new Error("[history/v3] cyclic semantic value")
    active.add(object)
    try {
      if (Array.isArray(input)) return input.map((item) => normalize(item))
      if (ArrayBuffer.isView(input)) return { $bytes: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64") }
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      )
    } finally {
      active.delete(object)
    }
  }
  return JSON.stringify(normalize(value))
}

function digestBytesAt(version: number, domain: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`history-v3:${version}:${domain}\0`).update(bytes).digest("hex")
}

function digestBytes(domain: string, bytes: Uint8Array): string {
  return digestBytesAt(FORMAT_VERSION, domain, bytes)
}

function objectHash(kind: string, value: unknown): PreparedObject {
  const canonical = encoder.encode(canonicalize(value))
  return { hash: digestBytes(`object:${kind}`, canonical), kind, canonical, compressed: compressBytes(canonical) }
}

const VOLATILE_KEYS = new Set(["cache_control", "ephemeral"])

function stripVolatile(
  value: unknown,
  path: Array<string | number> = [],
): { clean: unknown; overlays: Array<{ path: Array<string | number>; value: unknown }> } {
  if (value === null || typeof value !== "object") return { clean: value, overlays: [] }
  if (Array.isArray(value)) {
    const overlays: Array<{ path: Array<string | number>; value: unknown }> = []
    const clean = value.map((item, index) => {
      const nested = stripVolatile(item, [...path, index])
      overlays.push(...nested.overlays)
      return nested.clean
    })
    return { clean, overlays }
  }
  if (ArrayBuffer.isView(value)) return { clean: value, overlays: [] }
  const clean: Record<string, unknown> = {}
  const overlays: Array<{ path: Array<string | number>; value: unknown }> = []
  for (const [key, nested] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(key)) {
      overlays.push({ path: [...path, key], value: nested })
      continue
    }
    const stripped = stripVolatile(nested, [...path, key])
    clean[key] = stripped.clean
    overlays.push(...stripped.overlays)
  }
  return { clean, overlays }
}

function shouldExtractSequence(value: ReadonlyArray<unknown>): boolean {
  return value.length > 0 && value.every((item) => item !== null && typeof item === "object" && !ArrayBuffer.isView(item))
}

function preparePayloadValue(value: unknown): PreparedPayloadValue {
  const objects = new Map<string, PreparedObject>()
  const sequenceNodes = new Map<string, PreparedSequenceNode>()
  const sequences: Array<PreparedSequenceRef> = []
  const searchObjects = new Map<string, string>()
  const addObject = (object: PreparedObject): PreparedObject => {
    objects.set(object.hash, object)
    return object
  }
  const walk = (input: unknown, path: Array<string | number>): unknown => {
    if (Array.isArray(input) && shouldExtractSequence(input)) {
      let parentHash: string | null = null
      const overlays: Array<SequenceOverlay> = []
      for (const [index, item] of input.entries()) {
        const stripped = stripVolatile(item)
        for (const overlay of stripped.overlays) overlays.push({ index, path: overlay.path, value: overlay.value })
        const itemObject = addObject(objectHash("sequence-item", stripped.clean))
        searchObjects.set(itemObject.hash, canonicalize(stripped.clean))
        const nodeBytes = encoder.encode(`${parentHash ?? ""}\0${itemObject.hash}`)
        const hash = digestBytes("sequence-node", nodeBytes)
        const node: PreparedSequenceNode = { hash, parentHash, itemHash: itemObject.hash, depth: index + 1 }
        const existing = sequenceNodes.get(hash)
        if (existing && (existing.parentHash !== node.parentHash || existing.itemHash !== node.itemHash || existing.depth !== node.depth)) {
          throw new Error(`[history/v3] sequence-node hash collision: ${hash}`)
        }
        sequenceNodes.set(hash, node)
        parentHash = hash
      }
      sequences.push({ path: [...path], rootHash: parentHash, length: input.length, overlays })
      return null
    }
    if (Array.isArray(input)) return input.map((item, index) => walk(item, [...path, index]))
    if (input === null || typeof input !== "object" || ArrayBuffer.isView(input)) return input
    return Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, walk(nested, [...path, key])]))
  }
  const skeleton = walk(value, [])
  const object = addObject(objectHash(sequences.length > 0 ? "payload-skeleton" : "payload", skeleton))
  searchObjects.set(object.hash, canonicalize(skeleton))
  return {
    object,
    sequences,
    objects: [...objects.values()],
    sequenceNodes: [...sequenceNodes.values()],
    searchObjects: [...searchObjects].map(([hash, document]) => ({ hash, document })),
  }
}

function refs(track: OperationTrack | undefined): string {
  return JSON.stringify(track ?? { frames: [] })
}

function collectTracks(record: ModelOperationRecord): PreparedOperation["tracks"] {
  const out: PreparedOperation["tracks"] = []
  const push = (name: string, attemptIndex: number, track: Parameters<typeof refs>[0]): void => {
    const json = refs(track)
    out.push({ name, attemptIndex, refs: "{}", compressed: compressBytes(encoder.encode(json)) })
  }
  if (record.ingress) push("client-ingress", -1, record.ingress.request)
  for (const [index, attempt] of record.attempts.entries()) {
    push("effective-request", index, attempt.effectiveRequest)
    push("upstream-request", index, attempt.upstreamRequest)
    push("upstream-response", index, attempt.upstreamResponse)
  }
  if (record.egress) {
    push("upstream-egress", -1, record.egress.upstream)
    push("client-egress", -1, record.egress.client)
  }
  return out
}

function references(record: ModelOperationRecord): Set<string> {
  const handles = new Set<string>()
  const add = (reference: ArenaNodeReference): void => void handles.add(reference.handle)
  for (const transform of record.transforms) {
    for (const reference of transform.inputs) add(reference)
    for (const reference of transform.outputs) add(reference)
  }
  const addTrack = (track: { payload?: string; frames: ReadonlyArray<string> } | undefined): void => {
    if (track?.payload) handles.add(track.payload)
    for (const handle of track?.frames ?? []) handles.add(handle)
  }
  if (record.ingress) addTrack(record.ingress.request)
  for (const attempt of record.attempts) {
    addTrack(attempt.effectiveRequest)
    addTrack(attempt.upstreamRequest)
    addTrack(attempt.upstreamResponse)
  }
  if (record.egress) {
    addTrack(record.egress.upstream)
    addTrack(record.egress.client)
  }
  return handles
}

function recordWithoutTracks(record: ModelOperationRecord): ModelOperationRecord {
  return {
    ...record,
    ingress: record.ingress === null ? null : { ...record.ingress, request: { frames: [] } },
    attempts: record.attempts.map((attempt) => ({
      ...attempt,
      effectiveRequest: attempt.effectiveRequest === undefined ? undefined : { frames: [] },
      upstreamRequest: attempt.upstreamRequest === undefined ? undefined : { frames: [] },
      upstreamResponse: attempt.upstreamResponse === undefined ? undefined : { frames: [] },
    })),
    egress: record.egress === null ? null : { ...record.egress, upstream: { frames: [] }, client: { frames: [] } },
  }
}

function legacyV1Digest(record: ModelOperationRecord): string {
  const objectHashes = new Map<string, string>()
  for (const node of record.arena.payloads) {
    const canonical = encoder.encode(canonicalize(node.value))
    objectHashes.set(node.handle, digestBytesAt(1, "object:payload", canonical))
  }
  for (const node of record.arena.frames) {
    const canonical = encoder.encode(canonicalize(node.value))
    objectHashes.set(node.handle, digestBytesAt(1, "object:frame", canonical))
  }
  const manifestValue = {
    ...record,
    arena: {
      payloads: record.arena.payloads.map(({ value: _value, ...node }) => node),
      frames: record.arena.frames.map(({ value: _value, ...node }) => node),
    },
  }
  const manifest = encoder.encode(JSON.stringify({ formatVersion: 1, record: manifestValue, objectHashes: Object.fromEntries(objectHashes) }))
  return digestBytesAt(1, "operation", manifest)
}

export function prepareModelOperation(
  record: ModelOperationRecord,
  timingOverride?: { endedAt?: number; source: Exclude<V3TimingSource, "canonical"> },
): PreparedOperation {
  if (!record.terminal) throw new Error("[history/v3] terminal record required")
  const objectsByHash = new Map<string, PreparedObject>()
  const sequenceNodesByHash = new Map<string, PreparedSequenceNode>()
  const objectHashes = new Map<string, string>()
  const payloadSequences = new Map<string, Array<PreparedSequenceRef>>()
  const searchDocuments = new Map<string, string>()
  const usedHandles = references(record)
  for (const node of record.arena.payloads) {
    const prepared = preparePayloadValue(node.value)
    objectHashes.set(node.handle, prepared.object.hash)
    if (prepared.sequences.length > 0) payloadSequences.set(node.handle, prepared.sequences)
    for (const object of prepared.objects) objectsByHash.set(object.hash, object)
    for (const sequenceNode of prepared.sequenceNodes) sequenceNodesByHash.set(sequenceNode.hash, sequenceNode)
    if (usedHandles.has(node.handle)) for (const document of prepared.searchObjects) searchDocuments.set(document.hash, document.document)
  }
  for (const node of record.arena.frames) {
    const object = objectHash("frame", node.value)
    objectHashes.set(node.handle, object.hash)
    objectsByHash.set(object.hash, object)
  }
  // Values live only in v3_objects. The manifest retains node metadata + the
  // handle→hash map, avoiding a second full copy of every payload/frame.
  const tracklessRecord = recordWithoutTracks(record)
  const manifestValue = {
    ...tracklessRecord,
    arena: {
      payloads: tracklessRecord.arena.payloads.map(({ value: _value, ...node }) => node),
      frames: tracklessRecord.arena.frames.map(({ value: _value, ...node }) => node),
    },
  }
  const manifestText = JSON.stringify({
    formatVersion: FORMAT_VERSION,
    record: manifestValue,
    objectHashes: Object.fromEntries(objectHashes),
    payloadSequences: Object.fromEntries(payloadSequences),
    tracksExternal: true,
  })
  const manifest = encoder.encode(manifestText)
  const journalRecord = encoder.encode(JSON.stringify(record))
  const digest = digestBytes("operation", manifest)
  const timelineEvents = [
    ...record.arena.payloads.map((node) => ({ sequence: node.sequence, occurredAt: node.occurredAt, type: "payload", handle: node.handle })),
    ...record.arena.frames.map((node) => ({ sequence: node.sequence, occurredAt: node.occurredAt, type: "frame", handle: node.handle })),
    ...(record.ingress ? [{ sequence: record.ingress.sequence, occurredAt: record.ingress.occurredAt, type: "ingress" }] : []),
    ...(record.routing ? [{ sequence: record.routing.sequence, occurredAt: record.routing.occurredAt, type: "routing" }] : []),
    ...record.transforms.map((event) => ({ sequence: event.sequence, occurredAt: event.occurredAt, type: "transform", value: event })),
    ...record.attempts.flatMap((attempt) => [
      { sequence: attempt.sequence, occurredAt: attempt.occurredAt, type: "attempt", handle: attempt.handle },
      ...attempt.diagnostics.map((diagnostic) => ({ sequence: diagnostic.sequence, type: "diagnostic", value: diagnostic })),
      ...(attempt.settledSequence ?
        [{ sequence: attempt.settledSequence, occurredAt: attempt.settledAt, type: "attempt-settled", handle: attempt.handle, verdict: attempt.verdict }]
      : []),
    ]),
    ...(record.egress ? [{ sequence: record.egress.sequence, occurredAt: record.egress.occurredAt, type: "egress" }] : []),
    { sequence: record.terminal.sequence, occurredAt: record.terminal.occurredAt, type: "terminal", value: record.terminal },
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
  const endedAt = timingOverride?.endedAt ?? record.terminal.occurredAt
  const timingSource = timingOverride?.source ?? (record.terminal.occurredAt === undefined ? "unavailable" : "canonical")
  return {
    id: record.identity.operationId,
    revision: record.lastSequence,
    digest,
    kind: record.identity.kind,
    createdAt: record.identity.createdAt,
    terminalSequence: record.terminal.sequence,
    endedAt,
    timingSource,
    summaryJson: JSON.stringify(recordToEntrySummary(record, { endedAt, timingSource })),
    manifest,
    compressedManifest: compressBytes(manifest),
    compressedJournalRecord: compressBytes(journalRecord),
    objects: [...objectsByHash.values()],
    sequenceNodes: [...sequenceNodesByHash.values()],
    tracks,
    timeline,
    searchObjects: [...searchDocuments].map(([hash, document]) => ({ hash, document })),
    byteLength: manifest.byteLength + [...objectsByHash.values()].reduce((sum, object) => sum + object.canonical.byteLength, 0),
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

function insertSequenceNode(db: Database, node: PreparedSequenceNode): void {
  const existing = db.prepare("SELECT parent_hash,item_hash,depth FROM v3_sequence_nodes WHERE hash=?").get(node.hash) as
    | { parent_hash: string | null; item_hash: string; depth: number }
    | undefined
  if (existing) {
    if (existing.parent_hash !== node.parentHash || existing.item_hash !== node.itemHash || existing.depth !== node.depth) {
      throw new Error(`[history/v3] sequence-node hash collision: ${node.hash}`)
    }
    return
  }
  db.prepare("INSERT INTO v3_sequence_nodes(hash,parent_hash,item_hash,depth) VALUES(?,?,?,?)").run(node.hash, node.parentHash, node.itemHash, node.depth)
}

export function commitPreparedOperation(db: Database, prepared: PreparedOperation): "inserted" | "idempotent" {
  ensureV3Schema(db)
  const existing = db.prepare("SELECT revision,digest FROM v3_operations WHERE operation_id = ?").get(prepared.id) as
    | { revision: number; digest: string }
    | undefined
  if (existing) {
    if (existing.revision === prepared.revision && existing.digest === prepared.digest) return "idempotent"
    // Programming-error signal (duplicate operationId, differing revision/digest)
    // — NOT a persistence failure, so this branch deliberately does NOT go
    // through persist-guard (History V2 removal Phase 4c, plan §4c). It must
    // propagate as a real throw so `status.conflicts` (below) stays the sole,
    // un-absorbed signal for this condition; a caller (`runDrain`) that wants
    // to swallow it does so explicitly via `instanceof V3OperationConflictError`.
    status = { ...status, conflicts: status.conflicts + 1, lastError: `operation conflict: ${prepared.id}` }
    throw new V3OperationConflictError(`[history/v3] operation conflict: ${prepared.id}`)
  }
  // The actual persistence write (journal insert + operation transaction) is
  // the part that can fail for genuinely transient/permanent SQLite reasons
  // (BUSY/LOCKED/IOERR/disk full) — guarded by persist-guard so such a failure
  // is classified, ERROR-logged, and counted instead of an unclassified throw.
  // `thrown` captures the original error so this function can still RETHROW
  // it after classification — preserving the pre-4c throw contract that
  // `recoverV3Journal` and direct callers (tests) depend on, while still
  // getting persist-guard's classify/log/count side effect.
  let thrown: unknown
  const result = runHistoryWrite("v3-commit", () => {
    try {
      // Journal is self-contained: operation tx rollback may remove every CAS object,
      // so recovery cannot depend on value-stripped manifest + v3_objects.
      const journalPayload = prepared.compressedJournalRecord
      db.prepare(
        "INSERT OR REPLACE INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,committed_at,error) VALUES(?,?,?,?,?,?,NULL,NULL)",
      ).run(prepared.id, prepared.revision, prepared.digest, "terminal", journalPayload, Date.now())
      const committedAt = Date.now()
      const tx = db.transaction(() => {
        for (const object of prepared.objects) insertObject(db, object)
        for (const node of prepared.sequenceNodes) insertSequenceNode(db, node)
        db.prepare(
          "INSERT INTO v3_operations(operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          prepared.id,
          prepared.revision,
          prepared.digest,
          prepared.kind,
          prepared.createdAt,
          prepared.terminalSequence,
          prepared.endedAt ?? null,
          prepared.timingSource,
          prepared.compressedManifest,
          prepared.summaryJson,
          committedAt,
        )
        const trackStmt = db.prepare("INSERT INTO v3_tracks(operation_id,track_name,attempt_index,refs_json,track_gz) VALUES(?,?,?,?,?)")
        for (const track of prepared.tracks) trackStmt.run(prepared.id, track.name, track.attemptIndex, track.refs, track.compressed)
        const timelineStmt = db.prepare("INSERT INTO v3_timeline_chunks(operation_id,chunk_index,first_sequence,last_sequence,payload_gz) VALUES(?,?,?,?,?)")
        for (const chunk of prepared.timeline) timelineStmt.run(prepared.id, chunk.chunkIndex, chunk.firstSequence, chunk.lastSequence, chunk.compressed)
        try {
          const existingSearch = db.prepare("SELECT 1 FROM v3_search_objects WHERE object_hash=?")
          const insertSearch = db.prepare("INSERT INTO v3_search_objects(object_hash,document_gz,version) VALUES(?,?,?)")
          const insertMembership = db.prepare("INSERT INTO v3_search_membership(operation_id,object_hash) VALUES(?,?)")
          for (const object of prepared.searchObjects) {
            if (!existingSearch.get(object.hash)) insertSearch.run(object.hash, new Uint8Array(), SEARCH_VERSION)
            insertMembership.run(prepared.id, object.hash)
          }
        } catch (error) {
          db.prepare(
            "INSERT OR REPLACE INTO v3_search_backlog(operation_id,reason,attempts,updated_at) VALUES(?,?,COALESCE((SELECT attempts FROM v3_search_backlog WHERE operation_id=?),0)+1,?)",
          ).run(prepared.id, error instanceof Error ? error.message : String(error), prepared.id, Date.now())
        }
        // Once the operation transaction commits, the durable manifest + CAS objects are the
        // recovery source. Keeping the self-contained journal payload after this point would
        // duplicate every semantic value forever and defeat content-addressed storage.
        db.prepare("DELETE FROM v3_journal WHERE operation_id=? AND revision=?").run(prepared.id, prepared.revision)
      })
      tx()
    } catch (error) {
      thrown = error
      throw error
    }
  })
  if (!result.ok) throw thrown
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
      const item = pending.shift()
      if (item === undefined) break
      pendingBytes -= item.estimatedBytes
      status = { ...status, pendingOperations: pending.length, pendingBytes }
      try {
        const prepared = await Promise.resolve().then(() => prepareModelOperation(item.record))
        // Captures a non-conflict thrown error so `lastError` still carries its
        // message after persist-guard's classify/log/count (which only returns
        // `{ ok, transient }`, no message) — mirrors the same pattern used
        // inside `commitPreparedOperation` itself.
        let nonConflictError: unknown
        const result = await runHistoryWriteAsync("v3-drain", async () => {
          try {
            const commitResult = commitPreparedOperation(getDatabase(), prepared)
            if (commitResult === "inserted") status = { ...status, persistedOperations: status.persistedOperations + 1 }
          } catch (error) {
            if (error instanceof V3OperationConflictError) {
              // A conflict is a data-contract violation (duplicate operationId,
              // differing revision/digest), not a SQLite persistence failure —
              // `commitPreparedOperation` already bumped `status.conflicts`
              // above. Swallow it HERE (before it reaches persist-guard's own
              // catch) so the transient/permanent classification — scoped to
              // genuine DB failures — never double-counts a conflict as a
              // "v3-drain" persistence failure.
              return
            }
            nonConflictError = error
            throw error
          }
        })
        if (!result.ok) {
          status = {
            ...status,
            failedOperations: status.failedOperations + 1,
            lastError: nonConflictError instanceof Error ? nonConflictError.message : String(nonConflictError),
          }
        }
      } catch (error) {
        // `prepareModelOperation` itself threw (before any persist-guard wrapping applies).
        consola.error(`[history/v3] failed to persist operation ${item.record.identity.operationId}`, error)
        status = {
          ...status,
          failedOperations: status.failedOperations + 1,
          lastError: error instanceof Error ? error.message : String(error),
        }
      } finally {
        item.resolve()
      }
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0))
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
  const drain = runDrain()
    .catch(() => undefined)
    .finally(() => pendingDrains.delete(drain))
  pendingDrains.add(drain)
  return done
}

export async function drainV3Writer(): Promise<void> {
  while (pending.length > 0 || pendingDrains.size > 0) {
    await Promise.allSettled(pendingDrains)
    if (pending.length > 0) await runDrain()
  }
}

export function getV3StoreStatus(): V3StoreStatus {
  const db = getDatabase()
  ensureV3Schema(db)
  const searchBacklog = (db.prepare("SELECT COUNT(*) AS n FROM v3_search_backlog").get() as { n: number }).n
  const summaryBacklog = (db.prepare("SELECT COUNT(*) AS n FROM v3_summary_backlog").get() as { n: number }).n
  return { ...status, pendingOperations: pending.length, pendingBytes, searchBacklog, summaryBacklog }
}

export function getV3StoredOperation(operationId: string): V3StoredOperation | undefined {
  const db = getDatabase()
  ensureV3Schema(db)
  const row = db.prepare("SELECT manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE operation_id=?").get(operationId) as
    | { manifest_gz: Uint8Array; pinned: number; ended_at: number | null; timing_source: V3TimingSource }
    | undefined
  if (!row) return undefined
  return {
    record: hydrateManifest(db, row.manifest_gz),
    pinned: row.pinned === 1,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    timingSource: row.timing_source,
  }
}

export function getV3Operation(operationId: string): ModelOperationRecord | undefined {
  return getV3StoredOperation(operationId)?.record
}

export function listV3StoredOperations(kind?: string, limit = 100): Array<V3StoredOperation> {
  const db = getDatabase()
  ensureV3Schema(db)
  const rows =
    kind ?
      db
        .prepare("SELECT manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ?")
        .all(kind, limit)
    : db.prepare("SELECT manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ?").all(limit)
  return (rows as Array<{ manifest_gz: Uint8Array; pinned: number; ended_at: number | null; timing_source: V3TimingSource }>).map((row) => ({
    record: hydrateManifest(db, row.manifest_gz),
    pinned: row.pinned === 1,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    timingSource: row.timing_source,
  }))
}

export function listV3Operations(kind?: string, limit = 100): Array<ModelOperationRecord> {
  return listV3StoredOperations(kind, limit).map(({ record }) => record)
}

function summaryFromRow(
  db: Database,
  row: { manifest_gz: Uint8Array; summary_json: string | null; pinned: number; ended_at: number | null; timing_source: V3TimingSource },
): EntrySummary {
  if (row.summary_json) return { ...(JSON.parse(row.summary_json) as EntrySummary), pinned: row.pinned === 1 }
  const stored = {
    record: hydrateManifest(db, row.manifest_gz),
    pinned: row.pinned === 1,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    timingSource: row.timing_source,
  }
  return recordToEntrySummary(stored.record, stored)
}

/** Visit persisted summaries newest-first without hydrating canonical payloads on format-v2 rows. */
export function visitV3Summaries(visitor: (summary: EntrySummary) => unknown, kind?: string, pageSize = 256): void {
  const db = getDatabase()
  ensureV3Schema(db)
  let offset = 0
  while (true) {
    const rows =
      kind ?
        db
          .prepare(
            "SELECT manifest_gz,summary_json,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(kind, pageSize, offset)
      : db
          .prepare(
            "SELECT manifest_gz,summary_json,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(pageSize, offset)
    const page = rows as Array<{ manifest_gz: Uint8Array; summary_json: string | null; pinned: number; ended_at: number | null; timing_source: V3TimingSource }>
    if (page.length === 0) return
    offset += page.length
    for (const row of page) if (visitor(summaryFromRow(db, row)) === false) return
  }
}

export function startV3SummaryBackfill(db: Database = getDatabase(), batchSize = 16): void {
  if (summaryBackfill) return
  summaryBackfillStop = false
  summaryBackfill = (async () => {
    while (!summaryBackfillStop) {
      const rows = db
        .prepare(
          "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE summary_json IS NULL AND operation_id NOT IN (SELECT operation_id FROM v3_summary_backlog) ORDER BY created_at,operation_id LIMIT ?",
        )
        .all(batchSize) as Array<{
        operation_id: string
        manifest_gz: Uint8Array
        pinned: number
        ended_at: number | null
        timing_source: V3TimingSource
      }>
      if (rows.length === 0) return
      for (const row of rows) {
        try {
          const stored = {
            record: hydrateManifest(db, row.manifest_gz),
            pinned: row.pinned === 1,
            ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
            timingSource: row.timing_source,
          }
          db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=? AND summary_json IS NULL").run(
            JSON.stringify(recordToEntrySummary(stored.record, stored)),
            row.operation_id,
          )
        } catch (error) {
          consola.error(`[history/v3] summary backfill failed for ${row.operation_id}`, error)
          db.prepare("INSERT OR REPLACE INTO v3_summary_backlog(operation_id,reason,updated_at) VALUES(?,?,?)").run(
            row.operation_id,
            error instanceof Error ? error.message : String(error),
            Date.now(),
          )
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  })().finally(() => {
    summaryBackfill = null
  })
}

export function stopV3SummaryBackfill(): void {
  summaryBackfillStop = true
}

export async function drainV3SummaryBackfill(): Promise<void> {
  await summaryBackfill
}

export function countV3Operations(kind?: string): number {
  const db = getDatabase()
  ensureV3Schema(db)
  const row = kind ? db.prepare("SELECT COUNT(*) AS n FROM v3_operations WHERE kind=?").get(kind) : db.prepare("SELECT COUNT(*) AS n FROM v3_operations").get()
  return (row as { n: number }).n
}

/** Visit persisted operations newest-first with bounded SQLite/result memory. */
export function visitV3StoredOperations(visitor: (stored: V3StoredOperation) => unknown, kind?: string, pageSize = 64): void {
  const db = getDatabase()
  ensureV3Schema(db)
  let offset = 0
  while (true) {
    const rows =
      kind ?
        db
          .prepare(
            "SELECT manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(kind, pageSize, offset)
      : db
          .prepare("SELECT manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?")
          .all(pageSize, offset)
    const page = rows as Array<{ manifest_gz: Uint8Array; pinned: number; ended_at: number | null; timing_source: V3TimingSource }>
    if (page.length === 0) return
    offset += page.length
    for (const row of page) {
      const shouldContinue = visitor({
        record: hydrateManifest(db, row.manifest_gz),
        pinned: row.pinned === 1,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        timingSource: row.timing_source,
      })
      if (shouldContinue === false) return
    }
  }
}

export function setV3OperationPinned(operationId: string, pinned: boolean): boolean {
  const db = getDatabase()
  ensureV3Schema(db)
  const exists = db.prepare("SELECT 1 FROM v3_operations WHERE operation_id=?").get(operationId)
  if (!exists) return false
  db.prepare("UPDATE v3_operations SET pinned=? WHERE operation_id=?").run(pinned ? 1 : 0, operationId)
  return true
}

export function searchV3OperationIds(query: string, kind: string | undefined, limit: number): Array<string> {
  if (limit <= 0 || query.length === 0) return []
  const db = getDatabase()
  ensureV3Schema(db)
  const needle = query.toLowerCase()
  const matched = new Set<string>()
  const pageSize = 128
  let offset = 0
  while (matched.size < limit) {
    const rows = db
      .prepare(
        `SELECT s.object_hash,s.version,s.document_gz,o.canonical_gz
         FROM v3_search_objects s LEFT JOIN v3_objects o ON o.hash=s.object_hash
         ORDER BY s.object_hash LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as Array<{ object_hash: string; version: number; document_gz: Uint8Array; canonical_gz: Uint8Array | null }>
    if (rows.length === 0) break
    offset += rows.length
    for (const row of rows) {
      const source = row.version >= SEARCH_VERSION ? row.canonical_gz : row.document_gz
      if (!source) continue
      if (!decoder.decode(decompressBytes(source)).toLowerCase().includes(needle)) continue
      const operations =
        kind ?
          db
            .prepare(
              "SELECT o.operation_id FROM v3_search_membership m JOIN v3_operations o ON o.operation_id=m.operation_id WHERE m.object_hash=? AND o.kind=? ORDER BY o.created_at DESC,o.operation_id DESC LIMIT ?",
            )
            .all(row.object_hash, kind, limit)
        : db
            .prepare(
              "SELECT o.operation_id FROM v3_search_membership m JOIN v3_operations o ON o.operation_id=m.operation_id WHERE m.object_hash=? ORDER BY o.created_at DESC,o.operation_id DESC LIMIT ?",
            )
            .all(row.object_hash, limit)
      for (const operation of operations as Array<{ operation_id: string }>) {
        matched.add(operation.operation_id)
        if (matched.size >= limit) break
      }
      if (matched.size >= limit) break
    }
  }
  if (matched.size === 0) return []
  const ids = [...matched]
  const placeholders = ids.map(() => "?").join(",")
  return (
    db
      .prepare(`SELECT operation_id FROM v3_operations WHERE operation_id IN (${placeholders}) ORDER BY created_at DESC,operation_id DESC LIMIT ?`)
      .all(...ids, limit) as Array<{ operation_id: string }>
  ).map((row) => row.operation_id)
}

export function containingV3OperationIds(objectHash: string): Array<string> {
  return (
    getDatabase().prepare("SELECT operation_id FROM v3_search_membership WHERE object_hash=? ORDER BY operation_id").all(objectHash) as Array<{
      operation_id: string
    }>
  ).map((row) => row.operation_id)
}

/**
 * Delete every persisted V3 history row while retaining schema metadata.
 * This is the storage primitive behind the test-only `clearHistory()` reset;
 * product surfaces must not expose it as a user-facing destructive action.
 */
export function clearV3Store(db: Database = getDatabase()): void {
  ensureV3Schema(db)
  const clear = db.transaction(() => {
    db.prepare("DELETE FROM v3_search_membership").run()
    db.prepare("DELETE FROM v3_search_objects").run()
    db.prepare("DELETE FROM v3_search_backlog").run()
    db.prepare("DELETE FROM v3_summary_backlog").run()
    db.prepare("DELETE FROM v3_timeline_chunks").run()
    db.prepare("DELETE FROM v3_tracks").run()
    db.prepare("DELETE FROM v3_operations").run()
    db.prepare("DELETE FROM v3_sequence_nodes").run()
    db.prepare("DELETE FROM v3_objects").run()
    db.prepare("DELETE FROM v3_journal").run()
  })
  clear()
}

function hydrateManifest(db: Database, manifestBlob: Uint8Array): ModelOperationRecord {
  const manifest = JSON.parse(decoder.decode(decompressBytes(manifestBlob))) as {
    formatVersion?: number
    record: Omit<ModelOperationRecord, "arena"> & {
      arena: {
        payloads: Array<Omit<ModelOperationRecord["arena"]["payloads"][number], "value">>
        frames: Array<Omit<ModelOperationRecord["arena"]["frames"][number], "value">>
      }
    }
    objectHashes: Record<string, string>
    payloadSequences?: Record<string, Array<PreparedSequenceRef>>
    tracksExternal?: boolean
  }
  if (
    manifest.formatVersion !== undefined
    && (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1 || manifest.formatVersion > FORMAT_VERSION)
  ) {
    throw new Error(`[history/v3] unsupported manifest format version: ${String(manifest.formatVersion)}`)
  }
  const hashes = [...new Set(Object.values(manifest.objectHashes))]
  const values = new Map<string, unknown>()
  const loadObjects = (requested: ReadonlyArray<string>): void => {
    const missing = [...new Set(requested)].filter((hash) => !values.has(hash))
    if (missing.length === 0) return
    const placeholders = missing.map(() => "?").join(",")
    const rows = db.prepare(`SELECT hash,canonical_gz FROM v3_objects WHERE hash IN (${placeholders})`).all(...missing) as Array<{
      hash: string
      canonical_gz: Uint8Array
    }>
    for (const object of rows) values.set(object.hash, JSON.parse(decoder.decode(decompressBytes(object.canonical_gz))))
  }
  if (hashes.length > 0) {
    loadObjects(hashes)
  }
  const cloneValue = <T>(value: T): T => structuredClone(value)
  const setPath = (root: unknown, path: ReadonlyArray<string | number>, value: unknown): unknown => {
    if (path.length === 0) return value
    let current = root as Record<string | number, unknown>
    for (const segment of path.slice(0, -1)) current = current[segment] as Record<string | number, unknown>
    const last = path.at(-1)
    if (last === undefined) return value
    current[last] = value
    return root
  }
  const expandSequence = (sequence: PreparedSequenceRef): Array<unknown> => {
    if (sequence.rootHash === null) return []
    const rows = db
      .prepare(
        `WITH RECURSIVE chain(hash,parent_hash,item_hash,depth) AS (
           SELECT hash,parent_hash,item_hash,depth FROM v3_sequence_nodes WHERE hash=?
           UNION ALL
           SELECT n.hash,n.parent_hash,n.item_hash,n.depth
           FROM v3_sequence_nodes n JOIN chain c ON n.hash=c.parent_hash
         ) SELECT item_hash,depth FROM chain ORDER BY depth ASC`,
      )
      .all(sequence.rootHash) as Array<{ item_hash: string; depth: number }>
    if (rows.length !== sequence.length) {
      throw new Error(`[history/v3] incomplete sequence ${sequence.rootHash}: expected ${sequence.length}, got ${rows.length}`)
    }
    loadObjects(rows.map((row) => row.item_hash))
    return rows.map((row, index) => {
      const clean = values.get(row.item_hash)
      if (clean === undefined) throw new Error(`[history/v3] missing sequence item ${row.item_hash}`)
      let item: unknown = cloneValue(clean)
      for (const overlay of sequence.overlays.filter((candidate) => candidate.index === index)) item = setPath(item, overlay.path, cloneValue(overlay.value))
      return item
    })
  }
  const valueFor = (handle: string, kind: "payload" | "frame"): unknown => {
    const hash = manifest.objectHashes[handle]
    if (!hash || !values.has(hash)) throw new Error(`[history/v3] missing CAS object for ${handle}`)
    let value = cloneValue(values.get(hash))
    if (kind === "payload") {
      for (const sequence of manifest.payloadSequences?.[handle] ?? []) value = setPath(value, sequence.path, expandSequence(sequence))
    }
    return value
  }
  let record = {
    ...manifest.record,
    arena: {
      payloads: manifest.record.arena.payloads.map((node) => ({
        ...node,
        value: valueFor(node.handle, "payload"),
      })) as ModelOperationRecord["arena"]["payloads"],
      frames: manifest.record.arena.frames.map((node) => ({ ...node, value: valueFor(node.handle, "frame") })) as ModelOperationRecord["arena"]["frames"],
    },
  } as ModelOperationRecord
  if (manifest.tracksExternal) {
    const rows = db
      .prepare("SELECT track_name,attempt_index,refs_json,track_gz FROM v3_tracks WHERE operation_id=?")
      .all(record.identity.operationId) as Array<{
      track_name: string
      attempt_index: number
      refs_json: string
      track_gz: Uint8Array | null
    }>
    const tracks = new Map(
      rows.map((row) => [
        `${row.track_name}:${row.attempt_index}`,
        JSON.parse(row.track_gz ? decoder.decode(decompressBytes(row.track_gz)) : row.refs_json) as OperationTrack,
      ]),
    )
    const track = (name: string, attemptIndex: number): OperationTrack | undefined => tracks.get(`${name}:${attemptIndex}`)
    record = {
      ...record,
      ingress: record.ingress === null ? null : { ...record.ingress, request: track("client-ingress", -1) ?? { frames: [] } },
      attempts: record.attempts.map((attempt, index) => ({
        ...attempt,
        ...(track("effective-request", index) === undefined ? {} : { effectiveRequest: track("effective-request", index) }),
        ...(track("upstream-request", index) === undefined ? {} : { upstreamRequest: track("upstream-request", index) }),
        ...(track("upstream-response", index) === undefined ? {} : { upstreamResponse: track("upstream-response", index) }),
      })),
      egress:
        record.egress === null ?
          null
        : {
            ...record.egress,
            upstream: track("upstream-egress", -1) ?? { frames: [] },
            client: track("client-egress", -1) ?? { frames: [] },
          },
    }
  }
  return record
}

/** Resume terminal journal rows that were appended but never committed. */
export function recoverV3Journal(db: Database = getDatabase()): number {
  ensureV3Schema(db)
  const rows = db
    .prepare("SELECT operation_id,revision,digest,payload_gz,created_at FROM v3_journal WHERE committed_at IS NULL ORDER BY created_at")
    .all() as Array<{
    operation_id: string
    revision: number
    digest: string
    payload_gz: Uint8Array
    created_at: number
  }>
  let recovered = 0
  for (const row of rows) {
    try {
      const recoveredRecord = JSON.parse(decoder.decode(decompressBytes(row.payload_gz))) as ModelOperationRecord
      const prepared = prepareModelOperation(
        recoveredRecord,
        recoveredRecord.terminal?.occurredAt === undefined ? { endedAt: row.created_at, source: "storage-commit-upper-bound" } : undefined,
      )
      if (prepared.revision !== row.revision) throw new Error("journal revision mismatch")
      if (prepared.digest !== row.digest && legacyV1Digest(recoveredRecord) !== row.digest) throw new Error("journal digest mismatch")
      commitPreparedOperation(db, prepared)
      recovered++
    } catch (error) {
      db.prepare("UPDATE v3_journal SET error=? WHERE operation_id=? AND revision=?").run(
        error instanceof Error ? error.message : String(error),
        row.operation_id,
        row.revision,
      )
    }
  }
  return recovered
}

export function resetV3WriterForTests(): void {
  pending.length = 0
  pendingDrains.clear()
  pendingBytes = 0
  draining = false
  summaryBackfillStop = true
  summaryBackfill = null
  status = { pendingOperations: 0, pendingBytes: 0, persistedOperations: 0, failedOperations: 0, conflicts: 0, searchBacklog: 0, summaryBacklog: 0 }
}
