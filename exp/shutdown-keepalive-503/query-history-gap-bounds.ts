// Timestamps the two edges of the gap, and nothing more: the `ended_at` of the last operation recorded before it, and the `created_at` of the first one recorded after it.
// It reads operation rows only — not process liveness, not shutdown phase, not the registry. So it cannot show when the drain finished, when the predecessor exited, or that anything was being rejected in between; a logical terminal lands well before an operation leaves the registry. An earlier version of this header claimed all three.
import { Database } from "bun:sqlite"

const db = new Database("/home/xp/.local/share/copilot-api/history-v3.db", { readonly: true })
const f = (t: number | null) => (t ? new Date(t).toISOString() : "null")

console.log("== last ops before the hole (created 13:00-13:03), with ended_at ==")
for (const r of db
  .query("SELECT operation_id,created_at,ended_at FROM v3_operations WHERE created_at BETWEEN ? AND ? ORDER BY created_at")
  .all(Date.parse("2026-08-09T13:00:00Z"), Date.parse("2026-08-09T13:03:00Z")) as Array<{ created_at: number; ended_at: number | null }>)
  console.log(" created", f(r.created_at), "ended", f(r.ended_at))

console.log("\n== ops after 13:10 (count + first/last) ==")
const after = db
  .query("SELECT created_at,ended_at FROM v3_operations WHERE created_at > ? ORDER BY created_at")
  .all(Date.parse("2026-08-09T13:10:00Z")) as Array<{ created_at: number }>
console.log(" count:", after.length, "first:", f(after[0]?.created_at), "last:", f(after.at(-1)?.created_at))
