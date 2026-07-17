import { createHash } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import {
  //
  createZstdCompress,
  zstdDecompressSync,
  constants as zlibConstants,
} from "node:zlib"

import type { HistoryEntry } from "~/lib/history/types"

import { createDatabase } from "./driver"

/**
 * TIER-2 sealed-unit format v2 (columnar, whole-session, zstd + long-distance
 * matching). Supersedes the v1 "100-entry JSON chunk" layout that caused the 3×
 * archive bloat (35 GB HOT → 100 GB archive): v1 re-inflated the content-addressed
 * store into full JSON, then split each session into fixed 100-entry chunks each
 * zstd'd with the DEFAULT ~8 MB window. A single assembled entry is ~2.88 MB
 * (Claude Code re-sends the whole growing conversation, with clientRequest +
 * effectiveSource + upstream_request each carrying a full copy), so a 100-entry
 * chunk is ~288 MB — the 8 MB window could only see ~3 adjacent entries and the
 * cross-request redundancy (identical prompts / same-shaped frames tens of entries
 * apart) never folded. The content-addressed source (global, exact dedup) was
 * therefore SMALLER than its own tier-2 seal.
 *
 * v2 fixes the root cause and honours the storage rules (never store msg_blob
 * verbatim; split content into columns; one SQLite file per session; a session's
 * requests are NEVER split):
 *
 *   1. ONE immutable seal file per claimed WHOLE-session generation (the T1 rows
 *      present for that session in this pass are atomic — never chunked). A
 *      session that receives later requests gets another immutable generation.
 *      PoC FINDINGS §2: whole-session single
 *      stream = 9× vs per-entry, because the cross-request redundancy lives INSIDE
 *      a session.
 *   2. COLUMNAR by top-level key ("按内容拆分成列"): the assembled entries are
 *      TRANSPOSED — all entries' `raw` payloads land in one column, all `model`s
 *      in another, etc. Same-kind content sits contiguously so the codec sees the
 *      redundancy back-to-back. Columns are stored SPARSE (idx + vals) so an entry
 *      that omits a key round-trips to omitted (exactly JSON.parse(JSON.stringify)).
 *   3. zstd L19 + LONG-DISTANCE MATCHING with a large window (`windowLog`), so the
 *      whole column (the whole session's same-kind content) is inside one matching
 *      window and cross-request duplicates fold to near-zero — recovering the PoC
 *      compression WITHOUT the content-addressed table.
 *
 * MEMORY: a column is compressed by STREAMING one NDJSON line per value through a
 * single zstd stream — the whole column's uncompressed bytes are NEVER held as one
 * string/Buffer (a big session's `raw` column exceeds V8's ~512 MB max string and
 * OOMs a one-shot `JSON.stringify`). Columns within a session compress SEQUENTIALLY
 * (one zstd context at a time); cross-session parallelism comes from the seal
 * orchestrator. Reads stay SYNChronous (queries.ts resolves inline): decompress the
 * needed column to a Buffer and stringify ONLY the target line (bounded), so a huge
 * session never re-materialises as one giant string on read either.
 */

/** Seal format tag persisted in `sealed_meta` (bump on any breaking layout change). */
export const SEAL_FORMAT = 2

/**
 * zstd compression window. 24 → 16 MB matching window (plus long-distance matching,
 * which reaches beyond the window via a hash table). Whole-session STREAMING means
 * the window SLIDES across the entire session, so consecutive-request redundancy
 * folds continuously regardless of window size — the window only bounds how far
 * apart two identical blocks may sit and still match directly. 16 MB (~5 adjacent
 * ~2.88 MB requests) + LDM balances ratio against per-context memory (≈tens of MB ×
 * the seal fan-out). Persisted in `sealed_meta` so a future change stays back-readable.
 */
const SEAL_WINDOW_LOG = 24

const C = zlibConstants

/** Compression params: max-practical level + long-distance matching + a slid window. */
const COMPRESS_PARAMS = {
  params: {
    [C.ZSTD_c_compressionLevel]: 19,
    [C.ZSTD_c_enableLongDistanceMatching]: 1,
    [C.ZSTD_c_windowLog]: SEAL_WINDOW_LOG,
  },
} as const

/** Decompression must permit a window at least as large as the one used to compress. */
const DECOMPRESS_PARAMS = { params: { [C.ZSTD_d_windowLogMax]: 31 } } as const

/**
 * Compress one column's values as an NDJSON stream (one `JSON.stringify(value)\n`
 * per value) through a single zstd stream. Never builds the whole-column string:
 * a generator yields one bounded per-value line at a time and `.pipe` applies
 * backpressure, so peak memory is one value + the zstd context + the (small)
 * compressed output. Returns the compressed blob.
 */
