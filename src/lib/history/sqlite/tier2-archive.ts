import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from "node:zlib"
import fs from "node:fs"
import path from "node:path"

import type { HistoryEntry } from "~/lib/history/types"

import { createDatabase } from "./driver"

/**
 * TIER-2 sealed-unit format (spec §3.2, Phase 0 verdict: SQLite sealed +
 * session-group — exp/tiered-archive-format/FINDINGS.md, 9× vs per-entry).
 *
 * A seal unit is a numbered, immutable SQLite file `archive-NNNN.db` holding a
 * single table `sealed_chunk(chunk_key, blob)`. Each `blob` is a max-zstd
 * compression of ONE session-chunk's assembled entries as a JSON array —
 * grouping a session's requests into one compression window collapses the huge
 * cross-request redundancy (each request re-sends the growing conversation).
 *
 * Large sessions are bounded: a session is split into chunks of
 * `SEAL_CHUNK_SIZE` entries so a single-entry read never has to decompress an
 * unbounded blob. The tier2_manifest stores `(seal_file, session_id,
 * index_in_session)`; the chunk is DERIVED from `index_in_session` at read time,
 * so the manifest schema stays chunk-agnostic.
 */

/** Max entries per session-chunk (bounds single-read decompress cost). */
export const SEAL_CHUNK_SIZE = 100

/** Max-level zstd for cold seal units (Phase 0: L19 ≈ half of L3). */
const SEAL_ZSTD = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } } as const

const chunkKey = (sessionId: string, chunkIndex: number) => `${sessionId}#${chunkIndex}`

export interface SealedLocator {
  entryId: string
  sessionId: string
  indexInSession: number
}

/**
 * Write one session's assembled entries into the seal file at `sealPath` (created
 * if absent). Splits into `SEAL_CHUNK_SIZE` chunks, each a single max-zstd blob.
 * Returns the per-entry locators for the manifest. `entries` MUST already be the
 * fully-assembled HistoryEntry objects (caller assembles from archive.db).
 */
export function writeSealUnit(sealPath: string, sessionId: string, entries: ReadonlyArray<HistoryEntry>): Array<SealedLocator> {
  const db = createDatabase(sealPath)
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;")
    db.exec("CREATE TABLE IF NOT EXISTS sealed_chunk (chunk_key TEXT PRIMARY KEY, blob BLOB NOT NULL)")
    const ins = db.prepare("INSERT OR REPLACE INTO sealed_chunk (chunk_key, blob) VALUES (?, ?)")
    const locators: Array<SealedLocator> = []
    const tx = db.transaction(() => {
      for (let start = 0; start < entries.length; start += SEAL_CHUNK_SIZE) {
        const chunkIndex = Math.floor(start / SEAL_CHUNK_SIZE)
        const chunk = entries.slice(start, start + SEAL_CHUNK_SIZE)
        const blob = zstdCompressSync(Buffer.from(JSON.stringify(chunk)), SEAL_ZSTD)
        ins.run(chunkKey(sessionId, chunkIndex), new Uint8Array(blob))
        chunk.forEach((e, i) => locators.push({ entryId: e.id, sessionId, indexInSession: start + i }))
      }
    })
    tx()
    return locators
  } finally {
    db.close()
  }
}

/**
 * Read ONE entry back from a sealed unit: derive the chunk from `indexInSession`,
 * decompress that chunk's blob, and return the entry at its offset. Opens the
 * seal file read-only (immutable cold data). Returns undefined if absent.
 */
export function readSealedEntry(sealPath: string, sessionId: string, indexInSession: number): HistoryEntry | undefined {
  if (!fs.existsSync(sealPath)) return undefined
  const db = createDatabase(sealPath)
  try {
    const chunkIndex = Math.floor(indexInSession / SEAL_CHUNK_SIZE)
    const offset = indexInSession % SEAL_CHUNK_SIZE
    const row = db.prepare("SELECT blob FROM sealed_chunk WHERE chunk_key = ?").get(chunkKey(sessionId, chunkIndex)) as { blob: Uint8Array } | undefined
    if (!row) return undefined
    const arr = JSON.parse(zstdDecompressSync(Buffer.from(row.blob)).toString("utf8")) as Array<HistoryEntry>
    return arr[offset]
  } finally {
    db.close()
  }
}

/** Next free seal-unit file name in `dir`, zero-padded (archive-0001.db, …). */
export function nextSealFileName(dir: string): string {
  let n = 1
  const existing = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
  while (existing.has(`archive-${String(n).padStart(4, "0")}.db`)) n++
  return `archive-${String(n).padStart(4, "0")}.db`
}

/** Total bytes of all seal-unit files in `dir` (for the tier2_warn_bytes threshold). */
export function totalSealedBytes(dir: string): { count: number; bytes: number } {
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0 }
  const files = fs.readdirSync(dir).filter((f) => /^archive-\d{4}\.db$/.test(f))
  let bytes = 0
  for (const f of files) bytes += fs.statSync(path.join(dir, f)).size
  return { count: files.length, bytes }
}
