import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const sourcePath = process.env.HISTORY_SOURCE ?? join(process.env.HOME ?? "", ".local/share/copilot-api/history-v3.db")
const outDir = process.env.POC_OUT_DIR ?? "/tmp/copilot-history-read-path-poc"
const finalPath = join(outDir, "synthetic.db")
const buildingPath = join(outDir, "synthetic.building.db")
const snapshotPath = join(outDir, "source-snapshot.json")
mkdirSync(outDir, { recursive: true })

type SourceRow = {
  operation_id: string
  revision: number | null
  digest: string | null
  kind: string
  created_at: number
  terminal_sequence: number | null
  ended_at: number | null
  timing_source: string
  manifest_length: number
  summary_length: number
  summary_json: string
  pinned: number
  committed_at: number
}

type Complete = { value: string }

function isComplete(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const db = new Database(path, { readonly: true, strict: true })
    const marker = db.query("SELECT value FROM poc_meta WHERE key='build_version'").get() as Complete | null
    db.close()
    return marker?.value === "2"
  } catch {
    return false
  }
}

if (isComplete(finalPath)) {
  console.log(JSON.stringify({ event: "synthetic_exists", path: finalPath }))
  process.exit(0)
}

// Exact, self-owned scratch paths only. An interrupted partial build is never mistaken for complete.
for (const path of [buildingPath, `${buildingPath}-wal`, `${buildingPath}-shm`]) {
  if (existsSync(path)) unlinkSync(path)
}

console.time("readonly_snapshot")
const source = new Database(sourcePath, { readonly: true, strict: true })
const sourceVersion = (source.query("SELECT sqlite_version() AS version").get() as { version: string }).version
// One SQLite statement gives a transactionally consistent statement snapshot. It copies real summary JSON
// and manifest lengths, never manifest bytes. all() completes before close, so no read transaction survives.
const rows = source
  .query(`
    SELECT operation_id, revision, digest, kind, created_at, terminal_sequence, ended_at,
           timing_source, length(manifest_gz) AS manifest_length, length(summary_json) AS summary_length, summary_json, pinned, committed_at
    FROM v3_operations
    ORDER BY created_at, operation_id
  `)
  .all() as SourceRow[]
source.close()
console.timeEnd("readonly_snapshot")

const snapshotStats = {
  capturedAt: new Date().toISOString(),
  sourcePath,
  sourceVersion,
  rows: rows.length,
  kindDistribution: Object.fromEntries([...new Set(rows.map((r) => r.kind))].sort().map((kind) => [kind, rows.filter((r) => r.kind === kind).length])),
  manifestBytes: rows.reduce((sum, row) => sum + row.manifest_length, 0),
  summaryBytes: rows.reduce((sum, row) => sum + row.summary_length, 0),
  distinctSessions: new Set(rows.map((row) => JSON.parse(row.summary_json).sessionId).filter(Boolean)).size,
  manifestLengthDigest: new Bun.CryptoHasher("sha256")
    .update([...rows].sort((a, b) => a.operation_id.localeCompare(b.operation_id)).map((row) => `${row.operation_id}:${row.manifest_length}\n`).join(""))
    .digest("hex"),
}
writeFileSync(snapshotPath, JSON.stringify(snapshotStats, null, 2) + "\n")
console.log(JSON.stringify({ event: "snapshot_complete", ...snapshotStats }))

const db = new Database(buildingPath, { create: true, strict: true })
db.exec(`
  PRAGMA page_size=4096;
  PRAGMA journal_mode=OFF;
  PRAGMA synchronous=OFF;
  PRAGMA temp_store=MEMORY;
  PRAGMA locking_mode=EXCLUSIVE;
  CREATE TABLE v3_operations(
    operation_id TEXT PRIMARY KEY,
    revision INTEGER,
    digest TEXT,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    terminal_sequence INTEGER,
    ended_at INTEGER,
    timing_source TEXT NOT NULL DEFAULT 'unavailable',
    manifest_gz BLOB NOT NULL,
    summary_json TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    committed_at INTEGER NOT NULL
  );
  CREATE TABLE poc_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)
const insert = db.prepare(`
  INSERT INTO v3_operations(
    operation_id, revision, digest, kind, created_at, terminal_sequence, ended_at,
    timing_source, manifest_gz, summary_json, pinned, committed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const insertAll = db.transaction((batch: SourceRow[]) => {
  for (const row of batch) {
    // SQLite does not compress BLOBs. Incompressible random bytes preserve each real manifest length and
    // overflow-page allocation without copying production content.
    const manifest = randomBytes(row.manifest_length)
    insert.run(
      row.operation_id,
      row.revision,
      row.digest,
      row.kind,
      row.created_at,
      row.terminal_sequence,
      row.ended_at,
      row.timing_source,
      manifest,
      row.summary_json,
      row.pinned,
      row.committed_at,
    )
  }
})
console.time("synthetic_insert")
insertAll(rows)
console.timeEnd("synthetic_insert")

db.exec(`
  CREATE INDEX idx_v3_operations_created ON v3_operations(created_at DESC, operation_id DESC);
  CREATE INDEX idx_v3_operations_kind ON v3_operations(kind, created_at DESC);
  CREATE INDEX idx_v3_operations_committed ON v3_operations(committed_at, operation_id);
  INSERT INTO poc_meta(key,value) VALUES('build_complete','1');
  INSERT INTO poc_meta(key,value) VALUES('build_version','2');
  PRAGMA optimize;
`)
const validation = db.query(`
  SELECT COUNT(*) AS rows,
         SUM(length(manifest_gz)) AS manifest_bytes,
         SUM(length(summary_json)) AS summary_bytes,
         COUNT(DISTINCT json_extract(summary_json,'$.sessionId')) AS distinct_sessions
  FROM v3_operations
`).get()
console.log(JSON.stringify({ event: "synthetic_validation", ...validation }))
db.close()
renameSync(buildingPath, finalPath)
console.log(JSON.stringify({ event: "synthetic_ready", path: finalPath, snapshotPath }))