async function compressColumnVals(vals: ReadonlyArray<unknown>): Promise<Buffer> {
  const z = createZstdCompress(COMPRESS_PARAMS)
  const chunks: Array<Buffer> = []
  z.on("data", (c: Buffer) => chunks.push(c))
  const ended = once(z, "end")
  Readable.from(
    (function* () {
      for (const v of vals) yield `${JSON.stringify(v)}\n`
    })(),
  ).pipe(z)
  await ended
  return Buffer.concat(chunks)
}

/** Parse the NDJSON line at 0-based `target` from a decompressed column buffer,
 *  stringifying ONLY that line's slice (bounded — never the whole column). Returns
 *  the sentinel `MISSING` when the line index is out of range. */
const MISSING = Symbol("missing")
function ndjsonLine(buf: Buffer, target: number): unknown {
  let start = 0
  let line = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (line === target) return JSON.parse(buf.toString("utf8", start, i))
      line++
      start = i + 1
    }
  }
  return MISSING
}

/** A sparse column: `vals[k]` is the leaf value at path `key` for entry index
 *  `idx[k]`. `key` is `JSON.stringify(pathArray)` — robust to keys containing dots. */
interface SealedColumn {
  key: string
  idx: Array<number>
  vals: Array<unknown>
}

interface SealedMeta {
  format: number
  count: number
  windowLog: number
  /** Column keys = JSON.stringify(pathArray) for every leaf path in the session. */
  columns: Array<string>
  entryIds: Array<string>
}

export interface SealedLocator {
  entryId: string
  /** 0-based position of this entry within its session's seal unit. */
  indexInSession: number
}

/** Max recursion depth when hunting for must-extract heavy fields (defensive cap). */
const MAX_FLATTEN_DEPTH = 8

/**
 * Heavy, high-redundancy fields that MUST get their own column wherever they are
 * nested — their same-kind content across the session folds best when isolated in
 * one LDM stream (user requirement: "messages, sse_events 是必须拆的"). Index
 * scalars need no special-casing: they are top-level fields (their own top-level
 * columns here) AND are already stored as real, queryable columns in tier2_manifest.
 */
const EXTRACT_KEYS = new Set<string>(["messages", "sse_events", "sseEvents"])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Pull every must-extract heavy field out of `node` (at any depth) into `out` as
 * `(path, value)` leaves, returning `node` with those fields REMOVED. Only clones
 * objects along paths that actually lose a field (untouched subtrees are shared by
 * reference — cheap). The removed fields are re-overlaid onto the container at read
 * time (parent column applied before its deeper extracted children).
 */
function deepExtract(node: unknown, path: Array<string>, depth: number, out: Array<{ path: Array<string>; value: unknown }>): unknown {
  if (depth >= MAX_FLATTEN_DEPTH || !isPlainObject(node)) return node
  let changed = false
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(node)) {
    const child = node[key]
    if (child === undefined) continue
    const childPath = [...path, key]
    if (EXTRACT_KEYS.has(key)) {
      out.push({ path: childPath, value: child }) // hoist heavy field → its own column (omit from remainder)
      changed = true
      continue
    }
    if (isPlainObject(child)) {
      const sub = deepExtract(child, childPath, depth + 1, out)
      if (sub !== child) changed = true
      result[key] = sub
    } else {
      result[key] = child
    }
  }
  return changed ? result : node
}

/**
 * Split one entry into columns: each TOP-LEVEL key is its own column (user choice
 * B), PLUS any nested `messages`/`sse_events` are hoisted OUT of their container
 * into dedicated columns. The container's column then holds the remainder (minus
 * the hoisted heavy fields), which the read path re-merges. Paths are key arrays
 * (robust to keys containing dots).
 */
function flattenEntry(entry: HistoryEntry): Array<{ path: Array<string>; value: unknown }> {
  const leaves: Array<{ path: Array<string>; value: unknown }> = []
  const obj = entry as unknown as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const v = obj[key]
    if (v === undefined) continue
    if (EXTRACT_KEYS.has(key)) {
      leaves.push({ path: [key], value: v }) // heavy field already at top level
    } else if (isPlainObject(v)) {
      const remainder = deepExtract(v, [key], 1, leaves)
      leaves.push({ path: [key], value: remainder })
    } else {
      leaves.push({ path: [key], value: v }) // top-level scalar / array
    }
  }
  return leaves
}

/** Set `value` at `path` inside `root`, creating intermediate plain objects. */
function setPath(root: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void {
  if (path.length === 0) return
  let node = root
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (!isPlainObject(node[k])) node[k] = {}
    node = node[k] as Record<string, unknown>
  }
  node[path.at(-1) as string] = value
}

