import { Database } from "bun:sqlite"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const outDir = process.env.POC_OUT_DIR ?? "/tmp/copilot-history-read-path-poc"
const dbPath = process.env.POC_DB ?? join(outDir, "synthetic.db")
const mode = process.argv[2] ?? "all"

type PlanRow = { id: number; parent: number; notused: number; detail: string }
type Summary = Record<string, unknown> & {
  id: string
  sessionId?: string
  startedAt: number
  state?: string
  agentId?: string
  requestModel?: string
  responseModel?: string
  previewText?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

function open(): Database {
  return new Database(dbPath, { strict: true })
}
function ms(start: number): number {
  return performance.now() - start
}
function timed<T>(label: string, fn: () => T): { value: T; elapsedMs: number } {
  const start = performance.now()
  const value = fn()
  const elapsedMs = ms(start)
  console.log(JSON.stringify({ event: "timing", label, elapsedMs }))
  return { value, elapsedMs }
}
function plan(db: Database, label: string, sql: string, ...params: unknown[]): PlanRow[] {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as PlanRow[]
  console.log(JSON.stringify({ event: "plan", label, rows }))
  return rows
}
function scalar(db: Database, sql: string): number {
  return Number(Object.values(db.query(sql).get() as Record<string, unknown>)[0])
}

const generatedColumns = [
  ["session_id", "TEXT", "json_extract(summary_json,'$.sessionId')"],
  ["state", "TEXT", "json_extract(summary_json,'$.state')"],
  ["started_at", "INTEGER", "json_extract(summary_json,'$.startedAt')"],
  ["input_tokens", "INTEGER", "COALESCE(json_extract(summary_json,'$.usage.input_tokens'),0)"],
  ["output_tokens", "INTEGER", "COALESCE(json_extract(summary_json,'$.usage.output_tokens'),0)"],
  ["cache_read_tokens", "INTEGER", "COALESCE(json_extract(summary_json,'$.usage.cache_read_input_tokens'),0)"],
  ["cache_creation_tokens", "INTEGER", "COALESCE(json_extract(summary_json,'$.usage.cache_creation_input_tokens'),0)"],
  ["effective_model", "TEXT", "COALESCE(json_extract(summary_json,'$.responseModel'),json_extract(summary_json,'$.requestModel'))"],
  ["preview_text", "TEXT", "COALESCE(json_extract(summary_json,'$.previewText'),'')"],
  ["agent_id", "TEXT", "json_extract(summary_json,'$.agentId')"],
] as const

function existingColumns(db: Database): Set<string> {
  return new Set((db.query("PRAGMA table_xinfo(v3_operations)").all() as Array<{ name: string }>).map((r) => r.name))
}
function addGeneratedColumns(db: Database): void {
  const columns = existingColumns(db)
  for (const [name, type, expression] of generatedColumns) {
    if (columns.has(name)) continue
    const result = timed(`alter_virtual_${name}`, () => db.exec(`ALTER TABLE v3_operations ADD COLUMN ${name} ${type} GENERATED ALWAYS AS (${expression}) VIRTUAL`))
    console.log(JSON.stringify({ event: "alter_virtual", column: name, elapsedMs: result.elapsedMs }))
  }
}
function createIndexMeasured(db: Database, name: string, ddl: string): void {
  const exists = db.query("SELECT 1 AS found FROM sqlite_master WHERE type='index' AND name=?").get(name)
  if (exists) return
  const beforePages = scalar(db, "PRAGMA page_count")
  const beforeFreelist = scalar(db, "PRAGMA freelist_count")
  const { elapsedMs } = timed(`create_${name}`, () => db.exec(ddl))
  const afterPages = scalar(db, "PRAGMA page_count")
  const afterFreelist = scalar(db, "PRAGMA freelist_count")
  let dbstat: unknown
  try {
    dbstat = db.query("SELECT COALESCE(SUM(pgsize),0) AS bytes, COUNT(*) AS pages FROM dbstat WHERE name=?").get(name)
  } catch (error) {
    dbstat = { unavailable: true, error: String(error) }
  }
  const occupiedPageDelta = (afterPages - afterFreelist) - (beforePages - beforeFreelist)
  console.log(JSON.stringify({ event: "index_created", name, elapsedMs, allocatedBytes: occupiedPageDelta * 4096, pageCountDelta: afterPages - beforePages, freelistDelta: afterFreelist - beforeFreelist, dbstat }))
}

function q1(): void {
  const db = open()
  console.log(JSON.stringify({ event: "versions", bun: Bun.version, sqlite: (db.query("SELECT sqlite_version() AS version").get() as { version: string }).version }))
  addGeneratedColumns(db)
  createIndexMeasured(db, "idx_poc_session_list", "CREATE INDEX idx_poc_session_list ON v3_operations(session_id, kind, created_at DESC, operation_id DESC)")
  createIndexMeasured(db, "idx_poc_kind_state_list", "CREATE INDEX idx_poc_kind_state_list ON v3_operations(kind, state, created_at DESC, operation_id DESC)")
  createIndexMeasured(db, "idx_poc_session_started", "CREATE INDEX idx_poc_session_started ON v3_operations(kind, session_id, started_at DESC, operation_id DESC)")
  console.log(JSON.stringify({ event: "nested_value", row: db.query("SELECT input_tokens, session_id FROM v3_operations WHERE input_tokens > 0 LIMIT 1").get() }))
  try {
    db.exec("ALTER TABLE v3_operations ADD COLUMN poc_stored TEXT GENERATED ALWAYS AS (json_extract(summary_json,'$.sessionId')) STORED")
    console.log(JSON.stringify({ event: "stored_alter", ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ event: "stored_alter", ok: false, error: String(error) }))
  }
  db.close()
}

const sessionListSql = `SELECT operation_id,summary_json FROM v3_operations WHERE session_id=? AND kind='generation' ORDER BY created_at DESC,operation_id DESC LIMIT ?`
const stateListSql = `SELECT operation_id,summary_json FROM v3_operations WHERE kind='generation' AND state=? ORDER BY created_at DESC,operation_id DESC LIMIT ?`
const groupSql = `SELECT session_id,COUNT(*) AS request_count,MAX(started_at) AS last_started_at FROM v3_operations WHERE kind='generation' AND session_id IS NOT NULL GROUP BY session_id ORDER BY MAX(started_at) DESC LIMIT 200`

function q2(): void {
  const db = open()
  addGeneratedColumns(db)
  createIndexMeasured(db, "idx_poc_session_list", "CREATE INDEX idx_poc_session_list ON v3_operations(session_id, kind, created_at DESC, operation_id DESC)")
  createIndexMeasured(db, "idx_poc_kind_state_list", "CREATE INDEX idx_poc_kind_state_list ON v3_operations(kind, state, created_at DESC, operation_id DESC)")
  createIndexMeasured(db, "idx_poc_session_started", "CREATE INDEX idx_poc_session_started ON v3_operations(kind, session_id, started_at DESC, operation_id DESC)")
  const sample = db.query("SELECT session_id,state FROM v3_operations WHERE kind='generation' AND session_id IS NOT NULL LIMIT 1").get() as { session_id: string; state: string }
  plan(db, "session_list", sessionListSql, sample.session_id, 50)
  plan(db, "state_list", stateListSql, sample.state, 50)
  plan(db, "group_session_first", groupSql)

  db.clearQueryCache()
  db.exec("DROP INDEX IF EXISTS idx_poc_session_started")
  createIndexMeasured(db, "idx_poc_started_session", "CREATE INDEX idx_poc_started_session ON v3_operations(kind, started_at DESC, session_id, operation_id DESC)")
  plan(db, "group_started_first", groupSql)

  db.clearQueryCache()
  db.exec("DROP INDEX IF EXISTS idx_poc_started_session")
  createIndexMeasured(db, "idx_poc_session_started", "CREATE INDEX idx_poc_session_started ON v3_operations(kind, session_id, started_at DESC, operation_id DESC)")
  plan(db, "group_session_first_restored", groupSql)
  db.close()
}

function aggregateRowsFromSummaries(summaries: Summary[]): Array<Record<string, unknown>> {
  const groups = new Map<string, Summary[]>()
  for (const summary of summaries) {
    if (!summary.sessionId) continue
    const group = groups.get(summary.sessionId) ?? []
    group.push(summary)
    groups.set(summary.sessionId, group)
  }
  return [...groups].map(([sessionId, entries]) => {
    entries.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    const models = new Set<string>()
    const agents = new Set<string>()
    let inputTokens = 0, outputTokens = 0, completed = 0, failed = 0, aborted = 0
    for (const entry of entries) {
      if (entry.agentId) agents.add(entry.agentId)
      const model = entry.responseModel ?? entry.requestModel
      if (model) models.add(model)
      inputTokens += (entry.usage?.input_tokens ?? 0) + (entry.usage?.cache_read_input_tokens ?? 0) + (entry.usage?.cache_creation_input_tokens ?? 0)
      outputTokens += entry.usage?.output_tokens ?? 0
      if (entry.state === "completed") completed++
      else if (entry.state === "failed") failed++
      else if (entry.state === "aborted" || entry.state === "interrupted") aborted++
    }
    return {
      sessionId, requestCount: entries.length, agentCount: agents.size, inputTokens, outputTokens,
      firstStartedAt: entries[0]!.startedAt, lastStartedAt: entries.at(-1)!.startedAt,
      completed, failed, aborted, models: [...models].sort(), firstPreview: entries[0]!.previewText ?? "", preview: entries.at(-1)!.previewText ?? "",
    }
  }).sort((a, b) => Number(b.lastStartedAt) - Number(a.lastStartedAt) || String(b.sessionId).localeCompare(String(a.sessionId)))
}

const r2Sql = `
WITH agg AS (
  SELECT session_id,
         COUNT(*) request_count,
         COUNT(DISTINCT NULLIF(agent_id,'')) agent_count,
         SUM(input_tokens + cache_read_tokens + cache_creation_tokens) input_tokens,
         SUM(output_tokens) output_tokens,
         MIN(started_at) first_started_at,
         MAX(started_at) last_started_at,
         SUM(state='completed') completed,
         SUM(state='failed') failed,
         SUM(state IN ('aborted','interrupted')) aborted,
         json_group_array(DISTINCT effective_model) FILTER (WHERE effective_model IS NOT NULL) models
  FROM v3_operations
  WHERE kind='generation' AND session_id IS NOT NULL
  GROUP BY session_id
  ORDER BY MAX(started_at) DESC, session_id DESC
  LIMIT 200
)
SELECT agg.*,
       (SELECT preview_text FROM v3_operations first_row WHERE first_row.kind='generation' AND first_row.session_id=agg.session_id ORDER BY started_at ASC,operation_id ASC LIMIT 1) first_preview,
       (SELECT preview_text FROM v3_operations last_row WHERE last_row.kind='generation' AND last_row.session_id=agg.session_id ORDER BY started_at DESC,operation_id DESC LIMIT 1) preview
FROM agg
ORDER BY last_started_at DESC,session_id DESC`

function createSessionsSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS v3_sessions;
    CREATE TABLE v3_sessions(
      session_id TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL,
      agent_ids_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      first_started_at INTEGER NOT NULL,
      first_operation_id TEXT NOT NULL,
      last_started_at INTEGER NOT NULL,
      last_operation_id TEXT NOT NULL,
      completed INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      aborted INTEGER NOT NULL,
      models_json TEXT NOT NULL,
      first_preview TEXT NOT NULL,
      preview TEXT NOT NULL
    );
    CREATE INDEX idx_v3_sessions_last_started ON v3_sessions(last_started_at DESC, session_id DESC);
  `)
}
function backfillSessions(db: Database): number {
  createSessionsSchema(db)
  const start = performance.now()
  db.exec(`
    INSERT INTO v3_sessions
    SELECT agg.session_id,agg.request_count,agg.agent_ids_json,agg.input_tokens,agg.output_tokens,
           agg.first_started_at,
           (SELECT operation_id FROM v3_operations f WHERE f.kind='generation' AND f.session_id=agg.session_id ORDER BY started_at ASC,operation_id ASC LIMIT 1),
           agg.last_started_at,
           (SELECT operation_id FROM v3_operations l WHERE l.kind='generation' AND l.session_id=agg.session_id ORDER BY started_at DESC,operation_id DESC LIMIT 1),
           agg.completed,agg.failed,agg.aborted,agg.models_json,
           (SELECT preview_text FROM v3_operations f WHERE f.kind='generation' AND f.session_id=agg.session_id ORDER BY started_at ASC,operation_id ASC LIMIT 1),
           (SELECT preview_text FROM v3_operations l WHERE l.kind='generation' AND l.session_id=agg.session_id ORDER BY started_at DESC,operation_id DESC LIMIT 1)
    FROM (
      SELECT session_id,COUNT(*) request_count,
             json_group_array(DISTINCT agent_id) FILTER (WHERE agent_id IS NOT NULL AND agent_id<>'') agent_ids_json,
             SUM(input_tokens+cache_read_tokens+cache_creation_tokens) input_tokens,
             SUM(output_tokens) output_tokens,
             MIN(started_at) first_started_at,MAX(started_at) last_started_at,
             SUM(state='completed') completed,SUM(state='failed') failed,SUM(state IN ('aborted','interrupted')) aborted,
             json_group_array(DISTINCT effective_model) FILTER (WHERE effective_model IS NOT NULL) models_json
      FROM v3_operations WHERE kind='generation' AND session_id IS NOT NULL GROUP BY session_id
    ) agg
  `)
  return ms(start)
}
function canonical(row: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: row.session_id ?? row.sessionId,
    requestCount: Number(row.request_count ?? row.requestCount),
    agentCount: row.agentCount !== undefined ? Number(row.agentCount) : row.agent_count !== undefined ? Number(row.agent_count) : JSON.parse(String(row.agent_ids_json ?? "[]")).length,
    inputTokens: Number(row.input_tokens ?? row.inputTokens), outputTokens: Number(row.output_tokens ?? row.outputTokens),
    firstStartedAt: Number(row.first_started_at ?? row.firstStartedAt), lastStartedAt: Number(row.last_started_at ?? row.lastStartedAt),
    completed: Number(row.completed), failed: Number(row.failed), aborted: Number(row.aborted),
    models: (Array.isArray(row.models) ? row.models : JSON.parse(String(row.models ?? row.models_json ?? "[]"))).filter((x: unknown) => x !== null).sort(),
    firstPreview: row.first_preview ?? row.firstPreview, preview: row.preview,
  }
}
function compare(label: string, expected: Array<Record<string, unknown>>, actual: Array<Record<string, unknown>>): void {
  const e = expected.map(canonical).sort((a,b) => String(a.sessionId).localeCompare(String(b.sessionId)))
  const a = actual.map(canonical).sort((x,y) => String(x.sessionId).localeCompare(String(y.sessionId)))
  const mismatches: Array<unknown> = []
  for (let i=0; i<Math.max(e.length,a.length); i++) if (JSON.stringify(e[i]) !== JSON.stringify(a[i])) mismatches.push({ expected:e[i], actual:a[i] })
  console.log(JSON.stringify({ event: "correctness", label, expectedRows:e.length, actualRows:a.length, mismatchCount:mismatches.length, firstMismatch:mismatches[0] }))
  if (mismatches.length) throw new Error(`${label} mismatched independent JS oracle`)
}

function loadIndependentOracle(db: Database): Array<Record<string, unknown>> {
  const rows = db.query("SELECT summary_json FROM v3_operations WHERE kind='generation' ORDER BY created_at DESC,operation_id DESC").all() as Array<{summary_json:string}>
  return aggregateRowsFromSummaries(rows.map((row)=>JSON.parse(row.summary_json) as Summary))
}

function q3r1(): void {
  const db = open()
  const nonProductionIndexes = db.query(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name='v3_operations' AND name LIKE 'idx_poc_%'
    ORDER BY name
  `).all() as Array<{name:string}>
  if (nonProductionIndexes.length) {
    throw new Error(`q3-r1 requires the production index set; remove PoC indexes first: ${nonProductionIndexes.map((row)=>row.name).join(', ')}`)
  }
  const r1 = timed("R1_current_sql_once", () => {
    const summaries: Summary[] = []
    let offset=0
    while (true) {
      const pageStart = performance.now()
      const rows = db.query("SELECT manifest_gz,summary_json,pinned,ended_at,timing_source FROM v3_operations WHERE kind=? ORDER BY created_at DESC,operation_id DESC LIMIT ? OFFSET ?").all("generation",256,offset) as Array<{summary_json:string}>
      if (!rows.length) break
      offset += rows.length
      for (const row of rows) summaries.push(JSON.parse(row.summary_json) as Summary)
      if (offset % 2560 === 0) console.log(JSON.stringify({event:"R1_progress",offset,pageMs:ms(pageStart)}))
    }
    return aggregateRowsFromSummaries(summaries)
  })
  console.log(JSON.stringify({event:"R1_result",sessions:r1.value.length,elapsedMs:r1.elapsedMs}))
  db.close()
}

