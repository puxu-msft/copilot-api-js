import { consola } from "consola"
import { createHash } from "node:crypto"

import type {
  //
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
import { abortableDelay } from "~/lib/util/abortable-delay"

import type { Database } from "../sqlite/connection"
import type { V3TimingSource } from "./timing-source"

import { getDatabase } from "../sqlite/connection"
import {
  //
  deleteMeta,
  setMeta,
} from "../sqlite/meta"
import { recordToEntrySummary } from "./projection"
import {
  //
  backfillExistingSummaryRows,
  getSummaryProjectionReadiness,
  inspectSummaryProjectionReadiness,
  isSummaryProjectionReady,
  markSummaryProjectionPoisoned,
  publishValidatedOperationSummary,
  type SummaryProjectionReadiness,
  SUMMARY_PROJECTION_READY_KEY,
} from "./summary-store"

export type { V3TimingSource } from "./timing-source"

const FORMAT_VERSION = 3
const SCHEMA_VERSION = "6"
const JOURNAL_FORMAT_VERSION = 2
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

export interface V3StoreStatus {
  pendingOperations: number
  pendingBytes: number
  persistedOperations: number
  failedOperations: number
  conflicts: number
  summaryBacklog: number
  summaryProjectionReady: boolean
  summaryProjectionPending: number
  summaryProjectionPoisoned: number
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
}

export interface CapturedTransportEvidence {
  availability: "captured"
  digest: string
  byteLength: number
  encoding: "binary"
}

export interface TransportEvidenceInput {
  dispatchIndex: number
  sequence: number
  capture: CapturedTransportEvidence
  bytes: Uint8Array
}

export type HydratedTransportEvidence = TransportEvidenceInput

interface PreparedTransportEvidence extends TransportEvidenceInput {
  compressed: Uint8Array
}

export interface PreparedOperation {
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
  transportEvidence: Array<PreparedTransportEvidence>
  objects: Array<PreparedObject>
  sequenceNodes: Array<PreparedSequenceNode>
  tracks: Array<{ name: string; attemptIndex: number; refs: string; compressed: Uint8Array }>
  timeline: Array<{ chunkIndex: number; firstSequence: number; lastSequence: number; payload: Uint8Array; compressed: Uint8Array }>
  byteLength: number
}

export type EnqueueModelOperationOutcome = "persisted" | "failed" | "conflict"

interface PendingOperation {
  record: ModelOperationRecord
  estimatedBytes: number
  resolve: (outcome: EnqueueModelOperationOutcome) => void
}

const pending: Array<PendingOperation> = []
const pendingDrains = new Set<Promise<void>>()
let pendingBytes = 0
let draining = false
/**
 * DI-5 transient-retry budget for the drain commit. Module-level (config apply
 * calls `setV3PersistRetryConfig`) to avoid a store→state import cycle; defaults
 * mirror the old zero-retry behavior's cadence (a few quick attempts).
 *
 * `maxTotalMs` is a per-commit wall-clock soft cap (DI-5-followup-2): the linear
 * backoff sum grows quadratically (`backoffMs·n(n-1)/2`), so a large
 * `maxAttempts × backoffMs` product could wedge the drain — and therefore
 * shutdown, which has no abort signal here on purpose (see runDrain's note) — for
 * minutes. The cap bounds the total retry time for ONE entry regardless of the
 * attempt/backoff product. `0` disables the time cap (only `maxAttempts` bounds).
 */
const DEFAULT_V3_PERSIST_MAX_TOTAL_MS = 30_000
let persistRetryConfig: { maxAttempts: number; backoffMs: number; maxTotalMs: number } = {
  maxAttempts: 3,
  backoffMs: 10,
  maxTotalMs: DEFAULT_V3_PERSIST_MAX_TOTAL_MS,
}
export function setV3PersistRetryConfig(cfg: { maxAttempts: number; backoffMs: number; maxTotalMs?: number }): void {
  persistRetryConfig = {
    maxAttempts: Math.max(1, cfg.maxAttempts),
    backoffMs: Math.max(0, cfg.backoffMs),
    maxTotalMs: Math.max(0, cfg.maxTotalMs ?? DEFAULT_V3_PERSIST_MAX_TOTAL_MS),
  }
}
/** Read the current transient-retry budget (config-wiring assertions). */
export function getV3PersistRetryConfigForTests(): { maxAttempts: number; backoffMs: number; maxTotalMs: number } {
  return persistRetryConfig
}

/**
 * Test-only seam to inject a commit failure into the drain's retry loop. Called
 * once per commit attempt (before `commitPreparedOperation`); throw a transient
 * (`database is locked`) or permanent error to exercise the DI-5 retry path
 * end-to-end without depending on bun:sqlite method-patchability. Null in prod.
 */
let commitFailureInjectorForTests: (() => void) | null = null
export function setV3CommitFailureInjectorForTests(fn: (() => void) | null): void {
  commitFailureInjectorForTests = fn
}

export type TransactionBStage = "canonical" | "tracks" | "refs" | "strict" | "summary"
let transactionBFailureInjectorForTests: ((stage: TransactionBStage) => void) | null = null
export function setV3TransactionBFailureInjectorForTests(fn: ((stage: TransactionBStage) => void) | null): void {
  transactionBFailureInjectorForTests = fn
}

let summaryBackfillStop = false
let summaryBackfill: Promise<void> | null = null
let status: V3StoreStatus = {
  pendingOperations: 0,
  pendingBytes: 0,
  persistedOperations: 0,
  failedOperations: 0,
  conflicts: 0,
  summaryBacklog: 0,
  summaryProjectionReady: false,
  summaryProjectionPending: 0,
  summaryProjectionPoisoned: 0,
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
-- Tail-cursor index for the out-of-process history-search sidecar (Phase 1):
-- committed_at is the INSERT-time wall clock, monotonic by construction
-- (commitPreparedOperation always writes Date.now() at insert time), unlike
-- created_at (client-declared, can arrive slightly out of order) -- the keyset
-- tail cursor uses (committed_at, operation_id) specifically because it is the
-- one column SQLite guarantees to stay stable across a VACUUM (rowid is NOT --
-- SQLite's own docs only say VACUUM "may" renumber rowids on a table without an
-- INTEGER PRIMARY KEY, confirmed empirically to actually do so here). Additive +
-- idempotent, applied unconditionally by the db.exec(V3_SCHEMA_SQL) at the top
-- of ensureV3Schema on every call (not gated by schema_version -- mirrors how
-- the two indexes above were introduced without any version bump).
CREATE INDEX IF NOT EXISTS idx_v3_operations_committed ON v3_operations(committed_at, operation_id);
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
CREATE TABLE IF NOT EXISTS v3_transport_evidence (
  digest TEXT PRIMARY KEY,
  encoding TEXT NOT NULL,
  evidence_gz BLOB NOT NULL,
  byte_length INTEGER NOT NULL
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
  format_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(operation_id, revision)
);
CREATE TABLE IF NOT EXISTS v3_operation_evidence_refs (
  operation_id TEXT NOT NULL REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
  dispatch_index INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL REFERENCES v3_transport_evidence(digest),
  byte_length INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  PRIMARY KEY(operation_id, dispatch_index, sequence)
);
CREATE INDEX IF NOT EXISTS idx_v3_operation_evidence_refs_digest ON v3_operation_evidence_refs(digest);
CREATE TABLE IF NOT EXISTS v3_journal_evidence_refs (
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  dispatch_index INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL REFERENCES v3_transport_evidence(digest),
  byte_length INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  PRIMARY KEY(operation_id, revision, dispatch_index, sequence),
  FOREIGN KEY(operation_id, revision) REFERENCES v3_journal(operation_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_v3_journal_evidence_refs_digest ON v3_journal_evidence_refs(digest);
CREATE TABLE IF NOT EXISTS v3_summary_backlog (
  operation_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * Establish the current floor for a brand-new database, or reconcile only
 * idempotent current-schema indexes for an already-migrated database.
 *
 * Existing schema-5 databases deliberately remain byte/schema-identical here:
 * `001-transport-evidence-schema` is the sole owner of adding evidence storage,
 * adding `v3_journal.format_version`, and publishing schema version 6.
 */
export function ensureV3Schema(db: Database = getDatabase()): void {
  const metaExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_meta'").get()
  if (!metaExists) {
    const create = db.transaction(() => {
      db.exec(V3_SCHEMA_SQL)
      db.prepare("INSERT OR REPLACE INTO v3_meta(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION)
    })
    create()
    return
  }

  const version = db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get() as { value: string } | undefined
  if (version?.value !== SCHEMA_VERSION) return

  // Current-floor reconciliation is additive/idempotent and never owns a version
  // transition. It is safe after migrations and on every ordinary store access.
  db.exec(V3_SCHEMA_SQL)
  db.exec("DROP TABLE IF EXISTS v3_search_membership")
  db.exec("DROP TABLE IF EXISTS v3_search_objects")
  db.exec("DROP TABLE IF EXISTS v3_search_backlog")
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

function objectHashAt(version: number, kind: string, value: unknown): PreparedObject {
  const canonical = encoder.encode(canonicalize(value))
  return { hash: digestBytesAt(version, `object:${kind}`, canonical), kind, canonical, compressed: compressBytes(canonical) }
}

function objectHash(kind: string, value: unknown): PreparedObject {
  return objectHashAt(FORMAT_VERSION, kind, value)
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

function preparePayloadValueAt(version: number, value: unknown): PreparedPayloadValue {
  const objects = new Map<string, PreparedObject>()
  const sequenceNodes = new Map<string, PreparedSequenceNode>()
  const sequences: Array<PreparedSequenceRef> = []
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
        const itemObject = addObject(objectHashAt(version, "sequence-item", stripped.clean))
        const nodeBytes = encoder.encode(`${parentHash ?? ""}\0${itemObject.hash}`)
        const hash = digestBytesAt(version, "sequence-node", nodeBytes)
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
  const object = addObject(objectHashAt(version, sequences.length > 0 ? "payload-skeleton" : "payload", skeleton))
  return {
    object,
    sequences,
    objects: [...objects.values()],
    sequenceNodes: [...sequenceNodes.values()],
  }
}

function preparePayloadValue(value: unknown): PreparedPayloadValue {
  return preparePayloadValueAt(FORMAT_VERSION, value)
}

function refs(track: OperationTrack | undefined): string {
  return JSON.stringify(track ?? { frames: [] })
}

function dispatchesOf(record: ModelOperationRecord): ModelOperationRecord["dispatches"] {
  const compatible = record as unknown as {
    readonly dispatches?: ModelOperationRecord["dispatches"]
    readonly attempts?: ModelOperationRecord["dispatches"]
  }
  return compatible.dispatches ?? compatible.attempts ?? []
}

function candidatesOf(record: ModelOperationRecord): ModelOperationRecord["candidates"] {
  return (record as unknown as { readonly candidates?: ModelOperationRecord["candidates"] }).candidates ?? []
}

function withDispatchAlias(record: ModelOperationRecord): ModelOperationRecord {
  const dispatches = dispatchesOf(record)
  const normalized = { ...record, candidates: candidatesOf(record), dispatches } as ModelOperationRecord
  Object.defineProperty(normalized, "attempts", { enumerable: false, configurable: false, get: () => dispatches })
  return normalized
}

function collectTracks(record: ModelOperationRecord): PreparedOperation["tracks"] {
  const out: PreparedOperation["tracks"] = []
  const push = (name: string, attemptIndex: number, track: Parameters<typeof refs>[0]): void => {
    const json = refs(track)
    out.push({ name, attemptIndex, refs: "{}", compressed: compressBytes(encoder.encode(json)) })
  }
  if (record.ingress) push("client-ingress", -1, record.ingress.request)
  for (const [index, dispatch] of dispatchesOf(record).entries()) {
    push("effective-request", index, dispatch.effectiveRequest)
    push("upstream-request", index, dispatch.upstreamRequest)
    push("upstream-response", index, dispatch.upstreamResponse)
  }
  if (record.egress) {
    push("upstream-egress", -1, record.egress.upstream)
    push("client-egress", -1, record.egress.client)
  }
  return out
}

function recordWithoutTracks(record: ModelOperationRecord): ModelOperationRecord {
  return withDispatchAlias({
    ...record,
    candidates: candidatesOf(record),
    ingress: record.ingress === null ? null : { ...record.ingress, request: { frames: [] } },
    dispatches: dispatchesOf(record).map((dispatch) => ({
      ...dispatch,
      effectiveRequest: dispatch.effectiveRequest === undefined ? undefined : { frames: [] },
      upstreamRequest: dispatch.upstreamRequest === undefined ? undefined : { frames: [] },
      upstreamResponse: dispatch.upstreamResponse === undefined ? undefined : { frames: [] },
    })),
    egress: record.egress === null ? null : { ...record.egress, upstream: { frames: [] }, client: { frames: [] } },
  })
}

export function legacyManifestV1Digest(record: ModelOperationRecord): string {
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

export function legacyManifestV2Digest(record: ModelOperationRecord): string {
  const objectsByHash = new Map<string, PreparedObject>()
  const sequenceNodesByHash = new Map<string, PreparedSequenceNode>()
  const objectHashes = new Map<string, string>()
  const payloadSequences = new Map<string, Array<PreparedSequenceRef>>()
  for (const node of record.arena.payloads) {
    const prepared = preparePayloadValueAt(2, node.value)
    objectHashes.set(node.handle, prepared.object.hash)
    if (prepared.sequences.length > 0) payloadSequences.set(node.handle, prepared.sequences)
    for (const object of prepared.objects) objectsByHash.set(object.hash, object)
    for (const sequenceNode of prepared.sequenceNodes) sequenceNodesByHash.set(sequenceNode.hash, sequenceNode)
  }
  for (const node of record.arena.frames) objectHashes.set(node.handle, objectHashAt(2, "frame", node.value).hash)
  const tracklessRecord = recordWithoutTracks(record)
  const manifestValue = {
    ...tracklessRecord,
    arena: {
      payloads: tracklessRecord.arena.payloads.map(({ value: _value, ...node }) => node),
      frames: tracklessRecord.arena.frames.map(({ value: _value, ...node }) => node),
    },
  }
  const manifest = encoder.encode(
    JSON.stringify({
      formatVersion: 2,
      record: manifestValue,
      objectHashes: Object.fromEntries(objectHashes),
      payloadSequences: Object.fromEntries(payloadSequences),
      tracksExternal: true,
    }),
  )
  return digestBytesAt(2, "operation", manifest)
}

export function prepareModelOperation(
  record: ModelOperationRecord,
  timingOverride?: { endedAt?: number; source: Exclude<V3TimingSource, "canonical"> },
): PreparedOperation {
  return prepareModelOperationWithTransportEvidence(record, [], timingOverride)
}

function evidenceDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function prepareTransportEvidence(inputs: ReadonlyArray<TransportEvidenceInput>): Array<PreparedTransportEvidence> {
  const previousSequence = new Map<number, number>()
  return inputs.map((input) => {
    if (!Number.isInteger(input.dispatchIndex) || input.dispatchIndex < 0) throw new Error("[history/v3] invalid transport evidence dispatch index")
    if (!Number.isInteger(input.sequence) || input.sequence < 1) throw new Error("[history/v3] invalid transport evidence sequence")
    const previous = previousSequence.get(input.dispatchIndex) ?? 0
    if (input.sequence <= previous) throw new Error("[history/v3] non-increasing transport evidence sequence")
    previousSequence.set(input.dispatchIndex, input.sequence)
    if (input.capture.byteLength !== input.bytes.byteLength) throw new Error("[history/v3] transport evidence byte length mismatch")
    if (input.capture.digest !== evidenceDigest(input.bytes)) throw new Error("[history/v3] transport evidence digest mismatch")
    const bytes = Uint8Array.from(input.bytes)
    return { ...input, bytes, compressed: compressBytes(bytes) }
  })
}

export function prepareModelOperationWithTransportEvidence(
  record: ModelOperationRecord,
  transportEvidenceInputs: ReadonlyArray<TransportEvidenceInput>,
  timingOverride?: { endedAt?: number; source: Exclude<V3TimingSource, "canonical"> },
): PreparedOperation {
  if (!record.terminal) throw new Error("[history/v3] terminal record required")
  const objectsByHash = new Map<string, PreparedObject>()
  const sequenceNodesByHash = new Map<string, PreparedSequenceNode>()
  const objectHashes = new Map<string, string>()
  const payloadSequences = new Map<string, Array<PreparedSequenceRef>>()
  for (const node of record.arena.payloads) {
    const prepared = preparePayloadValue(node.value)
    objectHashes.set(node.handle, prepared.object.hash)
    if (prepared.sequences.length > 0) payloadSequences.set(node.handle, prepared.sequences)
    for (const object of prepared.objects) objectsByHash.set(object.hash, object)
    for (const sequenceNode of prepared.sequenceNodes) sequenceNodesByHash.set(sequenceNode.hash, sequenceNode)
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
  const transportEvidence = prepareTransportEvidence(transportEvidenceInputs)
  const transportEvidenceRefs = transportEvidence.map(({ dispatchIndex, sequence, capture }) => ({ dispatchIndex, sequence, ...capture }))
  const manifestText = JSON.stringify({
    formatVersion: FORMAT_VERSION,
    record: manifestValue,
    objectHashes: Object.fromEntries(objectHashes),
    payloadSequences: Object.fromEntries(payloadSequences),
    tracksExternal: true,
    transportEvidenceRefs,
  })
  const manifest = encoder.encode(manifestText)
  const journalRecord = encoder.encode(JSON.stringify({ journalFormatVersion: JOURNAL_FORMAT_VERSION, record, transportEvidenceRefs }))
  const digest = digestBytes("operation", manifest)
  const timelineEvents = [
    ...record.arena.payloads.map((node) => ({ sequence: node.sequence, occurredAt: node.occurredAt, type: "payload", handle: node.handle })),
    ...record.arena.frames.map((node) => ({ sequence: node.sequence, occurredAt: node.occurredAt, type: "frame", handle: node.handle })),
    ...(record.ingress ? [{ sequence: record.ingress.sequence, occurredAt: record.ingress.occurredAt, type: "ingress" }] : []),
    ...(record.routing ? [{ sequence: record.routing.sequence, occurredAt: record.routing.occurredAt, type: "routing" }] : []),
    ...record.transforms.map((event) => ({ sequence: event.sequence, occurredAt: event.occurredAt, type: "transform", value: event })),
    ...candidatesOf(record).flatMap((candidate) => [
      {
        sequence: candidate.sequence,
        occurredAt: candidate.occurredAt,
        type: "candidate",
        handle: candidate.handle,
        role: candidate.role,
        parentCandidate: candidate.parentCandidate,
      },
      ...(candidate.settledSequence ?
        [
          {
            sequence: candidate.settledSequence,
            occurredAt: candidate.settledAt,
            type: "candidate-settled",
            handle: candidate.handle,
            verdict: candidate.verdict,
          },
        ]
      : []),
    ]),
    ...dispatchesOf(record).flatMap((dispatch) => [
      {
        sequence: dispatch.sequence,
        occurredAt: dispatch.occurredAt,
        type: "dispatch",
        handle: dispatch.handle,
        candidate: dispatch.candidate,
      },
      ...dispatch.diagnostics.map((diagnostic) => ({
        sequence: diagnostic.sequence,
        occurredAt: diagnostic.occurredAt,
        type: "diagnostic",
        value: diagnostic,
      })),
      ...(dispatch.settledSequence ?
        [
          {
            sequence: dispatch.settledSequence,
            occurredAt: dispatch.settledAt,
            type: "dispatch-settled",
            handle: dispatch.handle,
            candidate: dispatch.candidate,
            verdict: dispatch.verdict,
          },
        ]
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
    transportEvidence,
    objects: [...objectsByHash.values()],
    sequenceNodes: [...sequenceNodesByHash.values()],
    tracks,
    timeline,
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

function insertTransportEvidence(db: Database, evidence: PreparedTransportEvidence): void {
  const existing = db.prepare("SELECT encoding,evidence_gz,byte_length FROM v3_transport_evidence WHERE digest=?").get(evidence.capture.digest) as
    | { encoding: string; evidence_gz: Uint8Array; byte_length: number }
    | undefined
  if (existing) {
    if (existing.encoding !== evidence.capture.encoding) throw new Error(`[history/v3] transport evidence encoding mismatch: ${evidence.capture.digest}`)
    if (existing.byte_length !== evidence.capture.byteLength)
      throw new Error(`[history/v3] transport evidence byte length mismatch: ${evidence.capture.digest}`)
    const existingBytes = decompressBytes(existing.evidence_gz)
    if (!Buffer.from(existingBytes).equals(Buffer.from(evidence.bytes)))
      throw new Error(`[history/v3] transport evidence digest collision: ${evidence.capture.digest}`)
    return
  }
  db.prepare("INSERT INTO v3_transport_evidence(digest,encoding,evidence_gz,byte_length) VALUES(?,?,?,?)").run(
    evidence.capture.digest,
    evidence.capture.encoding,
    evidence.compressed,
    evidence.capture.byteLength,
  )
}

function insertOperationEvidenceRefs(db: Database, operationId: string, refs: ReadonlyArray<TransportEvidenceRef>): void {
  const statement = db.prepare("INSERT INTO v3_operation_evidence_refs(operation_id,dispatch_index,sequence,digest,byte_length,encoding) VALUES(?,?,?,?,?,?)")
  for (const ref of refs) statement.run(operationId, ref.dispatchIndex, ref.sequence, ref.digest, ref.byteLength, ref.encoding)
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
      // Transaction A publishes one recovery set: every evidence entity and the
      // journal that references it either become durable together or both roll back.
      const journalPayload = prepared.compressedJournalRecord
      const transactionA = db.transaction(() => {
        for (const evidence of prepared.transportEvidence) insertTransportEvidence(db, evidence)
        db.prepare(
          "INSERT OR REPLACE INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,committed_at,error,format_version) VALUES(?,?,?,?,?,?,NULL,NULL,?)",
        ).run(prepared.id, prepared.revision, prepared.digest, "terminal", journalPayload, Date.now(), JOURNAL_FORMAT_VERSION)
        const journalRefStatement = db.prepare(
          "INSERT INTO v3_journal_evidence_refs(operation_id,revision,dispatch_index,sequence,digest,byte_length,encoding) VALUES(?,?,?,?,?,?,?)",
        )
        for (const evidence of prepared.transportEvidence) {
          const { capture } = evidence
          journalRefStatement.run(
            prepared.id,
            prepared.revision,
            evidence.dispatchIndex,
            evidence.sequence,
            capture.digest,
            capture.byteLength,
            capture.encoding,
          )
        }
      })
      transactionA()
      const committedAt = Date.now()
      const transactionB = db.transaction(() => {
        // Only the marker matters here, and it is an O(1) primary-key lookup.
        // The readiness aggregate scans all of v3_operation_summaries with no
        // usable index, so calling it per commit made write cost grow with
        // history length while both of its counts were discarded.
        const restoreReadyMarker = isSummaryProjectionReady(db)
        for (const object of prepared.objects) insertObject(db, object)
        for (const node of prepared.sequenceNodes) insertSequenceNode(db, node)
        db.prepare(
          "INSERT INTO v3_operations(operation_id,revision,digest,kind,created_at,terminal_sequence,ended_at,timing_source,manifest_gz,summary_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)",
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
          committedAt,
        )
        transactionBFailureInjectorForTests?.("canonical")
        const trackStmt = db.prepare("INSERT INTO v3_tracks(operation_id,track_name,attempt_index,refs_json,track_gz) VALUES(?,?,?,?,?)")
        for (const track of prepared.tracks) trackStmt.run(prepared.id, track.name, track.attemptIndex, track.refs, track.compressed)
        transactionBFailureInjectorForTests?.("tracks")
        const timelineStmt = db.prepare("INSERT INTO v3_timeline_chunks(operation_id,chunk_index,first_sequence,last_sequence,payload_gz) VALUES(?,?,?,?,?)")
        for (const chunk of prepared.timeline) timelineStmt.run(prepared.id, chunk.chunkIndex, chunk.firstSequence, chunk.lastSequence, chunk.compressed)
        insertOperationEvidenceRefs(
          db,
          prepared.id,
          prepared.transportEvidence.map(({ dispatchIndex, sequence, capture }) => ({ dispatchIndex, sequence, ...capture })),
        )
        transactionBFailureInjectorForTests?.("refs")
        hydrateManifest(db, prepared.compressedManifest, prepared.id)
        transactionBFailureInjectorForTests?.("strict")
        db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=?").run(prepared.summaryJson, prepared.id)
        publishValidatedOperationSummary(db, prepared.id, restoreReadyMarker)
        transactionBFailureInjectorForTests?.("summary")
        // Once the operation transaction commits, the durable manifest + CAS objects are the
        // recovery source. Keeping the self-contained journal payload after this point would
        // duplicate every semantic value forever and defeat content-addressed storage.
        db.prepare("DELETE FROM v3_journal WHERE operation_id=? AND revision=?").run(prepared.id, prepared.revision)
      })
      transactionB()
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

/** One commit attempt's classified outcome (mirrors persist-guard's `PersistResult` + conflict). */
export interface TransientRetryAttemptResult {
  ok: boolean
  /** persist-guard classified the failure as transient (BUSY/LOCKED/IOERR) — retry can help. */
  transient: boolean
  /** data-contract violation (duplicate operationId / differing digest) — never retryable. */
  conflict: boolean
}

export interface TransientRetryOptions {
  maxAttempts: number
  backoffMs: number
  /**
   * DI-5-followup-2: soft cap on the total wall-clock time (ms) one commit may
   * spend across all its retries. The linear backoff sum grows quadratically
   * (`backoffMs·n(n-1)/2`), and each `attempt()` can itself block (e.g. a SQLite
   * `busy_timeout` wait — the bulk of a real WAL-contention wedge), so a large
   * `maxAttempts × backoffMs` product (or slow attempts) could wedge the drain —
   * and therefore shutdown, which has no abort signal here on purpose (see
   * runDrain's note) — for minutes. Once the elapsed time (INCLUDING each
   * attempt's own blocking) plus the next backoff would exceed this cap, stop
   * retrying and report failure. Measured via the injectable `now` seam below
   * (defaults to `Date.now`; tests inject a deterministic counter). `0`/`undefined`
   * = no time cap (only `maxAttempts` bounds).
   */
  maxTotalMs?: number
  /** Abort collapses the backoff wait (shutdown drain wants to land data fast, not cancel it). */
  signal?: AbortSignal
  /**
   * Clock seam for the `maxTotalMs` wall-clock cap. Defaults to `Date.now`
   * (production). Tests inject a deterministic counter to drive elapsed time
   * (including a modeled slow `attempt()`) without a real sleep or a global fake
   * timer — mirroring the `abortableDelay` scale seam.
   */
  now?: () => number
}

export interface TransientRetryOutcome {
  ok: boolean
  conflict: boolean
  attempts: number
  /**
   * Which soft cap ended the retry loop, for drain observability — distinguishes
   * "hit the attempt ceiling" from "ran out of the time budget" when an entry is
   * dropped. `undefined` when the loop ended on success / permanent failure / conflict.
   */
  capReason?: "max-attempts" | "max-total-ms"
}

/**
 * DI-5: run a commit attempt with bounded retry ONLY for transient (retryable)
 * persistence failures. persist-guard already classifies BUSY/LOCKED/IOERR as
 * transient, but the drain used to ignore that and drop the entry on the first
 * failure. Permanent failures and conflicts are not retried (pointless). A hard
 * `maxAttempts` cap keeps a transient storm from spinning forever (skill
 * persistence-async-invariants §4 "持续 drain 失败须软上界"). A `maxTotalMs` cap
 * (DI-5-followup-2) bounds the total wall-clock time so a large attempt/backoff
 * product — or a slow attempt (SQLite busy_timeout) — can't wedge shutdown for
 * minutes. The linear backoff is `abortableDelay`-based so a shutdown/abort
 * during a storm collapses the wait (keeps trying to land the data before close)
 * rather than wedging the drain.
 */
export async function runWithTransientRetry(attempt: () => Promise<TransientRetryAttemptResult>, opts: TransientRetryOptions): Promise<TransientRetryOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts)
  const maxTotalMs = opts.maxTotalMs !== undefined && opts.maxTotalMs > 0 ? opts.maxTotalMs : undefined
  const now = opts.now ?? Date.now
  const startedAt = now()
  let attempts = 0
  for (;;) {
    attempts++
    const result = await attempt()
    if (result.ok) return { ok: true, conflict: false, attempts }
    if (result.conflict) return { ok: false, conflict: true, attempts }
    if (!result.transient) return { ok: false, conflict: false, attempts } // permanent — retry is pointless
    if (attempts >= maxAttempts) return { ok: false, conflict: false, attempts, capReason: "max-attempts" } // attempt-count soft cap
    const backoffMs = opts.backoffMs * attempts
    // Wall-clock time-budget soft cap: give up once the elapsed time (INCLUDING
    // each attempt's own blocking — e.g. a SQLite busy_timeout wait, the bulk of a
    // real wedge) plus the next backoff would exceed maxTotalMs. Bounds the total
    // time one entry can hold the drain (→ shutdown, which has no abort signal
    // here on purpose) regardless of the maxAttempts × backoffMs product.
    if (maxTotalMs !== undefined && now() - startedAt + backoffMs > maxTotalMs) {
      return { ok: false, conflict: false, attempts, capReason: "max-total-ms" }
    }
    try {
      await abortableDelay(backoffMs, opts.signal)
    } catch {
      // OperationCancelledError: the signal aborted (shutdown). Collapse the wait
      // but keep retrying up to the cap — abort shortens backoff, it doesn't stop
      // the effort to persist before the DB closes.
    }
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
      let outcome: EnqueueModelOperationOutcome = "failed"
      try {
        const prepared = await Promise.resolve().then(() => prepareModelOperation(item.record))
        // Captures a non-conflict thrown error so `lastError` still carries its
        // message after persist-guard's classify/log/count (which only returns
        // `{ ok, transient }`, no message) — mirrors the same pattern used
        // inside `commitPreparedOperation` itself.
        let nonConflictError: unknown
        // DI-5: a transient failure (WAL BUSY/LOCKED/IOERR) used to be counted as
        // failed and the entry dropped on the FIRST attempt. Retry it with bounded
        // backoff (persist-guard already classified transient vs permanent). Each
        // retry re-runs the full commit: on a failed attempt the operation tx rolls
        // back entirely and the journal row is `INSERT OR REPLACE`, so retrying the
        // same `prepared` is idempotent (a rare already-committed row returns
        // "idempotent" and is not double-written).
        const retryOutcome = await runWithTransientRetry(
          async () => {
            nonConflictError = undefined
            let attemptConflict = false
            const result = await runHistoryWriteAsync("v3-drain", async () => {
              try {
                commitFailureInjectorForTests?.() // DI-5 test seam: no-op in prod
                const commitResult = commitPreparedOperation(getDatabase(), prepared)
                if (commitResult === "inserted") status = { ...status, persistedOperations: status.persistedOperations + 1 }
              } catch (error) {
                if (error instanceof V3OperationConflictError) {
                  attemptConflict = true
                  // A conflict is a data-contract violation (duplicate operationId,
                  // differing revision/digest), not a SQLite persistence failure —
                  // `commitPreparedOperation` already bumped `status.conflicts`
                  // above. Swallow it HERE so runHistoryWriteAsync reports ok:true
                  // (retry stops — a conflict is never retryable) and it is never
                  // double-counted as a "v3-drain" persistence failure.
                  return
                }
                nonConflictError = error
                throw error
              }
            })
            return { ok: result.ok && !attemptConflict, transient: result.transient, conflict: attemptConflict }
          },
          // No shutdown signal here on purpose: importing `~/lib/shutdown` would
          // create a store→shutdown→state require cycle that reorders module init
          // (corrupts digest computation). The backoff is tiny (base 10ms × a few
          // attempts), so not collapsing it at shutdown costs ~tens of ms of drain
          // time — negligible vs. the cycle risk. `runWithTransientRetry` still
          // accepts a signal for callers that can provide one without the cycle.
          { maxAttempts: persistRetryConfig.maxAttempts, backoffMs: persistRetryConfig.backoffMs, maxTotalMs: persistRetryConfig.maxTotalMs },
        )
        if (retryOutcome.conflict) {
          outcome = "conflict"
        } else if (retryOutcome.ok) {
          outcome = "persisted"
        } else {
          // Surface WHICH soft cap dropped the entry (attempt ceiling vs time
          // budget) alongside the last error, so an operator can tell a transient
          // storm (max-attempts) from a wedge-guard trip (max-total-ms).
          const lastError = nonConflictError instanceof Error ? nonConflictError.message : String(nonConflictError)
          status = {
            ...status,
            failedOperations: status.failedOperations + 1,
            lastError: retryOutcome.capReason ? `${lastError} (retry gave up: ${retryOutcome.capReason})` : lastError,
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
        item.resolve(outcome)
      }
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0))
    }
  } finally {
    draining = false
    status = { ...status, pendingOperations: pending.length, pendingBytes }
  }
}

/** Enqueue a terminal record and retain the operation-scoped durability outcome. Never rejects. */
export function enqueueModelOperationWithOutcome(record: ModelOperationRecord): Promise<EnqueueModelOperationOutcome> {
  const estimatedBytes = estimateRecordBytes(record)
  let resolve!: (outcome: EnqueueModelOperationOutcome) => void
  const done = new Promise<EnqueueModelOperationOutcome>((doneResolve) => {
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

/** Compatibility surface: resolves after the commit attempt and never exposes persistence failure to model delivery. */
export async function enqueueModelOperation(record: ModelOperationRecord): Promise<void> {
  await enqueueModelOperationWithOutcome(record)
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
  const summaryBacklog = (db.prepare("SELECT COUNT(*) AS n FROM v3_summary_backlog").get() as { n: number }).n
  const projection = getSummaryProjectionReadiness(db)
  return {
    ...status,
    pendingOperations: pending.length,
    pendingBytes,
    summaryBacklog,
    summaryProjectionReady: projection.ready,
    summaryProjectionPending: projection.pending,
    summaryProjectionPoisoned: projection.poisoned,
  }
}

interface V3StoredOperationRow {
  operation_id: string
  manifest_gz: Uint8Array
  pinned: number
  ended_at: number | null
  timing_source: V3TimingSource
}

function storedOperationFromRow(db: Database, row: V3StoredOperationRow): V3StoredOperation {
  return {
    record: hydrateManifest(db, row.manifest_gz, row.operation_id),
    pinned: row.pinned === 1,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    timingSource: row.timing_source,
  }
}

export function getV3StoredOperation(operationId: string, db: Database = getDatabase()): V3StoredOperation | undefined {
  ensureV3Schema(db)
  const row = db.prepare("SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE operation_id=?").get(operationId) as
    | V3StoredOperationRow
    | undefined
  return row ? storedOperationFromRow(db, row) : undefined
}

export function getV3StoredOperations(operationIds: ReadonlyArray<string>, db: Database = getDatabase()): Map<string, V3StoredOperation> {
  ensureV3Schema(db)
  if (operationIds.length === 0) return new Map()
  const rows = db
    .prepare(
      `SELECT operation_id,manifest_gz,pinned,ended_at,timing_source
       FROM v3_operations
       WHERE operation_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(operationIds)) as Array<{
    operation_id: string
    manifest_gz: Uint8Array
    pinned: number
    ended_at: number | null
    timing_source: V3TimingSource
  }>
  return new Map(rows.map((row) => [row.operation_id, storedOperationFromRow(db, row)]))
}

export function getV3Operation(operationId: string): ModelOperationRecord | undefined {
  return getV3StoredOperation(operationId)?.record
}

export function listV3StoredOperations(kind?: string, limit = 100, db: Database = getDatabase()): Array<V3StoredOperation> {
  ensureV3Schema(db)
  const rows =
    kind ?
      db
        .prepare(
          "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ?",
        )
        .all(kind, limit)
    : db
        .prepare("SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ?")
        .all(limit)
  return (rows as Array<V3StoredOperationRow>).map((row) => storedOperationFromRow(db, row))
}

export function listV3Operations(kind?: string, limit = 100): Array<ModelOperationRecord> {
  return listV3StoredOperations(kind, limit).map(({ record }) => record)
}

function summaryFromRow(
  db: Database,
  row: { operation_id: string; manifest_gz: Uint8Array; pinned: number; ended_at: number | null; timing_source: V3TimingSource },
): EntrySummary {
  // A cached summary is never permission to publish an unvalidated canonical
  // operation, and it is never the published value either. The marker-absent
  // fallback exists precisely because `summary_json` is not yet known to agree
  // with canonical: migration 002 revokes the marker without clearing the
  // derived column, and a protected UPDATE revokes it without repairing the row.
  // Publishing the cached value here would hand consumers the very projection
  // the fallback was entered to distrust, so reproject from the record that the
  // decode + evidence gate just validated.
  const stored = storedOperationFromRow(db, row)
  return recordToEntrySummary(stored.record, stored)
}

/** Visit persisted summaries newest-first after validating each canonical operation. */
export function visitV3Summaries(visitor: (summary: EntrySummary) => unknown, kind?: string, pageSize = 256): void {
  const db = getDatabase()
  ensureV3Schema(db)
  let offset = 0
  while (true) {
    const rows =
      kind ?
        db
          .prepare(
            "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(kind, pageSize, offset)
      : db
          .prepare(
            "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(pageSize, offset)
    const page = rows as Array<{
      operation_id: string
      manifest_gz: Uint8Array
      pinned: number
      ended_at: number | null
      timing_source: V3TimingSource
    }>
    if (page.length === 0) return
    offset += page.length
    for (const row of page) if (visitor(summaryFromRow(db, row)) === false) return
  }
}

export function validateAndMarkSummaryProjectionReady(db: Database = getDatabase()): SummaryProjectionReadiness {
  db.exec("BEGIN IMMEDIATE")
  try {
    const rows = db.prepare("SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY operation_id").all() as Array<{
      operation_id: string
      manifest_gz: Uint8Array
      pinned: number
      ended_at: number | null
      timing_source: V3TimingSource
    }>
    for (const row of rows) {
      try {
        const record = hydrateManifest(db, row.manifest_gz, row.operation_id)
        const stored = {
          record,
          pinned: row.pinned === 1,
          ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
          timingSource: row.timing_source,
        }
        db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=?").run(JSON.stringify(recordToEntrySummary(record, stored)), row.operation_id)
        publishValidatedOperationSummary(db, row.operation_id, false)
      } catch (error) {
        markSummaryProjectionPoisoned(db, row.operation_id, error instanceof Error ? error.message : String(error))
      }
    }
    const readiness = inspectSummaryProjectionReadiness(db)
    if (readiness.ready) setMeta(db, SUMMARY_PROJECTION_READY_KEY, "1")
    else deleteMeta(db, SUMMARY_PROJECTION_READY_KEY)
    db.exec("COMMIT")
    return readiness
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // Preserve the strict validation error when SQLite already rolled back.
    }
    throw error
  }
}

export function startV3SummaryBackfill(
  db: Database = getDatabase(),
  batchSize = 16,
  checkReadiness: (database: Database) => SummaryProjectionReadiness = validateAndMarkSummaryProjectionReady,
): void {
  if (summaryBackfill) return
  summaryBackfillStop = false
  summaryBackfill = (async () => {
    let cursor: Parameters<typeof backfillExistingSummaryRows>[2]
    let projectionDone = false
    while (!summaryBackfillStop) {
      const page: ReturnType<typeof backfillExistingSummaryRows> =
        projectionDone ? { inserted: 0, cursor: null } : backfillExistingSummaryRows(db, batchSize, cursor)
      cursor = page.cursor
      projectionDone = page.cursor === null
      const rows = db
        .prepare(
          `SELECT o.operation_id,o.manifest_gz,o.pinned,o.ended_at,o.timing_source
           FROM v3_operations o
           JOIN v3_operation_summaries s ON s.operation_id=o.operation_id
           WHERE o.summary_json IS NULL
             AND s.projection_status='pending'
             AND o.operation_id NOT IN (SELECT operation_id FROM v3_summary_backlog)
           ORDER BY o.created_at,o.operation_id
           LIMIT ?`,
        )
        .all(batchSize) as Array<{
        operation_id: string
        manifest_gz: Uint8Array
        pinned: number
        ended_at: number | null
        timing_source: V3TimingSource
      }>
      for (const row of rows) {
        try {
          const stored = {
            record: hydrateManifest(db, row.manifest_gz, row.operation_id),
            pinned: row.pinned === 1,
            ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
            timingSource: row.timing_source,
          }
          db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=? AND summary_json IS NULL").run(
            JSON.stringify(recordToEntrySummary(stored.record, stored)),
            row.operation_id,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          consola.error(`[history/v3] summary backfill failed for ${row.operation_id}`, error)
          db.prepare("INSERT OR REPLACE INTO v3_summary_backlog(operation_id,reason,updated_at) VALUES(?,?,?)").run(row.operation_id, reason, Date.now())
          markSummaryProjectionPoisoned(db, row.operation_id, reason)
        }
      }
      if (projectionDone && rows.length === 0) {
        checkReadiness(db)
        return
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
export function visitV3StoredOperations(visitor: (stored: V3StoredOperation) => unknown, kind?: string, pageSize = 64, db: Database = getDatabase()): void {
  ensureV3Schema(db)
  let offset = 0
  while (true) {
    const rows =
      kind ?
        db
          .prepare(
            "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(kind, pageSize, offset)
      : db
          .prepare(
            "SELECT operation_id,manifest_gz,pinned,ended_at,timing_source FROM v3_operations ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?",
          )
          .all(pageSize, offset)
    const page = rows as Array<V3StoredOperationRow>
    if (page.length === 0) return
    offset += page.length
    for (const row of page) {
      const shouldContinue = visitor(storedOperationFromRow(db, row))
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

/**
 * Delete every persisted V3 history row while retaining schema metadata.
 * This is the storage primitive behind the test-only `clearHistory()` reset;
 * product surfaces must not expose it as a user-facing destructive action.
 */
export function clearV3Store(db: Database = getDatabase()): void {
  ensureV3Schema(db)
  const clear = db.transaction(() => {
    db.prepare("DELETE FROM v3_summary_backlog").run()
    db.prepare("DELETE FROM v3_timeline_chunks").run()
    db.prepare("DELETE FROM v3_tracks").run()
    db.prepare("DELETE FROM v3_operations").run()
    db.prepare("DELETE FROM v3_sequence_nodes").run()
    db.prepare("DELETE FROM v3_objects").run()
    db.prepare("DELETE FROM v3_journal").run()
    db.prepare("DELETE FROM v3_transport_evidence").run()
    deleteMeta(db, SUMMARY_PROJECTION_READY_KEY)
  })
  clear()
}

/**
 * Rebuild a full `ModelOperationRecord` from a compressed manifest blob against
 * CAS tables (`v3_objects`/`v3_sequence_nodes`) and, if `tracksExternal`, `v3_tracks`.
 * A pure read: touches only the passed-in `db` handle and module-level constants/pure
 * helpers (never the mutable writer-singleton state — `pending`/`draining`/`status`) —
 * this is what makes it safe to call against an independent readonly connection
 * (e.g. from the history-search sidecar, out-of-process search plan Phase 0).
 */
interface TransportEvidenceRef extends CapturedTransportEvidence {
  dispatchIndex: number
  sequence: number
}

interface ManifestEnvelope {
  formatVersion: 1 | 2 | 3
  record: Omit<ModelOperationRecord, "arena"> & {
    arena: {
      payloads: Array<Omit<ModelOperationRecord["arena"]["payloads"][number], "value">>
      frames: Array<Omit<ModelOperationRecord["arena"]["frames"][number], "value">>
    }
  }
  objectHashes: Record<string, string>
  payloadSequences?: Record<string, Array<PreparedSequenceRef>>
  tracksExternal?: boolean
  transportEvidenceRefs: Array<TransportEvidenceRef>
}

function decodeManifestEnvelope(manifestBlob: Uint8Array): ManifestEnvelope {
  const decoded = JSON.parse(decoder.decode(decompressBytes(manifestBlob))) as Record<string, unknown>
  const version = decoded.formatVersion
  if (!Number.isInteger(version) || (version !== 1 && version !== 2 && version !== 3)) {
    throw new Error(`[history/v3] unsupported manifest format version: ${String(version)}`)
  }
  if (!decoded.record || typeof decoded.record !== "object" || !decoded.objectHashes || typeof decoded.objectHashes !== "object") {
    throw new Error("[history/v3] invalid manifest envelope")
  }
  const refs = version === 3 ? decoded.transportEvidenceRefs : []
  if (version === 3 && !Array.isArray(refs)) throw new Error("[history/v3] invalid manifest-v3 transport evidence refs")
  return {
    ...(decoded as unknown as Omit<ManifestEnvelope, "formatVersion" | "transportEvidenceRefs">),
    formatVersion: version,
    transportEvidenceRefs: refs as Array<TransportEvidenceRef>,
  }
}

function validateTransportEvidenceRefs(refs: ReadonlyArray<TransportEvidenceRef>): void {
  const previousSequence = new Map<number, number>()
  for (const ref of refs) {
    if (!Object.is(ref.availability, "captured")) throw new Error("[history/v3] invalid transport evidence availability")
    if (!Number.isInteger(ref.dispatchIndex) || ref.dispatchIndex < 0) throw new Error("[history/v3] invalid transport evidence dispatch index")
    if (!Number.isInteger(ref.sequence) || ref.sequence < 1) throw new Error("[history/v3] invalid transport evidence sequence")
    if (!/^[a-f\d]{64}$/.test(ref.digest)) throw new Error("[history/v3] invalid transport evidence digest")
    if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) throw new Error("[history/v3] invalid transport evidence byte length")
    if (!Object.is(ref.encoding, "binary")) throw new Error("[history/v3] invalid transport evidence encoding")
    const previous = previousSequence.get(ref.dispatchIndex) ?? 0
    if (ref.sequence <= previous) throw new Error("[history/v3] non-increasing transport evidence sequence")
    previousSequence.set(ref.dispatchIndex, ref.sequence)
  }
}

interface PersistedEvidenceRefRow {
  dispatch_index: number
  sequence: number
  digest: string
  byte_length: number
  encoding: string
}

function persistedEvidenceRef(row: PersistedEvidenceRefRow, scope: "journal" | "operation"): TransportEvidenceRef {
  if (row.encoding !== "binary") throw new Error(`[history/v3] invalid ${scope} evidence ref encoding: ${row.encoding}`)
  return {
    availability: "captured",
    dispatchIndex: row.dispatch_index,
    sequence: row.sequence,
    digest: row.digest,
    byteLength: row.byte_length,
    encoding: row.encoding,
  }
}

/**
 * Whether this database carries the normalized evidence-ref table at all.
 *
 * Schema 5 and earlier predate it. Such a database can only hold v1/v2 manifests,
 * whose envelope ref set is empty by construction, so the empty↔empty contract
 * holds trivially and there is nothing to reconcile against. Querying the table
 * unconditionally would instead make every legacy database unreadable — the
 * false-red half of the criterion.
 */
function hasOperationEvidenceRefsTable(db: Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_operation_evidence_refs'").get() !== null
}

function operationRefs(db: Database, operationId: string): Array<TransportEvidenceRef> {
  return (
    db
      .prepare(
        "SELECT dispatch_index,sequence,digest,byte_length,encoding FROM v3_operation_evidence_refs WHERE operation_id=? ORDER BY dispatch_index,sequence",
      )
      .all(operationId) as Array<PersistedEvidenceRefRow>
  ).map((row) => persistedEvidenceRef(row, "operation"))
}

/**
 * Bind a decoded envelope's self-reported operation identity to the SQL row that
 * owns it. Every decode path — canonical manifest and journal payload alike —
 * runs this before its record, refs or entities are used for anything, so a
 * payload swapped onto another row's blob column fails loud instead of
 * publishing under the wrong identity.
 */
function assertRecordOperationIdentity(record: { identity: { operationId: string } }, expectedOperationId: string, kind: "manifest" | "journal"): void {
  const actualOperationId = record.identity.operationId
  if (actualOperationId !== expectedOperationId) {
    throw new Error(`[history/v3] ${kind} operation identity mismatch: expected ${expectedOperationId}, got ${actualOperationId}`)
  }
}

function assertManifestOperationIdentity(manifest: ManifestEnvelope, expectedOperationId: string): void {
  assertRecordOperationIdentity(manifest.record, expectedOperationId, "manifest")
}

function validateStoredOperationDigest(db: Database, manifestBlob: Uint8Array, manifest: ManifestEnvelope, operationId: string): void {
  const row = db.prepare("SELECT digest FROM v3_operations WHERE operation_id=?").get(operationId) as { digest: string } | undefined
  if (!row) throw new Error(`[history/v3] missing stored operation digest: ${operationId}`)
  const actual = digestBytesAt(manifest.formatVersion, "operation", decompressBytes(manifestBlob))
  if (actual !== row.digest) throw new Error(`[history/v3] operation digest mismatch: ${operationId}`)
}

function validatePersistedOperationEvidenceRefs(db: Database, manifest: ManifestEnvelope, operationId: string): Array<HydratedTransportEvidence> {
  validateTransportEvidenceRefs(manifest.transportEvidenceRefs)
  const normalized = operationRefs(db, operationId)
  validateTransportEvidenceRefs(normalized)
  if (!refsEqual(manifest.transportEvidenceRefs, normalized)) throw new Error("[history/v3] operation evidence refs mismatch")
  return hydrateTransportEvidenceRefs(db, manifest.transportEvidenceRefs)
}

function hydrateTransportEvidenceRefs(db: Database, refs: ReadonlyArray<TransportEvidenceRef>): Array<HydratedTransportEvidence> {
  if (refs.length === 0) return []
  validateTransportEvidenceRefs(refs)
  const hydrated = new Map<string, { bytes: Uint8Array; encoding: string; byteLength: number }>()
  for (const ref of refs) {
    let entity = hydrated.get(ref.digest)
    if (!entity) {
      const evidenceRow = db.prepare("SELECT encoding,evidence_gz,byte_length FROM v3_transport_evidence WHERE digest=?").get(ref.digest) as
        | { encoding: string; evidence_gz: Uint8Array; byte_length: number }
        | undefined
      if (!evidenceRow) throw new Error(`[history/v3] missing transport evidence: ${ref.digest}`)
      const bytes = decompressBytes(evidenceRow.evidence_gz)
      entity = { bytes, encoding: evidenceRow.encoding, byteLength: evidenceRow.byte_length }
      hydrated.set(ref.digest, entity)
    }
    if (entity.encoding !== ref.encoding) throw new Error(`[history/v3] transport evidence encoding mismatch: ${ref.digest}`)
    if (entity.byteLength !== ref.byteLength || entity.bytes.byteLength !== ref.byteLength) {
      throw new Error(`[history/v3] transport evidence byte length mismatch: ${ref.digest}`)
    }
    if (evidenceDigest(entity.bytes) !== ref.digest) throw new Error(`[history/v3] transport evidence digest mismatch: ${ref.digest}`)
  }
  return refs.map((ref) => {
    const { dispatchIndex, sequence, ...capture } = ref
    const entity = hydrated.get(ref.digest)
    if (!entity) throw new Error(`[history/v3] missing transport evidence after validation: ${ref.digest}`)
    return { dispatchIndex, sequence, capture, bytes: Uint8Array.from(entity.bytes) }
  })
}

export function hydrateTransportEvidence(db: Database, operationId: string): Array<HydratedTransportEvidence> {
  const row = db.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get(operationId) as { manifest_gz: Uint8Array } | undefined
  if (!row) return []
  const manifest = decodeManifestEnvelope(row.manifest_gz)
  assertManifestOperationIdentity(manifest, operationId)
  return validatePersistedOperationEvidenceRefs(db, manifest, operationId)
}

function operationEvidenceRefGroups(db: Database): Array<Array<TransportEvidenceRef>> {
  const rows = db.prepare("SELECT operation_id,manifest_gz FROM v3_operations").all() as Array<{ operation_id: string; manifest_gz: Uint8Array }>
  return rows.map(({ operation_id, manifest_gz }) => {
    const manifest = decodeManifestEnvelope(manifest_gz)
    assertManifestOperationIdentity(manifest, operation_id)
    validateTransportEvidenceRefs(manifest.transportEvidenceRefs)
    const normalized = operationRefs(db, operation_id)
    validateTransportEvidenceRefs(normalized)
    if (!refsEqual(manifest.transportEvidenceRefs, normalized)) throw new Error("[history/v3] operation evidence refs mismatch")
    return manifest.transportEvidenceRefs
  })
}

function journalEvidenceRefGroups(db: Database): Array<Array<TransportEvidenceRef>> {
  const rows = db.prepare("SELECT operation_id,revision,payload_gz,format_version FROM v3_journal WHERE committed_at IS NULL").all() as Array<{
    operation_id: string
    revision: number
    payload_gz: Uint8Array
    format_version: number
  }>
  return rows.map(({ operation_id, revision, payload_gz, format_version }) => {
    const refs = decodeJournalPayload(format_version, payload_gz, operation_id).refs
    validateTransportEvidenceRefs(refs)
    const normalized = journalRefs(db, operation_id, revision)
    validateTransportEvidenceRefs(normalized)
    if (!refsEqual(refs, normalized)) throw new Error("[history/v3] journal evidence refs mismatch")
    return refs
  })
}

export function garbageCollectTransportEvidence(db: Database = getDatabase()): number {
  ensureV3Schema(db)
  const groups = [...operationEvidenceRefGroups(db), ...journalEvidenceRefGroups(db)]
  // Validate every root document and entity before deleting anything. Sequence
  // domains are operation-local, so validating one flattened cross-operation list
  // would falsely reject two operations that both start dispatch 0 at sequence 1.
  for (const refs of groups) hydrateTransportEvidenceRefs(db, refs)
  const refs = groups.flat()
  const reachable = [...new Set(refs.map(({ digest }) => digest))]
  const result =
    reachable.length === 0 ?
      db.prepare("DELETE FROM v3_transport_evidence").run()
    : db.prepare(`DELETE FROM v3_transport_evidence WHERE digest NOT IN (${reachable.map(() => "?").join(",")})`).run(...reachable)
  return result.changes
}

export function hydrateManifest(db: Database, manifestBlob: Uint8Array, expectedOperationId: string): ModelOperationRecord {
  const manifest = decodeManifestEnvelope(manifestBlob)
  assertManifestOperationIdentity(manifest, expectedOperationId)
  validateStoredOperationDigest(db, manifestBlob, manifest, expectedOperationId)
  // Every format version, not just v3. The decoder normalizes v1/v2 envelopes to
  // an empty ref set, so the contract is empty↔empty and this call needs no
  // version branch. Gating it on v3 left full hydrate — detail, list, summary
  // fallback, strict repair, backfill, search — blind to stray normalized rows
  // that the adjacent evidence-hydrate and GC paths already reject, so the same
  // operation could be published as ready by one consumer and refused by another.
  //
  // The table probe covers pre-schema-6 databases, which have nothing to
  // reconcile against (see hasOperationEvidenceRefsTable). It must never gate a
  // v3 manifest: a v3 envelope can carry a non-empty ref set, so skipping it
  // because the table is missing would fail OPEN on exactly the input the check
  // exists for. Version first, table probe only as the legacy allowance.
  if (manifest.formatVersion === 3 || hasOperationEvidenceRefsTable(db)) validatePersistedOperationEvidenceRefs(db, manifest, expectedOperationId)
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
  let record = withDispatchAlias({
    ...manifest.record,
    arena: {
      payloads: manifest.record.arena.payloads.map((node) => ({
        ...node,
        value: valueFor(node.handle, "payload"),
      })) as ModelOperationRecord["arena"]["payloads"],
      frames: manifest.record.arena.frames.map((node) => ({ ...node, value: valueFor(node.handle, "frame") })) as ModelOperationRecord["arena"]["frames"],
    },
  } as ModelOperationRecord)
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
    record = withDispatchAlias({
      ...record,
      candidates: candidatesOf(record),
      ingress: record.ingress === null ? null : { ...record.ingress, request: track("client-ingress", -1) ?? { frames: [] } },
      dispatches: dispatchesOf(record).map((dispatch, index) => ({
        ...dispatch,
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
    })
  }
  return record
}

interface JournalV2Payload {
  journalFormatVersion: 2
  record: ModelOperationRecord
  transportEvidenceRefs: Array<TransportEvidenceRef>
}

function decodeJournalPayload(
  formatVersion: number,
  payload: Uint8Array,
  expectedOperationId: string,
): { record: ModelOperationRecord; refs: Array<TransportEvidenceRef> } {
  const decoded = JSON.parse(decoder.decode(decompressBytes(payload))) as unknown
  if (formatVersion === 1) {
    const record = decoded as ModelOperationRecord
    assertRecordOperationIdentity(record, expectedOperationId, "journal")
    return { record, refs: [] }
  }
  if (formatVersion !== JOURNAL_FORMAT_VERSION) throw new Error(`[history/v3] unsupported journal format version: ${formatVersion}`)
  const journal = decoded as Partial<JournalV2Payload>
  if (journal.journalFormatVersion !== JOURNAL_FORMAT_VERSION || !journal.record || !Array.isArray(journal.transportEvidenceRefs)) {
    throw new Error("[history/v3] invalid journal-v2 payload")
  }
  assertRecordOperationIdentity(journal.record, expectedOperationId, "journal")
  return { record: journal.record, refs: journal.transportEvidenceRefs }
}

function journalRefs(db: Database, operationId: string, revision: number): Array<TransportEvidenceRef> {
  return (
    db
      .prepare(
        "SELECT dispatch_index,sequence,digest,byte_length,encoding FROM v3_journal_evidence_refs WHERE operation_id=? AND revision=? ORDER BY dispatch_index,sequence",
      )
      .all(operationId, revision) as Array<PersistedEvidenceRefRow>
  ).map((row) => persistedEvidenceRef(row, "journal"))
}

function refsEqual(left: ReadonlyArray<TransportEvidenceRef>, right: ReadonlyArray<TransportEvidenceRef>): boolean {
  return (
    left.length === right.length
    && left.every((ref, index) => {
      const other = right[index]
      return ref.dispatchIndex === other.dispatchIndex && ref.sequence === other.sequence && ref.digest === other.digest && ref.byteLength === other.byteLength
    })
  )
}

/** Resume terminal journal rows that were appended but never committed. */
export function recoverV3Journal(db: Database = getDatabase()): number {
  ensureV3Schema(db)
  const rows = db
    .prepare("SELECT operation_id,revision,digest,payload_gz,created_at,format_version FROM v3_journal WHERE committed_at IS NULL ORDER BY created_at")
    .all() as Array<{
    operation_id: string
    revision: number
    digest: string
    payload_gz: Uint8Array
    created_at: number
    format_version: number
  }>
  let recovered = 0
  for (const row of rows) {
    try {
      const { record: recoveredRecord, refs } = decodeJournalPayload(row.format_version, row.payload_gz, row.operation_id)
      const persistedRefs = journalRefs(db, row.operation_id, row.revision)
      if (!refsEqual(refs, persistedRefs)) throw new Error("journal evidence refs mismatch")
      const timingOverride =
        recoveredRecord.terminal?.occurredAt === undefined ? { endedAt: row.created_at, source: "storage-commit-upper-bound" as const } : undefined
      const evidence = hydrateTransportEvidenceRefs(db, refs)
      const prepared = prepareModelOperationWithTransportEvidence(recoveredRecord, evidence, timingOverride)
      // Adjacent defence to the decode-time identity binding: the committed row is
      // keyed by the prepared operation's own id, so a prepare path that ever
      // rewrote identity would publish under a key the journal row does not own.
      // Deliberately without a positive control: with the decode-time assertion in
      // place, no input can reach here with a mismatched id, so the only way to
      // turn this line red would be to mutate the prepare path itself. Kept as
      // defence in depth, not as a criterion — do not read its permanent green as
      // evidence that identity binding works (the decode assertion's control is
      // the GC case, which has no second line of defence).
      if (prepared.id !== row.operation_id) throw new Error("journal operation identity mismatch")
      if (prepared.revision !== row.revision) throw new Error("journal revision mismatch")
      if (row.format_version === 1) {
        const v1Matches = legacyManifestV1Digest(recoveredRecord) === row.digest
        const v2Matches = legacyManifestV2Digest(recoveredRecord) === row.digest
        if (v1Matches === v2Matches) throw new Error(v1Matches ? "journal legacy digest collision" : "journal digest mismatch")
      } else if (prepared.digest !== row.digest) {
        throw new Error("journal digest mismatch")
      }
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
  // Keep the in-flight promise reachable so teardown can still drain it. Dropping
  // the handle here lets an old backfill continue against a later test's reopened
  // singleton database while every lifecycle check falsely reports no work.
  summaryBackfillStop = true
  commitFailureInjectorForTests = null
  transactionBFailureInjectorForTests = null
  status = {
    pendingOperations: 0,
    pendingBytes: 0,
    persistedOperations: 0,
    failedOperations: 0,
    conflicts: 0,
    summaryBacklog: 0,
    summaryProjectionReady: false,
    summaryProjectionPending: 0,
    summaryProjectionPoisoned: 0,
  }
}
