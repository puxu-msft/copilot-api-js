/**
 * Phase 0 PoC — tier-2 archive format decision: SQLite sealed (candidate B) vs
 * Parquet (candidate A). Measures on REAL history entries pulled from the 4141
 * History API (samples.json). Decides which tier-2 container to build in P6.
 *
 * Run: bun run exp/tiered-archive-format/probe.ts
 */
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import { parquetWriteBuffer } from "hyparquet-writer"
import { parquetReadObjects } from "hyparquet"

const MAX = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } } as const // max-zstd for sealed
const L3 = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } } as const // current storage level

const zc = (buf: Buffer | Uint8Array, opts: object) => zstdCompressSync(buf, opts)
const mb = (n: number) => (n / 1048576).toFixed(2)

type Entry = Record<string, unknown> & { id: string; sessionId?: string; model?: string; endpoint?: string; state?: string; startedAt?: number }

const samples: Array<Entry> = JSON.parse(fs.readFileSync("exp/tiered-archive-format/samples.json", "utf8"))
console.log(`\n=== samples: ${samples.length} real entries ===`)

// Baseline: raw JSON + per-entry zstd payload (the irreducible floor, shared by both candidates)
let rawTotal = 0
const payloadsL3: Array<Uint8Array> = []
const payloadsMax: Array<Uint8Array> = []
for (const e of samples) {
  const json = Buffer.from(JSON.stringify(e))
  rawTotal += json.length
  payloadsL3.push(zc(json, L3))
  payloadsMax.push(zc(json, MAX))
}
const floorL3 = payloadsL3.reduce((a, b) => a + b.length, 0)
const floorMax = payloadsMax.reduce((a, b) => a + b.length, 0)
console.log(`raw JSON:            ${mb(rawTotal)} MB`)
console.log(`zstd L3 payload sum: ${mb(floorL3)} MB  (${((1 - floorL3 / rawTotal) * 100).toFixed(1)}% reduction, current storage level)`)
console.log(`zstd L19 payload sum:${mb(floorMax)} MB  (${((1 - floorMax / rawTotal) * 100).toFixed(1)}% reduction, sealed max level)`)

// meta columns mirrored into both candidates (subset representative of entries_v2 meta)
const metaCols = ["id", "sessionId", "model", "endpoint", "state", "startedAt"] as const
const metaOf = (e: Entry) => ({
  id: String(e.id),
  sessionId: e.sessionId == null ? null : String(e.sessionId),
  model: e.model == null ? null : String(e.model),
  endpoint: e.endpoint == null ? null : String(e.endpoint),
  state: e.state == null ? null : String(e.state),
  startedAt: e.startedAt == null ? null : Number(e.startedAt),
})

// ---------------- Candidate B: SQLite sealed (VACUUM + max-zstd full_gz BLOB) ----------------
const bPath = "exp/tiered-archive-format/sealed-B.db"
fs.rmSync(bPath, { force: true })
const bStart = performance.now()
const bdb = new Database(bPath)
bdb.exec("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=NONE;")
bdb.exec(`CREATE TABLE sealed (id TEXT PRIMARY KEY, session_id TEXT, model TEXT, endpoint TEXT, state TEXT, started_at INTEGER, full_gz BLOB NOT NULL)`)
const bins = bdb.prepare(`INSERT INTO sealed VALUES (?,?,?,?,?,?,?)`)
const btx = bdb.transaction(() => {
  for (let i = 0; i < samples.length; i++) {
    const m = metaOf(samples[i])
    bins.run(m.id, m.sessionId, m.model, m.endpoint, m.state, m.startedAt, new Uint8Array(payloadsMax[i]))
  }
})
btx()
bdb.exec("VACUUM;")
bdb.close()
const bWriteMs = performance.now() - bStart
const bBytes = fs.statSync(bPath).size

// single-entry read latency (B): SELECT by id + zstd decompress + JSON.parse
const bdb2 = new Database(bPath, { readonly: true })
const bsel = bdb2.prepare(`SELECT full_gz FROM sealed WHERE id = ?`)
const readIds = samples.map((e) => e.id).sort(() => Math.random() - 0.5).slice(0, 50)
let bReadTotal = 0
let bRoundtripOk = 0
for (const id of readIds) {
  const t = performance.now()
  const row = bsel.get(id) as { full_gz: Uint8Array }
  const back = JSON.parse(zstdDecompressSync(row.full_gz).toString("utf8"))
  bReadTotal += performance.now() - t
  if (back.id === id) bRoundtripOk++
}
bdb2.close()
const bReadMs = bReadTotal / readIds.length

