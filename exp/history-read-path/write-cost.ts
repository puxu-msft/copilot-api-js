import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const sourcePath = process.env.HISTORY_SOURCE ?? join(process.env.HOME ?? "", ".local/share/copilot-api/history-v3.db")
const outDir = process.env.POC_OUT_DIR ?? "/tmp/copilot-history-read-path-poc"
mkdirSync(outDir, { recursive: true })
const baselinePath = join(outDir, "write-baseline.db")
const treatmentPath = join(outDir, "write-treatment.db")
for (const base of [baselinePath, treatmentPath]) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(base + suffix)) unlinkSync(base + suffix)

type SourceRow = { summary_json: string; manifest_length: number }
type Summary = {
  sessionId?: string
  agentId?: string
  startedAt: number
  state?: string
  responseModel?: string
  requestModel?: string
  previewText?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}
type Sample = SourceRow & { manifest: Uint8Array; summary: Summary }

const source = new Database(sourcePath, { readonly: true, strict: true })
const sourceRows = source.query(`
  SELECT summary_json,length(manifest_gz) manifest_length
  FROM v3_operations
  WHERE kind='generation' AND json_extract(summary_json,'$.sessionId') IS NOT NULL
  ORDER BY operation_id
  LIMIT 500
`).all() as SourceRow[]
source.close()
const samples: Sample[] = sourceRows.map((row) => ({ ...row, manifest: randomBytes(row.manifest_length), summary: JSON.parse(row.summary_json) as Summary }))

function createDb(path: string, withSessions: boolean): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec(`
    PRAGMA page_size=4096;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA wal_autocheckpoint=1000;
    CREATE TABLE v3_operations(
      operation_id TEXT PRIMARY KEY,revision INTEGER,digest TEXT,kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,terminal_sequence INTEGER,ended_at INTEGER,
      timing_source TEXT NOT NULL,manifest_gz BLOB NOT NULL,summary_json TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,committed_at INTEGER NOT NULL
    );
    CREATE INDEX idx_v3_operations_created ON v3_operations(created_at DESC,operation_id DESC);
    CREATE INDEX idx_v3_operations_kind ON v3_operations(kind,created_at DESC);
    CREATE INDEX idx_v3_operations_committed ON v3_operations(committed_at,operation_id);
  `)
  if (withSessions) db.exec(`
    CREATE TABLE v3_sessions(
      session_id TEXT PRIMARY KEY,request_count INTEGER NOT NULL,agent_ids_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
      first_started_at INTEGER NOT NULL,first_operation_id TEXT NOT NULL,
      last_started_at INTEGER NOT NULL,last_operation_id TEXT NOT NULL,
      completed INTEGER NOT NULL,failed INTEGER NOT NULL,aborted INTEGER NOT NULL,
      models_json TEXT NOT NULL,first_preview TEXT NOT NULL,preview TEXT NOT NULL
    );
    CREATE INDEX idx_v3_sessions_last_started ON v3_sessions(last_started_at DESC,session_id DESC);
  `)
  return db
}
const baseline = createDb(baselinePath, false)
const treatment = createDb(treatmentPath, true)
const insertSql = `INSERT INTO v3_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
const baselineInsert = baseline.prepare(insertSql)
const treatmentInsert = treatment.prepare(insertSql)
const upsert = treatment.prepare(`
INSERT INTO v3_sessions(session_id,request_count,agent_ids_json,input_tokens,output_tokens,first_started_at,first_operation_id,last_started_at,last_operation_id,completed,failed,aborted,models_json,first_preview,preview)
VALUES($session_id,1,CASE WHEN NULLIF($agent_id,'') IS NULL THEN '[]' ELSE json_array($agent_id) END,$input_tokens,$output_tokens,$started_at,$operation_id,$started_at,$operation_id,$completed,$failed,$aborted,CASE WHEN $model IS NULL THEN '[]' ELSE json_array($model) END,$preview,$preview)
ON CONFLICT(session_id) DO UPDATE SET
 request_count=request_count+1,
 agent_ids_json=(SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(v3_sessions.agent_ids_json) UNION SELECT $agent_id WHERE NULLIF($agent_id,'') IS NOT NULL)),
 input_tokens=input_tokens+$input_tokens,output_tokens=output_tokens+$output_tokens,
 first_started_at=CASE WHEN ($started_at < first_started_at OR ($started_at=first_started_at AND $operation_id<first_operation_id)) THEN $started_at ELSE first_started_at END,
 first_operation_id=CASE WHEN ($started_at < first_started_at OR ($started_at=first_started_at AND $operation_id<first_operation_id)) THEN $operation_id ELSE first_operation_id END,
 first_preview=CASE WHEN ($started_at < first_started_at OR ($started_at=first_started_at AND $operation_id<first_operation_id)) THEN $preview ELSE first_preview END,
 last_started_at=CASE WHEN ($started_at > last_started_at OR ($started_at=last_started_at AND $operation_id>last_operation_id)) THEN $started_at ELSE last_started_at END,
 last_operation_id=CASE WHEN ($started_at > last_started_at OR ($started_at=last_started_at AND $operation_id>last_operation_id)) THEN $operation_id ELSE last_operation_id END,
 preview=CASE WHEN ($started_at > last_started_at OR ($started_at=last_started_at AND $operation_id>last_operation_id)) THEN $preview ELSE preview END,
 completed=completed+$completed,failed=failed+$failed,aborted=aborted+$aborted,
 models_json=(SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(v3_sessions.models_json) UNION SELECT $model WHERE $model IS NOT NULL))
