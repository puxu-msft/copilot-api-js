import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { SqliteDatabase } from "~/lib/history/sqlite/driver"

import { compressBytes, decompressBytes } from "~/lib/history/sqlite/compression"
import { createDatabase } from "~/lib/history/sqlite/driver"

const RAW_SCHEMA_VERSION = 1

export interface RawCaptureConfig {
  enabled: boolean
  dbPath: string
  maxObjectBytes: number
}

export interface RawCaptureRef {
  storeId: string
  objectHash: string
  byteLength: number
  capability: "available"
}

export interface RawCaptureGap {
  storeId?: string
  capability: "unavailable" | "not-requested"
  status: "disabled" | "failed" | "too-large" | "released"
  error?: string
}

export type RawCaptureResult = RawCaptureRef | RawCaptureGap

export interface RawCaptureLease {
  readonly storeId?: string
  readonly requested: boolean
  putObject(bytes: Uint8Array, kind: string): RawCaptureResult
  appendRef(operationId: string, sequence: number, track: string, result: RawCaptureResult): void
  release(): void
}

export interface RawCaptureStatus {
  enabled: boolean
  activeStoreId?: string
  generations: number
  leasedOperations: number
  capturedObjects: number
  captureGaps: number
  lastError?: string
}

interface Generation {
  id: string
  config: Readonly<RawCaptureConfig>
  db: SqliteDatabase
  leases: number
  retiring: boolean
}

const generations = new Map<string, Generation>()
let active: Generation | undefined
let config: Readonly<RawCaptureConfig> = Object.freeze({ enabled: false, dbPath: "", maxObjectBytes: 16 * 1024 * 1024 })
let capturedObjects = 0
let captureGaps = 0
let lastError: string | undefined