function q3fast(): void {
  const db = open()
  addGeneratedColumns(db)
  createIndexMeasured(db, "idx_poc_session_started", "CREATE INDEX idx_poc_session_started ON v3_operations(kind, session_id, started_at DESC, operation_id DESC)")
  const oracle = timed("diagnostic_summary_only_independent_oracle", () => loadIndependentOracle(db)).value
  console.log(JSON.stringify({event:"oracle_agent_debug",row:oracle.find((row)=>row.sessionId==="03eae792-307f-4984-a453-0d7e5894adf4")}))
  const repetitions = 7
  for (let run=1; run<=repetitions; run++) {
    const r2 = timed(`R2_sql_group_run_${run}`, () => db.query(r2Sql).all() as Array<Record<string,unknown>>)
    compare(`R2_run_${run}`, oracle, r2.value)
    if (run === 1) {
      const beforePages=scalar(db,"PRAGMA page_count"),beforeFreelist=scalar(db,"PRAGMA freelist_count")
      const backfillMs = backfillSessions(db)
      const afterPages=scalar(db,"PRAGMA page_count"),afterFreelist=scalar(db,"PRAGMA freelist_count")
      console.log(JSON.stringify({ event:"backfill", elapsedMs:backfillMs, rows:scalar(db,"SELECT COUNT(*) FROM v3_sessions"),allocatedBytes:((afterPages-afterFreelist)-(beforePages-beforeFreelist))*4096 }))
      compare("R3_backfill", oracle, db.query("SELECT * FROM v3_sessions").all() as Array<Record<string,unknown>>)
      db.exec("UPDATE v3_sessions SET request_count=request_count+1 WHERE session_id=(SELECT session_id FROM v3_sessions LIMIT 1)")
      try {
        compare("R3_positive_control_intentionally_corrupted", oracle, db.query("SELECT * FROM v3_sessions").all() as Array<Record<string,unknown>>)
        throw new Error("positive control failed to detect corruption")
      } catch (error) {
        console.log(JSON.stringify({event:"positive_control",red:true,error:String(error)}))
      }
      db.exec("UPDATE v3_sessions SET request_count=request_count-1 WHERE session_id=(SELECT session_id FROM v3_sessions LIMIT 1)")
      compare("R3_restored_after_positive_control", oracle, db.query("SELECT * FROM v3_sessions").all() as Array<Record<string,unknown>>)
    }
    timed(`R3_materialized_read_run_${run}`, () => db.query("SELECT * FROM v3_sessions ORDER BY last_started_at DESC,session_id DESC LIMIT 200").all())
  }
  console.log(JSON.stringify({event:"R2_plan",rows:plan(db,"R2_full",r2Sql)}))
  console.log(JSON.stringify({event:"R3_plan",rows:plan(db,"R3_read","SELECT * FROM v3_sessions ORDER BY last_started_at DESC,session_id DESC LIMIT 200")}))
  const sessionsSqlBytes = Buffer.byteLength((db.query("SELECT sql FROM sqlite_master WHERE name='v3_sessions'").get() as {sql:string}).sql)
  const sessionsLogicalBytes = db.query(`SELECT COUNT(*) rows,SUM(length(session_id)+length(agent_ids_json)+length(models_json)+length(first_preview)+length(preview)+8*10) estimated_bytes FROM v3_sessions`).get()
  console.log(JSON.stringify({event:"R3_size",sessionsSqlBytes,sessionsLogicalBytes,note:"SQLite dbstat unavailable; logical row bytes are reported instead of pretending page-exact size."}))
  console.log(JSON.stringify({event:"db_size",bytes:statSync(dbPath).size}))
  db.close()
}