/** Transpose the session's entries into sparse leaf columns keyed by JSON path.
 *  Columns are ordered SHORTEST-PATH-FIRST so the read path applies a container
 *  before its deeper extracted children (parent value never clobbers a child). */
function buildColumns(entries: ReadonlyArray<HistoryEntry>): Array<SealedColumn> {
  const order: Array<string> = []
  const depthOf = new Map<string, number>()
  const cols = new Map<string, { idx: Array<number>; vals: Array<unknown> }>()
  for (const [i, e] of entries.entries()) {
    for (const { path, value } of flattenEntry(e)) {
      const key = JSON.stringify(path)
      let col = cols.get(key)
      if (!col) {
        col = { idx: [], vals: [] }
        cols.set(key, col)
        order.push(key)
        depthOf.set(key, path.length)
      }
      col.idx.push(i)
      col.vals.push(value)
    }
  }
  order.sort((a, b) => (depthOf.get(a) as number) - (depthOf.get(b) as number))
  return order.map((key) => ({ key, ...(cols.get(key) as { idx: Array<number>; vals: Array<unknown> }) }))
}

/**
 * Write ONE whole session's assembled entries into the seal file at `sealPath`
 * (columnar + streamed zstd-LDM). `entries` MUST be the session's fully-assembled
 * HistoryEntry objects in stable order; the returned locators carry each entry's
 * index for the manifest. Columns compress SEQUENTIALLY (one zstd context at a
 * time — bounded memory even for a multi-GB session); cross-session parallelism is
 * the orchestrator's job. Each column stores its small sparse `idx` array plus the
 * streamed NDJSON `blob` of its values.
 */
export async function writeSealUnit(sealPath: string, entries: ReadonlyArray<HistoryEntry>): Promise<Array<SealedLocator>> {
  const columns = buildColumns(entries)
  const compressed: Array<{ key: string; idx: Buffer; blob: Buffer }> = []
  for (const col of columns) {
    compressed.push({ key: col.key, idx: Buffer.from(JSON.stringify(col.idx)), blob: await compressColumnVals(col.vals) })
  }
  const meta: SealedMeta = {
    format: SEAL_FORMAT,
    count: entries.length,
    windowLog: SEAL_WINDOW_LOG,
    columns: columns.map((c) => c.key),
    entryIds: entries.map((e) => e.id),
  }

  const db = createDatabase(sealPath)
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;")
    db.exec("CREATE TABLE IF NOT EXISTS sealed_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    db.exec("CREATE TABLE IF NOT EXISTS sealed_column (name TEXT PRIMARY KEY, idx BLOB NOT NULL, blob BLOB NOT NULL)")
    const insMeta = db.prepare("INSERT OR REPLACE INTO sealed_meta (k, v) VALUES ('meta', ?)")
    const insCol = db.prepare("INSERT OR REPLACE INTO sealed_column (name, idx, blob) VALUES (?, ?, ?)")
    const tx = db.transaction(() => {
      insMeta.run(JSON.stringify(meta))
      for (const c of compressed) insCol.run(c.key, new Uint8Array(c.idx), new Uint8Array(c.blob))
    })
    tx()
  } finally {
    db.close()
  }
  return entries.map((e, i) => ({ entryId: e.id, indexInSession: i }))
}

/** v1 (legacy) seal layout: a session split into 100-entry `sealed_chunk` rows,
 *  keyed `${sessionId}#${chunkIndex}`, each a default-window zstd of a JSON array.
 *  Kept ONLY for reading pre-upgrade seal units — never written again. */
const V1_CHUNK_SIZE = 100
const v1ChunkKey = (sessionId: string, chunkIndex: number) => `${sessionId}#${chunkIndex}`

