import { Database } from "bun:sqlite"
import { cpus, hostname, platform, release, arch } from "node:os"

const ROWS = 512
const LARGE_PAYLOAD = 256 * 1024
const SMALL_PAYLOAD = 64
const ROUNDS = 15
const WARMUPS = 3
const refCount = Number(process.argv[2] ?? 4)
const payloadBytes = Number(process.argv[3] ?? LARGE_PAYLOAD)
if (![0, 4, 32].includes(refCount)) throw new Error(`unsupported ref count: ${refCount}`)
if (![SMALL_PAYLOAD, LARGE_PAYLOAD].includes(payloadBytes)) throw new Error(`unsupported payload bytes: ${payloadBytes}`)

const DDL = `
CREATE TABLE operations(operation_id TEXT PRIMARY KEY, format_version INTEGER NOT NULL, manifest_digest TEXT NOT NULL, manifest_payload BLOB NOT NULL, manifest_epoch INTEGER NOT NULL);
CREATE TABLE evidence(digest TEXT PRIMARY KEY, payload BLOB NOT NULL, entity_epoch INTEGER NOT NULL);
CREATE TABLE operation_refs(operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, evidence_digest TEXT NOT NULL, expected_entity_epoch INTEGER NOT NULL, PRIMARY KEY(operation_id,sequence));
CREATE TABLE operation_integrity(operation_id TEXT PRIMARY KEY, validated_manifest_epoch INTEGER NOT NULL, validated_manifest_digest TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE summaries(operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, token_count INTEGER NOT NULL, summary_text TEXT NOT NULL, projection_status TEXT NOT NULL);
CREATE TABLE ready_marker(singleton INTEGER PRIMARY KEY, ready INTEGER NOT NULL);
INSERT INTO ready_marker VALUES(1,1);
CREATE INDEX idx_summaries_ready_created ON summaries(projection_status,created_at DESC,operation_id);
CREATE INDEX idx_summaries_session_ready ON summaries(session_id,projection_status,operation_id);
CREATE INDEX idx_operations_integrity_cover ON operations(operation_id,format_version,manifest_epoch,manifest_digest);
CREATE INDEX idx_integrity_cover ON operation_integrity(operation_id,status,validated_manifest_epoch,validated_manifest_digest);
CREATE INDEX idx_evidence_epoch_cover ON evidence(digest,entity_epoch);
`