// ---------------- Candidate A: Parquet (meta cols + full_gz BYTE_ARRAY, our zstd) ----------------
const aPath = "exp/tiered-archive-format/sealed-A.parquet"
fs.rmSync(aPath, { force: true })
const aStart = performance.now()
const columnData = [
  { name: "id", data: samples.map((e) => String(e.id)), type: "STRING" as const },
  { name: "session_id", data: samples.map((e) => (e.sessionId == null ? null : String(e.sessionId))), type: "STRING" as const },
  { name: "model", data: samples.map((e) => (e.model == null ? null : String(e.model))), type: "STRING" as const },
  { name: "endpoint", data: samples.map((e) => (e.endpoint == null ? null : String(e.endpoint))), type: "STRING" as const },
  { name: "state", data: samples.map((e) => (e.state == null ? null : String(e.state))), type: "STRING" as const },
  { name: "started_at", data: samples.map((e) => (e.startedAt == null ? null : BigInt(Math.trunc(Number(e.startedAt))))), type: "INT64" as const },
  { name: "full_gz", data: payloadsMax.map((b) => new Uint8Array(b)) as Array<Uint8Array>, type: "BYTE_ARRAY" as const },
]
const abuf = parquetWriteBuffer({ columnData })
fs.writeFileSync(aPath, Buffer.from(abuf))
const aWriteMs = performance.now() - aStart
const aBytes = fs.statSync(aPath).size

// single-entry read latency (A): hyparquet read the row for a given id + decompress.
// Two hyparquet gotchas found in Phase 0 (§6.3):
//   1. must slice the ArrayBuffer to the file's exact bytes (Buffer over a POOLED
//      ArrayBuffer → `.buffer` includes neighbors → wrong bytes).
//   2. must pass `utf8: false` or hyparquet decodes plain BYTE_ARRAY as a UTF-8
//      string (corrupts binary: 0xb5 → U+FFFD).
const aFileBuf = fs.readFileSync(aPath)
const aArrayBuffer = aFileBuf.buffer.slice(aFileBuf.byteOffset, aFileBuf.byteOffset + aFileBuf.byteLength)
const idToRow = new Map<string, number>()
samples.forEach((e, i) => idToRow.set(e.id, i))
let aReadTotal = 0
let aRoundtripOk = 0
for (const id of readIds) {
  const rowIdx = idToRow.get(id)!
  const t = performance.now()
  const rows = await parquetReadObjects({ file: aArrayBuffer, columns: ["full_gz"], rowStart: rowIdx, rowEnd: rowIdx + 1, utf8: false })
  const gz = rows[0].full_gz as Uint8Array
  const back = JSON.parse(zstdDecompressSync(Buffer.from(gz)).toString("utf8"))
  aReadTotal += performance.now() - t
  if (back.id === id) aRoundtripOk++
}
const aReadMs = aReadTotal / readIds.length

// ---------------- Report ----------------
console.log(`\n=== Candidate B — SQLite sealed (VACUUM + zstd L19) ===`)
console.log(`file size:      ${mb(bBytes)} MB  (${(bBytes / floorMax).toFixed(3)}× payload floor, ${(bBytes / rawTotal * 100).toFixed(1)}% of raw)`)
console.log(`write:          ${bWriteMs.toFixed(0)} ms`)
console.log(`read (p-mean):  ${bReadMs.toFixed(3)} ms/entry  (n=${readIds.length})`)
console.log(`round-trip:     ${bRoundtripOk}/${readIds.length} ok`)

console.log(`\n=== Candidate A — Parquet (meta cols + BYTE_ARRAY full_gz, zstd L19) ===`)
console.log(`file size:      ${mb(aBytes)} MB  (${(aBytes / floorMax).toFixed(3)}× payload floor, ${(aBytes / rawTotal * 100).toFixed(1)}% of raw)`)
console.log(`write:          ${aWriteMs.toFixed(0)} ms`)
console.log(`read (p-mean):  ${aReadMs.toFixed(3)} ms/entry  (n=${readIds.length})`)
console.log(`round-trip:     ${aRoundtripOk}/${readIds.length} ok`)

console.log(`\n=== VERDICT INPUTS ===`)
console.log(`A/B size ratio:  ${(aBytes / bBytes).toFixed(3)}  (>1 = Parquet larger)`)
console.log(`A/B read ratio:  ${(aReadMs / bReadMs).toFixed(2)}  (>1 = Parquet slower)`)
console.log(`container overhead over payload floor: B=${((bBytes / floorMax - 1) * 100).toFixed(1)}%  A=${((aBytes / floorMax - 1) * 100).toFixed(1)}%`)
