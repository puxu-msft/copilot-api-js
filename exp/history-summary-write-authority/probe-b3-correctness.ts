import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

const ROWS = 512
const MANIFEST_BYTES = 256 * 1024
const REF_COUNTS = [0, 4, 32] as const
const SUPPORTED_FORMAT = 3

const DDL = `
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  manifest_payload BLOB NOT NULL,
  manifest_epoch INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE evidence (
  digest TEXT PRIMARY KEY,
  payload BLOB NOT NULL,
  entity_epoch INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE operation_refs (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  evidence_digest TEXT NOT NULL,
  expected_entity_epoch INTEGER NOT NULL,
  PRIMARY KEY(operation_id, sequence)
);
CREATE TABLE operation_integrity (
  operation_id TEXT PRIMARY KEY,
  validated_manifest_epoch INTEGER NOT NULL,
  validated_manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('valid','invalid'))
);
CREATE TABLE summaries (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  projection_status TEXT NOT NULL CHECK(projection_status IN ('ready','pending'))
);
CREATE TABLE ready_marker (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ready INTEGER NOT NULL CHECK(ready IN (0,1)));
INSERT INTO ready_marker VALUES(1, 1);

${process.env.B3_MUTATE_DISABLE_INVALIDATION === "1" ? "" : `CREATE TRIGGER operation_changed AFTER UPDATE OF format_version, manifest_digest, manifest_payload ON operations
BEGIN
  UPDATE operations SET manifest_epoch = OLD.manifest_epoch + 1 WHERE operation_id = NEW.operation_id;
  UPDATE operation_integrity SET status = 'invalid' WHERE operation_id = NEW.operation_id;
  UPDATE summaries SET projection_status = 'pending' WHERE operation_id = NEW.operation_id;
  UPDATE ready_marker SET ready = 0 WHERE singleton = 1;
END;`}
CREATE TRIGGER evidence_changed AFTER UPDATE OF payload ON evidence
BEGIN
  UPDATE evidence SET entity_epoch = OLD.entity_epoch + 1 WHERE digest = NEW.digest;
  UPDATE operation_integrity SET status = 'invalid' WHERE operation_id IN (SELECT operation_id FROM operation_refs WHERE evidence_digest = NEW.digest);
  UPDATE summaries SET projection_status = 'pending' WHERE operation_id IN (SELECT operation_id FROM operation_refs WHERE evidence_digest = NEW.digest);
  UPDATE ready_marker SET ready = 0 WHERE singleton = 1;
END;
CREATE TRIGGER evidence_deleted AFTER DELETE ON evidence
BEGIN
  UPDATE operation_integrity SET status = 'invalid' WHERE operation_id IN (SELECT operation_id FROM operation_refs WHERE evidence_digest = OLD.digest);
  UPDATE summaries SET projection_status = 'pending' WHERE operation_id IN (SELECT operation_id FROM operation_refs WHERE evidence_digest = OLD.digest);
  UPDATE ready_marker SET ready = 0 WHERE singleton = 1;
END;
`

const READY_SQL = `
SELECT s.operation_id
FROM summaries s
JOIN operations o USING(operation_id)
JOIN operation_integrity i USING(operation_id)
JOIN ready_marker m ON m.singleton=1
WHERE s.operation_id = ?
  AND m.ready=1
  AND s.projection_status='ready'
  AND i.status='valid'
  AND o.format_version BETWEEN 1 AND 3
  AND i.validated_manifest_epoch=o.manifest_epoch
  AND i.validated_manifest_digest=o.manifest_digest
  AND NOT EXISTS (
    SELECT 1 FROM operation_refs r
    LEFT JOIN evidence e ON e.digest=r.evidence_digest
    WHERE r.operation_id=o.operation_id
      AND (e.digest IS NULL OR e.entity_epoch<>r.expected_entity_epoch)
  )
`

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}

function newDb() {
  const db = new Database(":memory:")
  db.exec(DDL)
  return db
}

function seedOne(db: Database, id: string, format: number, refs: number) {
  const manifest = Buffer.alloc(MANIFEST_BYTES, id.charCodeAt(id.length - 1) || 65)
  const digest = sha256(manifest)
  db.prepare("INSERT INTO operations VALUES(?,?,?,?,1)").run(id, format, digest, manifest)
  for (let sequence = 0; sequence < refs; sequence++) {
    const evidenceDigest = `${id}-e-${sequence}`
    db.prepare("INSERT INTO evidence VALUES(?,?,1)").run(evidenceDigest, Buffer.from(`evidence-${sequence}`))
    db.prepare("INSERT INTO operation_refs VALUES(?,?,?,1)").run(id, sequence, evidenceDigest)
  }
  db.prepare("INSERT INTO operation_integrity VALUES(?,?,?,'valid')").run(id, 1, digest)
  db.prepare("INSERT INTO summaries VALUES(?,?,?,'ready')").run(id, `session-${Number(id.replace(/\D/g, "")) % 16}`, `summary-${id}`)
}