const queries = {
  get: {
    baseline: `SELECT s.operation_id,s.session_id,s.created_at,s.token_count,s.summary_text FROM summaries s WHERE s.operation_id=? AND s.projection_status='ready'`,
    integrity: `SELECT s.operation_id,s.session_id,s.created_at,s.token_count,s.summary_text FROM summaries s JOIN operations o INDEXED BY idx_operations_integrity_cover USING(operation_id) JOIN operation_integrity i INDEXED BY idx_integrity_cover USING(operation_id) JOIN ready_marker m ON m.singleton=1 WHERE s.operation_id=? AND s.projection_status='ready' AND m.ready=1 AND i.status='valid' AND o.format_version BETWEEN 1 AND 3 AND i.validated_manifest_epoch=o.manifest_epoch AND i.validated_manifest_digest=o.manifest_digest AND NOT EXISTS(SELECT 1 FROM operation_refs r LEFT JOIN evidence e INDEXED BY idx_evidence_epoch_cover ON e.digest=r.evidence_digest WHERE r.operation_id=o.operation_id AND(e.digest IS NULL OR e.entity_epoch<>r.expected_entity_epoch))`,
    args: ["op-256"], repeats: 500,
  },
  list: {
    baseline: `SELECT s.operation_id,s.session_id,s.created_at,s.token_count,s.summary_text FROM summaries s INDEXED BY idx_summaries_ready_created WHERE s.projection_status='ready' ORDER BY s.created_at DESC,s.operation_id LIMIT 50`,
    integrity: `SELECT s.operation_id,s.session_id,s.created_at,s.token_count,s.summary_text FROM summaries s INDEXED BY idx_summaries_ready_created JOIN operations o INDEXED BY idx_operations_integrity_cover USING(operation_id) JOIN operation_integrity i INDEXED BY idx_integrity_cover USING(operation_id) JOIN ready_marker m ON m.singleton=1 WHERE s.projection_status='ready' AND m.ready=1 AND i.status='valid' AND o.format_version BETWEEN 1 AND 3 AND i.validated_manifest_epoch=o.manifest_epoch AND i.validated_manifest_digest=o.manifest_digest AND NOT EXISTS(SELECT 1 FROM operation_refs r LEFT JOIN evidence e INDEXED BY idx_evidence_epoch_cover ON e.digest=r.evidence_digest WHERE r.operation_id=o.operation_id AND(e.digest IS NULL OR e.entity_epoch<>r.expected_entity_epoch)) ORDER BY s.created_at DESC,s.operation_id LIMIT 50`,
    args: [], repeats: 100,
  },
  session: {
    baseline: `SELECT count(*) AS count,sum(s.token_count) AS tokens FROM summaries s INDEXED BY idx_summaries_session_ready WHERE s.session_id=? AND s.projection_status='ready'`,
    integrity: `SELECT count(*) AS count,sum(s.token_count) AS tokens FROM summaries s INDEXED BY idx_summaries_session_ready JOIN operations o INDEXED BY idx_operations_integrity_cover USING(operation_id) JOIN operation_integrity i INDEXED BY idx_integrity_cover USING(operation_id) JOIN ready_marker m ON m.singleton=1 WHERE s.session_id=? AND s.projection_status='ready' AND m.ready=1 AND i.status='valid' AND o.format_version BETWEEN 1 AND 3 AND i.validated_manifest_epoch=o.manifest_epoch AND i.validated_manifest_digest=o.manifest_digest AND NOT EXISTS(SELECT 1 FROM operation_refs r LEFT JOIN evidence e INDEXED BY idx_evidence_epoch_cover ON e.digest=r.evidence_digest WHERE r.operation_id=o.operation_id AND(e.digest IS NULL OR e.entity_epoch<>r.expected_entity_epoch))`,
    args: ["session-7"], repeats: 200,
  },
  stats: {
    baseline: `SELECT count(*) AS count,sum(s.token_count) AS tokens FROM summaries s WHERE s.projection_status='ready'`,
    integrity: `SELECT count(*) AS count,sum(s.token_count) AS tokens FROM summaries s JOIN operations o INDEXED BY idx_operations_integrity_cover USING(operation_id) JOIN operation_integrity i INDEXED BY idx_integrity_cover USING(operation_id) JOIN ready_marker m ON m.singleton=1 WHERE s.projection_status='ready' AND m.ready=1 AND i.status='valid' AND o.format_version BETWEEN 1 AND 3 AND i.validated_manifest_epoch=o.manifest_epoch AND i.validated_manifest_digest=o.manifest_digest AND NOT EXISTS(SELECT 1 FROM operation_refs r LEFT JOIN evidence e INDEXED BY idx_evidence_epoch_cover ON e.digest=r.evidence_digest WHERE r.operation_id=o.operation_id AND(e.digest IS NULL OR e.entity_epoch<>r.expected_entity_epoch))`,
    args: [], repeats: 100,
  },
} as const

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "bigint" ? Number(item) : normalize(item)]))
  return value
}
function planReadsPayload(rows: Array<Record<string, unknown>>) {
  return rows.some((row) => String(row.detail).toLowerCase().includes("manifest_payload"))
}
function classifyPlan(rows: Array<Record<string, unknown>>) {
  const details = rows.map((row) => String(row.detail))
  return {
    details,
    manifestPayloadNamed: planReadsPayload(rows),
    operationsCoveringIndex: details.some((detail) => detail.includes("COVERING INDEX idx_operations_integrity_cover")),
    evidenceCoveringIndex: details.some((detail) => detail.includes("COVERING INDEX idx_evidence_epoch_cover")),
    correlatedRefsScan: details.some((detail) => detail.includes("CORRELATED SCALAR SUBQUERY")),
    refsIndexSearch: details.some((detail) => detail.includes("operation_refs") && detail.includes("INDEX")),
    tempBtree: details.some((detail) => detail.includes("TEMP B-TREE")),
  }
}