/** Whether table `name` exists in the open seal db (format detection). */
function hasTable(db: ReturnType<typeof createDatabase>, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

/**
 * Read one entry from a seal unit at `indexInSession`. Auto-detects the format so
 * pre-upgrade v1 units stay readable after the columnar-v2 rollout ("允许从旧版
 * 重新组织"): v2 → `sealed_column` (columnar), v1 → `sealed_chunk` (needs
 * `sessionId` to derive the chunk key). One read decompresses only what it needs.
 */
export function readSealedEntry(sealPath: string, indexInSession: number, sessionId?: string): HistoryEntry | undefined {
  if (!fs.existsSync(sealPath)) return undefined
  const db = createDatabase(sealPath)
  try {
    if (hasTable(db, "sealed_column")) return readV2Entry(db, indexInSession)
    if (hasTable(db, "sealed_chunk")) return readV1Entry(db, indexInSession, sessionId)
    return undefined
  } finally {
    db.close()
  }
}

/** v2 columnar read: rebuild the entry at `indexInSession` from its sparse leaf columns. */
function readV2Entry(db: ReturnType<typeof createDatabase>, indexInSession: number): HistoryEntry | undefined {
  const metaRow = db.prepare("SELECT v FROM sealed_meta WHERE k = 'meta'").get() as { v: string } | undefined
  if (!metaRow) return undefined
  const meta = JSON.parse(metaRow.v) as SealedMeta
  if (indexInSession < 0 || indexInSession >= meta.count) return undefined
  const getCol = db.prepare("SELECT idx, blob FROM sealed_column WHERE name = ?")
  const out: Record<string, unknown> = {}
  for (const key of meta.columns) {
    const row = getCol.get(key) as { idx: Uint8Array; blob: Uint8Array } | undefined
    if (!row) continue
    const idx = JSON.parse(Buffer.from(row.idx).toString("utf8")) as Array<number>
    const pos = idx.indexOf(indexInSession)
    if (pos === -1) continue // this column has no leaf for this entry (sparse) → path stays absent
    // Decompress the column to a Buffer (not a giant string) and parse ONLY the target NDJSON line.
    const val = ndjsonLine(zstdDecompressSync(Buffer.from(row.blob), DECOMPRESS_PARAMS), pos)
    if (val !== MISSING) setPath(out, JSON.parse(key) as Array<string>, val)
  }
  return out as unknown as HistoryEntry
}

/** v1 legacy read: decode the 100-entry chunk holding `indexInSession`. */
function readV1Entry(db: ReturnType<typeof createDatabase>, indexInSession: number, sessionId?: string): HistoryEntry | undefined {
  if (sessionId === undefined) return undefined
  const chunkIndex = Math.floor(indexInSession / V1_CHUNK_SIZE)
  const offset = indexInSession % V1_CHUNK_SIZE
  const row = db.prepare("SELECT blob FROM sealed_chunk WHERE chunk_key = ?").get(v1ChunkKey(sessionId, chunkIndex)) as { blob: Uint8Array } | undefined
  if (!row) return undefined
  const arr = JSON.parse(zstdDecompressSync(Buffer.from(row.blob), DECOMPRESS_PARAMS).toString("utf8")) as Array<HistoryEntry>
  return arr[offset]
}

/**
 * Deterministic seal-file name for a session generation.
 * (tier "t2" = cold sealed, "t1" = warm per-session). The session id is sanitised
 * to a filesystem-safe token; if sanitising/truncating loses information a short
 * content hash is appended so distinct sessions never collide. Deterministic (not
 * sequential) means retrying the SAME unit identity reuses its orphan filename,
 * while later entries in the same session produce a distinct immutable file.
 */
export function sealFileNameForSession(sessionId: string, tier: "t1" | "t2" = "t2", unitIdentity?: string): string {
  const safe = sessionId.replaceAll(/[^\w.-]/g, "_").slice(0, 120)
  const lossy = safe !== sessionId || sessionId.length > 120
  const sessionHash = lossy ? `-${fnv1a(sessionId)}` : ""
  const unitHash = unitIdentity === undefined ? "" : `-g${createHash("sha256").update(unitIdentity).digest("hex").slice(0, 16)}`
  return `archive-${tier}-${safe}${sessionHash}${unitHash}.db`
}

/** FNV-1a 32-bit hex — a tiny stable disambiguator for lossy-sanitised session ids. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (const character of s) {
    h ^= character.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Publish a completed seal file durably before committing any SQLite locator.
 * The directory fsync makes the rename itself persistent across power loss on
 * POSIX filesystems; unsupported runtimes retain atomic-rename crash safety.
 */
export function publishSealFile(tmpPath: string, finalPath: string): number {
  const fd = fs.openSync(tmpPath, "r")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, finalPath)
  try {
    const dirFd = fs.openSync(path.dirname(finalPath), "r")
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // Some non-POSIX runtimes cannot open/fsync a directory. The file itself is
    // synced and rename remains atomic; only power-loss directory durability is
    // unavailable on those platforms.
  }
  return fs.statSync(finalPath).size
}

/** Match a tier-2 seal file: the new `archive-t2-*.db` naming AND the legacy
 *  `archive-NNNN.db` sequential naming (a machine mid-upgrade may hold both). */
const SEAL_FILE_RE = /^(?:archive-t2-.+|archive-\d{4})\.db$/

/** Total bytes of all seal-unit files in `dir` (for the tier2_warn_bytes threshold). */
export function totalSealedBytes(dir: string): { count: number; bytes: number } {
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0 }
  const files = fs.readdirSync(dir).filter((f) => SEAL_FILE_RE.test(f))
  let bytes = 0
  for (const f of files) bytes += fs.statSync(path.join(dir, f)).size
  return { count: files.length, bytes }
}
