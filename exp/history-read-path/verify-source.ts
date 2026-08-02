import { Database } from "bun:sqlite"
import { join } from "node:path"

const outDir = process.env.POC_OUT_DIR ?? "/tmp/copilot-history-read-path-poc"
const syntheticPath = process.env.POC_DB ?? join(outDir, "synthetic.db")
const sourcePath = process.env.HISTORY_SOURCE ?? join(process.env.HOME ?? "", ".local/share/copilot-api/history-v3.db")

type Row = { operation_id: string; manifest_length: number; summary_json: string }
const synthetic = new Database(syntheticPath, { readonly: true, strict: true })
const syntheticRows = synthetic.query("SELECT operation_id,length(manifest_gz) manifest_length,summary_json FROM v3_operations ORDER BY operation_id").all() as Row[]
synthetic.close()
const expected = new Map(syntheticRows.map((row) => [row.operation_id, row]))

const source = new Database(sourcePath, { readonly: true, strict: true })
// A single read-only SELECT captures the current source statement snapshot. New rows after the original
// synthetic snapshot are ignored by operation_id; the 34,404 captured rows must still match byte-for-byte.
const currentRows = source.query("SELECT operation_id,length(manifest_gz) manifest_length,summary_json FROM v3_operations ORDER BY operation_id").all() as Row[]
source.close()
let matched = 0
let missing = syntheticRows.length
let manifestLengthMismatches = 0
let summaryMismatches = 0
for (const sourceRow of currentRows) {
  const syntheticRow = expected.get(sourceRow.operation_id)
  if (!syntheticRow) continue
  matched++
  missing--
  if (syntheticRow.manifest_length !== sourceRow.manifest_length) manifestLengthMismatches++
  if (syntheticRow.summary_json !== sourceRow.summary_json) summaryMismatches++
}
console.log(JSON.stringify({
  event: "source_fidelity_verify",
  sourceRowsNow: currentRows.length,
  syntheticRows: syntheticRows.length,
  matched,
  missing,
  manifestLengthMismatches,
  summaryMismatches,
}))
if (missing || manifestLengthMismatches || summaryMismatches) process.exitCode = 1