const db = new Database(":memory:")
db.exec(DDL)
const payload = Buffer.alloc(payloadBytes, 77)
const seed = db.transaction(() => {
  const insertOperation = db.prepare("INSERT INTO operations VALUES(?,?,?,?,1)")
  const insertEvidence = db.prepare("INSERT INTO evidence VALUES(?,?,1)")
  const insertRef = db.prepare("INSERT INTO operation_refs VALUES(?,?,?,1)")
  const insertIntegrity = db.prepare("INSERT INTO operation_integrity VALUES(?,?,?,'valid')")
  const insertSummary = db.prepare("INSERT INTO summaries VALUES(?,?,?,?,?,'ready')")
  for (let index = 0; index < ROWS; index++) {
    const operationId = `op-${index}`
    const digest = `manifest-${index}`
    insertOperation.run(operationId, 3, digest, payload)
    insertIntegrity.run(operationId, 1, digest)
    insertSummary.run(operationId, `session-${index % 16}`, 1_700_000_000_000 + index, 100 + index, `summary-${index}`)
    for (let sequence = 0; sequence < refCount; sequence++) {
      const evidenceDigest = `${operationId}-e-${sequence}`
      insertEvidence.run(evidenceDigest, Buffer.from(`evidence-${sequence}`))
      insertRef.run(operationId, sequence, evidenceDigest)
    }
  }
})
seed()

let randomState = 0x9e3779b9 ^ refCount ^ payloadBytes
function random() {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return (randomState >>> 0) / 0x1_0000_0000
}

const results: Record<string, unknown> = {}
for (const [name, definition] of Object.entries(queries)) {
  const baselineStatement = db.prepare(definition.baseline)
  const integrityStatement = db.prepare(definition.integrity)
  const baselineResult = normalize(baselineStatement.all(...definition.args))
  const integrityResult = normalize(integrityStatement.all(...definition.args))
  if (JSON.stringify(baselineResult) !== JSON.stringify(integrityResult)) throw new Error(`${name} result mismatch`)
  const baselinePlanRows = db.prepare(`EXPLAIN QUERY PLAN ${definition.baseline}`).all(...definition.args) as Array<Record<string, unknown>>
  const integrityPlanRows = db.prepare(`EXPLAIN QUERY PLAN ${definition.integrity}`).all(...definition.args) as Array<Record<string, unknown>>

  function measure(statement: typeof baselineStatement) {
    const started = Bun.nanoseconds()
    for (let repeat = 0; repeat < definition.repeats; repeat++) statement.all(...definition.args)
    return (Bun.nanoseconds() - started) / definition.repeats / 1_000
  }
  for (let warmup = 0; warmup < WARMUPS; warmup++) { measure(baselineStatement); measure(integrityStatement) }
  const samples: Array<{ round: number; order: string; baselineUs: number; integrityUs: number; deltaUs: number }> = []
  for (let round = 0; round < ROUNDS; round++) {
    const baselineFirst = random() < 0.5
    let baselineUs: number
    let integrityUs: number
    if (baselineFirst) { baselineUs = measure(baselineStatement); integrityUs = measure(integrityStatement) }
    else { integrityUs = measure(integrityStatement); baselineUs = measure(baselineStatement) }
    samples.push({ round, order: baselineFirst ? "baseline-integrity" : "integrity-baseline", baselineUs, integrityUs, deltaUs: integrityUs - baselineUs })
  }
  const baselineValues = samples.map((sample) => sample.baselineUs)
  const integrityValues = samples.map((sample) => sample.integrityUs)
  const deltas = samples.map((sample) => sample.deltaUs)
  results[name] = {
    resultEquality: true,
    repeatsPerSample: definition.repeats,
    explain: { baseline: classifyPlan(baselinePlanRows), integrity: classifyPlan(integrityPlanRows) },
    samples,
    summaryUsPerExecution: { baselineMedian: median(baselineValues), integrityMedian: median(integrityValues), pairedDeltaMedian: median(deltas) },
  }
}

const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim()
console.log(JSON.stringify({
  scope: "B3 performance observation; no acceptance threshold",
  environment: { runtime: `Bun ${Bun.version}`, platform: platform(), release: release(), arch: arch(), hostname: hostname(), cpu: cpus()[0]?.model, cpuCount: cpus().length, commit: git },
  matrix: { rows: ROWS, refCount, payloadBytes, rounds: ROUNDS, warmups: WARMUPS },
  ddl: DDL,
  querySql: Object.fromEntries(Object.entries(queries).map(([name, value]) => [name, { baseline: value.baseline, integrity: value.integrity }])),
  results,
  boundary: ["Timings are local in-memory PoC observations, not production benchmarks.", "EXPLAIN naming a covering index is the no-payload-read oracle; manifest_payload is not selected.", "Correlated refs subquery executes per candidate summary row in the integrity shape."],
}, null, 2))
db.close()
