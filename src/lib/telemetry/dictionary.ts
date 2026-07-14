/**
 * 维度/key 字典编码 —— 把重复字符串（维度名、`(dim,key)` 对）映射成小整数 id，
 * 避免每行重复存 `"claude-opus-4.8"` 之类字符串（列式压缩核心手法的 SQLite 手动版）。
 *
 * `intern*` 幂等：同输入返同 id（`INSERT OR IGNORE` + `SELECT`，并发安全）。
 * `resolveKey` 反查供读路径把整数 id 还原成 `(dim, key)` 呈现。
 */
import type { TelemetryDatabase } from "./db"

/** 维度名 → 整数 id（幂等）。 */
export function internDim(db: TelemetryDatabase, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tel_dim (name) VALUES (?)").run(name)
  const row = db.prepare("SELECT id FROM tel_dim WHERE name = ?").get(name) as { id: number } | undefined
  if (!row) throw new Error(`internDim: failed to resolve id for dim "${name}"`)
  return row.id
}

/** `(dimId, key)` → 整数 key_id（幂等）。`dimId` 来自 {@link internDim}。 */
export function internKey(db: TelemetryDatabase, dimId: number, key: string): number {
  db.prepare("INSERT OR IGNORE INTO tel_key (dim, key) VALUES (?, ?)").run(dimId, key)
  const row = db.prepare("SELECT id FROM tel_key WHERE dim = ? AND key = ?").get(dimId, key) as { id: number } | undefined
  if (!row) throw new Error(`internKey: failed to resolve id for (dim ${dimId}, key "${key}")`)
  return row.id
}

/** key_id → `{ dim, key }`（读路径反查；dim 为维度名字符串）。未知 id 返 null。 */
export function resolveKey(db: TelemetryDatabase, keyId: number): { dim: string; key: string } | null {
  const row = db
    .prepare("SELECT d.name AS dim, k.key AS key FROM tel_key k JOIN tel_dim d ON d.id = k.dim WHERE k.id = ?")
    .get(keyId) as { dim: string; key: string } | undefined
  return row ?? null
}