`)

function values(sample: Sample, i: number): [unknown[], Record<string, unknown>] {
  const s = sample.summary
  const operationId = `write-cost-${i.toString().padStart(5, "0")}`
  const createdAt = s.startedAt
  const insert: unknown[] = [operationId, 1, `digest-${i}`, "generation", createdAt, i, createdAt + 1, "canonical", sample.manifest, sample.summary_json, 0, createdAt + 2]
  const aggregate = {
    session_id: s.sessionId!, agent_id: s.agentId ?? null,
    input_tokens: (s.usage?.input_tokens ?? 0) + (s.usage?.cache_read_input_tokens ?? 0) + (s.usage?.cache_creation_input_tokens ?? 0),
    output_tokens: s.usage?.output_tokens ?? 0, started_at: createdAt, operation_id: operationId,
    completed: s.state === "completed" ? 1 : 0, failed: s.state === "failed" ? 1 : 0,
    aborted: s.state === "aborted" || s.state === "interrupted" ? 1 : 0,
    model: s.responseModel ?? s.requestModel ?? null, preview: s.previewText ?? "",
  }
  return [insert, aggregate]
}
const baselineTx = baseline.transaction((insert: unknown[]) => baselineInsert.run(...insert))
const treatmentTx = treatment.transaction((insert: unknown[], aggregate: Record<string, unknown>) => { treatmentInsert.run(...insert); upsert.run(aggregate) })
const baselineMs: number[] = [], treatmentMs: number[] = [], pairedDeltaMs: number[] = []
for (let i = 0; i < samples.length; i++) {
  const [insert, aggregate] = values(samples[i]!, i)
  let b: number, t: number
  if (i % 2 === 0) {
    let start = performance.now(); baselineTx(insert); b = performance.now() - start
    start = performance.now(); treatmentTx(insert, aggregate); t = performance.now() - start
  } else {
    let start = performance.now(); treatmentTx(insert, aggregate); t = performance.now() - start
    start = performance.now(); baselineTx(insert); b = performance.now() - start
  }
  baselineMs.push(b); treatmentMs.push(t); pairedDeltaMs.push(t - b)
}
function percentile(values: number[], q: number): number { const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! }
function mean(values: number[]): number { return values.reduce((a,b)=>a+b,0)/values.length }
console.log(JSON.stringify({
  event: "write_cost_delta", samples: samples.length,
  baseline: { medianMs: percentile(baselineMs,.5), p95Ms: percentile(baselineMs,.95), meanMs: mean(baselineMs) },
  insertPlusUpsert: { medianMs: percentile(treatmentMs,.5), p95Ms: percentile(treatmentMs,.95), meanMs: mean(treatmentMs) },
  pairedDelta: { medianMs: percentile(pairedDeltaMs,.5), p05Ms: percentile(pairedDeltaMs,.05), p95Ms: percentile(pairedDeltaMs,.95), meanMs: mean(pairedDeltaMs) },
  differenceOfMediansMs: percentile(treatmentMs,.5)-percentile(baselineMs,.5),
}))
console.log(JSON.stringify({ event: "write_cost_counts", baselineRows: baseline.query("SELECT COUNT(*) n FROM v3_operations").get(), treatmentRows: treatment.query("SELECT COUNT(*) n FROM v3_operations").get(), sessions: treatment.query("SELECT COUNT(*) n FROM v3_sessions").get() }))
baseline.close(); treatment.close()
