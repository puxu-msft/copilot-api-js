// Produced the incident evidence quoted in docs/lifecycle.md and in commit 4a86e826: the window with no served operations at all.
// Read-only on the live DB. Widen/shift the window to look at a different incident.
import { Database } from "bun:sqlite"

const db = new Database("/home/xp/.local/share/copilot-api/history-v3.db", { readonly: true })
const from = Date.parse("2026-08-09T12:35:00Z")
const to = Date.parse("2026-08-09T13:15:00Z")
const rows = db
  .query("SELECT operation_id, created_at, ended_at, kind FROM v3_operations WHERE created_at BETWEEN ? AND ? ORDER BY created_at")
  .all(from, to) as Array<{ operation_id: string; created_at: number; ended_at: number | null; kind: string }>
console.log(`rows in window: ${rows.length}`)
for (const r of rows) {
  console.log(new Date(r.created_at).toISOString(), "|", r.kind, "|", r.operation_id.slice(0, 12))
}