const RAW_SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_store_identity (
  store_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  codec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_objects (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  blob_gz BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_refs (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  track TEXT NOT NULL,
  object_hash TEXT,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY(operation_id, sequence, track)
);
`

function rawHash(kind: string, bytes: Uint8Array): string {
  return createHash("sha256").update(`history-raw:${RAW_SCHEMA_VERSION}:${kind}\0`).update(bytes).digest("hex")
}

function openGeneration(next: RawCaptureConfig): Generation {
  if (!next.dbPath || next.dbPath === ":memory:") {
    if (next.dbPath !== ":memory:") throw new Error("[history/raw] db_path must not be empty when enabled")
  } else {
    fs.mkdirSync(path.dirname(next.dbPath), { recursive: true })
  }
  const existed = next.dbPath !== ":memory:" && fs.existsSync(next.dbPath)
  const db = createDatabase(next.dbPath)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")
  if (existed) {
    const identityExists = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='raw_store_identity'").get()
    if (!identityExists) {
      db.close()
      throw new Error(`[history/raw] refusing unowned existing database: ${next.dbPath}`)
    }
  }
  db.exec(RAW_SCHEMA)
  const identity = db.prepare("SELECT store_id,schema_version,codec FROM raw_store_identity LIMIT 1").get() as
    | { store_id: string; schema_version: number; codec: string }
    | undefined
  const id = identity?.store_id ?? randomUUID()
  if (identity && (identity.schema_version !== RAW_SCHEMA_VERSION || identity.codec !== "zstd-json-v1")) {
    db.close()
    throw new Error(`[history/raw] incompatible store artifact: ${next.dbPath}`)
  }
  if (!identity) db.prepare("INSERT INTO raw_store_identity(store_id,schema_version,codec) VALUES(?,?,?)").run(id, RAW_SCHEMA_VERSION, "zstd-json-v1")
  return { id, config: Object.freeze({ ...next }), db, leases: 0, retiring: false }
}

function closeRetired(): void {
  for (const [id, generation] of generations) {
    if (generation.retiring && generation.leases === 0) {
      generation.db.close()
      generations.delete(id)
    }
  }
}

/** Open/validate a new artifact before atomically switching future operations. */
export function configureRawCapture(next: RawCaptureConfig): boolean {
  const frozen = Object.freeze({ ...next })
  if (!frozen.enabled) {
    config = frozen
    if (active) active.retiring = true
    active = undefined
    closeRetired()
    return true
  }
  try {
    const generation = openGeneration(frozen)
    const previous = active
    active = generation
    generations.set(generation.id, generation)
    config = frozen
    if (previous && previous !== generation) previous.retiring = true
    closeRetired()
    lastError = undefined
    return true
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    captureGaps++
    return false
  }
}

/** Freeze capture policy and artifact generation at operation creation. */
export function acquireRawCaptureLease(): RawCaptureLease {
  const generation = config.enabled ? active : undefined
  if (generation) generation.leases++
  let released = false

  const disabledGap = (): RawCaptureGap => ({ capability: "not-requested", status: "disabled" })
  return Object.freeze({
    storeId: generation?.id,
    requested: generation !== undefined,
    putObject(bytes: Uint8Array, kind: string): RawCaptureResult {
      if (released) return { storeId: generation?.id, capability: "unavailable", status: "released" }
      if (!generation) return disabledGap()
      if (bytes.byteLength > generation.config.maxObjectBytes) {
        captureGaps++
        return { storeId: generation.id, capability: "unavailable", status: "too-large", error: `object exceeds ${generation.config.maxObjectBytes} bytes` }
      }
      try {
        const hash = rawHash(kind, bytes)
        const existing = generation.db.prepare("SELECT blob_gz FROM raw_objects WHERE hash=?").get(hash) as { blob_gz: Uint8Array } | undefined
        if (existing) {
          const prior = decompressBytes(existing.blob_gz)
          if (!Buffer.from(prior).equals(Buffer.from(bytes))) throw new Error(`raw object hash collision: ${hash}`)
        } else {
          generation.db.prepare("INSERT INTO raw_objects(hash,kind,byte_length,blob_gz) VALUES(?,?,?,?)").run(hash, kind, bytes.byteLength, compressBytes(bytes))
          capturedObjects++
        }
        return { storeId: generation.id, objectHash: hash, byteLength: bytes.byteLength, capability: "available" }
      } catch (error) {
        captureGaps++
        lastError = error instanceof Error ? error.message : String(error)
        return { storeId: generation.id, capability: "unavailable", status: "failed", error: lastError }
      }
    },
    appendRef(operationId: string, sequence: number, track: string, result: RawCaptureResult): void {
      if (!generation || released) return
      try {
        generation.db
          .prepare("INSERT OR REPLACE INTO raw_refs(operation_id,sequence,track,object_hash,capability,status,error) VALUES(?,?,?,?,?,?,?)")
          .run(
            operationId,
            sequence,
            track,
            "objectHash" in result ? result.objectHash : null,
            result.capability,
            "status" in result ? result.status : "captured",
            "error" in result ? result.error ?? null : null,
          )
      } catch (error) {
        captureGaps++
        lastError = error instanceof Error ? error.message : String(error)
      }
    },
    release(): void {
      if (released) return
      released = true
      if (generation) generation.leases--
      closeRetired()
    },
  })
}

export function getRawCaptureStatus(): RawCaptureStatus {
  return {
    enabled: config.enabled,
    ...(active ? { activeStoreId: active.id } : {}),
    generations: generations.size,
    leasedOperations: [...generations.values()].reduce((sum, generation) => sum + generation.leases, 0),
    capturedObjects,
    captureGaps,
    ...(lastError ? { lastError } : {}),
  }
}

export function shutdownRawCapture(): void {
  active = undefined
  for (const generation of generations.values()) generation.retiring = true
  closeRetired()
}

export function resetRawCaptureManagerForTests(): void {
  for (const generation of generations.values()) generation.db.close()
  generations.clear()
  active = undefined
  config = Object.freeze({ enabled: false, dbPath: "", maxObjectBytes: 16 * 1024 * 1024 })
  capturedObjects = 0
  captureGaps = 0
  lastError = undefined
}