const upsertSql = `
INSERT INTO v3_sessions(session_id,request_count,agent_ids_json,input_tokens,output_tokens,first_started_at,first_operation_id,last_started_at,last_operation_id,completed,failed,aborted,models_json,first_preview,preview)
VALUES($session_id,1,json_array($agent_id) FILTER, $input_tokens,$output_tokens,$started_at,$operation_id,$started_at,$operation_id,$completed,$failed,$aborted,CASE WHEN $model IS NULL THEN '[]' ELSE json_array($model) END,$preview,$preview)
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
 models_json=(SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(v3_sessions.models_json) UNION SELECT $model WHERE $model IS NOT NULL))`

function q4(): void {
  const db = open()
  addGeneratedColumns(db)
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v3_sessions'").get()) backfillSessions(db)
  // Correct invalid FILTER placeholder in INSERT's initial agent JSON through a separate prepared SQL text.
  const sql = upsertSql.replace("json_array($agent_id) FILTER", "CASE WHEN NULLIF($agent_id,'') IS NULL THEN '[]' ELSE json_array($agent_id) END")
  const statement = db.prepare(sql)
  db.exec("DELETE FROM v3_sessions WHERE session_id LIKE 'poc-upsert-%'")
  const samples = db.query("SELECT operation_id,summary_json FROM v3_operations WHERE kind='generation' ORDER BY operation_id LIMIT 250").all() as Array<{operation_id:string;summary_json:string}>
  const timings:number[]=[]
  const oracleInputs: Summary[] = []
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  for (let i=0;i<samples.length;i++) {
    const source=JSON.parse(samples[i]!.summary_json) as Summary
    const fakeSessionId=`poc-upsert-${i%10}`
    const fakeOperationId=`poc-${i.toString().padStart(5,"0")}`
    oracleInputs.push({...source,sessionId:fakeSessionId,id:fakeOperationId})
    const params = {
      session_id:fakeSessionId,agent_id:source.agentId??null,
      input_tokens:(source.usage?.input_tokens??0)+(source.usage?.cache_read_input_tokens??0)+(source.usage?.cache_creation_input_tokens??0),
      output_tokens:source.usage?.output_tokens??0,started_at:source.startedAt,operation_id:fakeOperationId,
      completed:source.state==="completed"?1:0,failed:source.state==="failed"?1:0,aborted:source.state==="aborted"||source.state==="interrupted"?1:0,
      model:source.responseModel??source.requestModel??null,preview:source.previewText??"",
    }
    const start=performance.now(); statement.run(params); timings.push(ms(start))
  }
  timings.sort((a,b)=>a-b)
  console.log(JSON.stringify({event:"upsert_latency",samples:timings.length,minMs:timings[0],medianMs:timings[Math.floor(timings.length/2)],p95Ms:timings[Math.floor(timings.length*.95)],maxMs:timings.at(-1)}))
  compare("incremental_upsert_vs_independent_recompute",aggregateRowsFromSummaries(oracleInputs),db.query("SELECT * FROM v3_sessions WHERE session_id LIKE 'poc-upsert-%'").all() as Array<Record<string,unknown>>)

  const distribution = db.query("SELECT session_id,COUNT(*) n FROM v3_operations WHERE kind='generation' AND session_id IS NOT NULL GROUP BY session_id ORDER BY n").all() as Array<{session_id:string;n:number}>
  const average=distribution.reduce((sum,row)=>sum+row.n,0)/distribution.length
  const averageLike=[...distribution].sort((a,b)=>Math.abs(a.n-average)-Math.abs(b.n-average))[0]!
  const largest=distribution.at(-1)!
  for (const [label,target] of [["average",averageLike],["largest",largest]] as const) {
    for (let run=1;run<=7;run++) timed(`${label}_session_rescan_run_${run}`,()=>db.query(r2Sql.replace("WHERE kind='generation' AND session_id IS NOT NULL", "WHERE kind='generation' AND session_id=$session_id").replace("LIMIT 200", "LIMIT 1")).all({session_id:target.session_id}))
    console.log(JSON.stringify({event:"rescan_target",label,averageRows:average,...target}))
  }

  // Positive control: a duplicate standalone upsert must change request_count, proving non-idempotency.
  const before = scalar(db,"SELECT SUM(request_count) FROM v3_sessions WHERE session_id LIKE 'poc-upsert-%'")
  const source=JSON.parse(samples[0]!.summary_json) as Summary
  const duplicateParams={session_id:"poc-upsert-0",agent_id:source.agentId??null,input_tokens:0,output_tokens:0,started_at:source.startedAt,operation_id:"poc-00000",completed:0,failed:0,aborted:0,model:null,preview:source.previewText??""}
  statement.run(duplicateParams)
  const after = scalar(db,"SELECT SUM(request_count) FROM v3_sessions WHERE session_id LIKE 'poc-upsert-%'")
  console.log(JSON.stringify({event:"duplicate_positive_control",before,after,delta:after-before}))
  db.close()
}