function isReady(db: Database, id: string) {
  return db.prepare(READY_SQL).get(id) !== null
}

const generated: Record<string, unknown> = {}
for (const refs of REF_COUNTS) {
  const db = newDb()
  const tx = db.transaction(() => {
    for (let index = 0; index < ROWS; index++) seedOne(db, `op-${refs}-${index}`, 3, refs)
  })
  tx()
  generated[String(refs)] = {
    summaries: db.query("SELECT count(*) AS n FROM summaries").get()!.n,
    refs: db.query("SELECT count(*) AS n FROM operation_refs").get()!.n,
    manifestBytesPerRow: db.query("SELECT min(length(manifest_payload)) AS min, max(length(manifest_payload)) AS max FROM operations").get(),
    readyRows: db.query("SELECT count(*) AS n FROM summaries WHERE projection_status='ready'").get()!.n,
  }
  db.close()
}

type Case = { name: string; expectedReady: boolean; mutate?: (db: Database, id: string) => void }
const cases: Case[] = [
  { name: "v1", expectedReady: true },
  { name: "v2", expectedReady: true },
  { name: "valid-v3", expectedReady: true },
  { name: "future-manifest", expectedReady: false, mutate: (db, id) => db.prepare("UPDATE operations SET format_version=999 WHERE operation_id=?").run(id) },
  { name: "digest-mismatch", expectedReady: false, mutate: (db, id) => db.prepare("UPDATE operations SET manifest_digest='mismatch' WHERE operation_id=?").run(id) },
  { name: "write-after-attestation", expectedReady: false, mutate: (db, id) => db.prepare("UPDATE operations SET manifest_payload=? WHERE operation_id=?").run(Buffer.alloc(MANIFEST_BYTES, 90), id) },
]
const correctness: Record<string, unknown> = {}
for (const [index, testCase] of cases.entries()) {
  const db = newDb()
  const id = `case-${index}`
  seedOne(db, id, testCase.name === "v1" ? 1 : testCase.name === "v2" ? 2 : 3, testCase.name === "valid-v3" ? 4 : 0)
  testCase.mutate?.(db, id)
  const actualReady = isReady(db, id)
  correctness[testCase.name] = {
    expectedReady: testCase.expectedReady,
    actualReady,
    passed: actualReady === testCase.expectedReady,
    state: {
      operation: db.prepare("SELECT format_version,manifest_digest,manifest_epoch,length(manifest_payload) AS manifest_bytes FROM operations WHERE operation_id=?").get(id),
      integrity: db.prepare("SELECT * FROM operation_integrity WHERE operation_id=?").get(id),
      summary: db.prepare("SELECT projection_status FROM summaries WHERE operation_id=?").get(id),
      marker: db.query("SELECT ready FROM ready_marker").get(),
    },
  }
  db.close()
}

// Deliberate criterion-gap attempt: after changing canonical bytes, ordinary SQL rewrites all derived authority rows.
const forged = newDb()
seedOne(forged, "gap", 3, 4)
const changed = Buffer.alloc(MANIFEST_BYTES, 71)
const changedDigest = sha256(changed)
forged.prepare("UPDATE operations SET manifest_payload=?, manifest_digest=? WHERE operation_id='gap'").run(changed, changedDigest)
const epoch = forged.query("SELECT manifest_epoch AS epoch FROM operations WHERE operation_id='gap'").get()!.epoch
forged.prepare("UPDATE operation_integrity SET validated_manifest_epoch=?,validated_manifest_digest=?,status='valid' WHERE operation_id='gap'").run(epoch, changedDigest)
forged.exec("UPDATE summaries SET projection_status='ready' WHERE operation_id='gap'; UPDATE ready_marker SET ready=1 WHERE singleton=1")
const criterionGap = {
  description: "Ordinary SQL changes canonical bytes, then rewrites integrity/status/marker to a self-consistent ready state.",
  incorrectStateStillReady: isReady(forged, "gap"),
  physicalBlocker: "Pure SQLite epochs and normalized refs detect uncoordinated changes, but without a connection-local authority boundary ordinary SQL can rewrite both subject and validation state.",
  state: {
    operation: forged.query("SELECT manifest_digest,manifest_epoch,length(manifest_payload) AS manifest_bytes FROM operations WHERE operation_id='gap'").get(),
    integrity: forged.query("SELECT * FROM operation_integrity WHERE operation_id='gap'").get(),
    summary: forged.query("SELECT projection_status FROM summaries WHERE operation_id='gap'").get(),
    marker: forged.query("SELECT ready FROM ready_marker").get(),
  },
}
forged.close()

const allExpectedCasesPassed = Object.values(correctness).every((value: any) => value.passed)
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, constants: { rows: ROWS, refCounts: REF_COUNTS, manifestBytes: MANIFEST_BYTES, supportedFormat: SUPPORTED_FORMAT }, ddl: DDL, readySql: READY_SQL, generated, correctness, allExpectedCasesPassed, criterionGap }, null, 2))
if (!allExpectedCasesPassed) process.exitCode = 1