function q5(): void {
  const db=open()
  const stats=db.query(`SELECT COUNT(*) rows,SUM(length(manifest_gz)) manifest_bytes,AVG(length(manifest_gz)) avg_manifest,MAX(length(manifest_gz)) max_manifest,SUM(length(summary_json)) summary_bytes,COUNT(DISTINCT json_extract(summary_json,'$.sessionId')) sessions FROM v3_operations`).get()
  const kinds=db.query("SELECT kind,COUNT(*) n FROM v3_operations GROUP BY kind ORDER BY kind").all()
  const pages={pageSize:scalar(db,"PRAGMA page_size"),pageCount:scalar(db,"PRAGMA page_count"),freelist:scalar(db,"PRAGMA freelist_count")}
  const snapshot=JSON.parse(readFileSync(join(outDir,"source-snapshot.json"),"utf8")) as Record<string,unknown>
  const lengthRows=db.query("SELECT operation_id,length(manifest_gz) manifest_length FROM v3_operations ORDER BY operation_id").all() as Array<{operation_id:string;manifest_length:number}>
  const manifestLengthDigest=new Bun.CryptoHasher("sha256").update(lengthRows.map((row)=>`${row.operation_id}:${row.manifest_length}\n`).join("")).digest("hex")
  console.log(JSON.stringify({event:"fidelity",stats,kinds,pages,fileBytes:statSync(dbPath).size,snapshot,manifestLengthDigest,manifestLengthDigestMatches:manifestLengthDigest===snapshot.manifestLengthDigest}))
  db.close()
}

if (mode === "q1") q1()
else if (mode === "q2") q2()
else if (mode === "q3-r1") q3r1()
else if (mode === "q3-fast") q3fast()
else if (mode === "q4") q4()
else if (mode === "q5") q5()
else throw new Error(`Unknown mode: ${mode}`)
