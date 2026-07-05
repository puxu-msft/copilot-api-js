# History Entry Pin/Unpin（后端 API）

> **实施状态：已完成**
> **落地**：ceab09b
> **现状锚点**：DESIGN history pinned 契约 + `/history/api/entries/:id/pin|unpin` 路由
> **备注**：schema/reaper/serialize/read/write/store/REST/类型全清单落地，无 config 键（纯 REST）

## Context

调试时常需要保留某条 history entry 的完整原始数据（请求/响应/sseEvents/per-attempt），但 SQLite reaper 按 success/failure 两桶超额淘汰（`history.success_limit`=50 / `history.failure_limit`=200），关键样本会被挤掉而消失。本特性给 entry 增加 **pin** 状态：被 pin 的条目永不被 reaper 淘汰、且不占用保留名额，从而在 debug 期间钉住原始数据。

**已确认决策（用户）**：
- **范围**：仅后端（schema/reaper/REST API），**不动 Vue UI**。通过 `POST /history/api/entries/:id/pin|unpin` 手动 pin（贴合既有 empirical-probe-via-history-api 工作流）。
- **保留语义**：pinned 行像 active 行一样**落在两个 bucket 之外**——既豁免淘汰、又豁免计数（不挤占 unpinned 名额）。

## 核心实现思路

`entries_v2` 加 `pinned INTEGER NOT NULL DEFAULT 0` 列。关键利用现有结构：[write.ts](src/lib/history/sqlite/write.ts) 的 `INSERT_ENTRY_SQL` 的列清单与 `ON CONFLICT DO UPDATE SET` **都不含 pinned**——故新增列不进 INSERT/UPSERT 列表时，首次插入取 `DEFAULT 0`、后续所有 eager 状态 upsert 都不会重置它。pinned 由**专用 `UPDATE` 独占写**，与请求生命周期写路径完全解耦。reaper 的 `evictBucket` 对 COUNT 和 DELETE 子查询共用同一 `where`，故只需给两个 WHERE 各加 `AND pinned = 0` 即可同时实现「豁免计数 + 豁免淘汰」。

## 改动清单

### 存储层（schema + 迁移）
- **[schema.ts](src/lib/history/sqlite/schema.ts)**：`entries_v2` CREATE TABLE 增 `pinned INTEGER NOT NULL DEFAULT 0`（fresh DB 路径）。
- **[connection.ts](src/lib/history/sqlite/connection.ts)** `migrateEntriesColumns`：`wanted[]` 增 `{ name: "pinned", type: "INTEGER NOT NULL DEFAULT 0" }`（既存 DB 的 `ALTER TABLE ADD COLUMN`；常量 DEFAULT 的 NOT NULL 列 SQLite 允许 ALTER 添加）。无需新索引——pinned 行极少，桶内 `AND pinned=0` 的额外过滤在现有 `idx_entries_v2_status` 上代价可忽略（YAGNI）。

### Reaper（保留语义）
- **[reaper.ts](src/lib/history/sqlite/reaper.ts)**：`SUCCESS_WHERE` / `FAILURE_WHERE` 各追加 `AND pinned = 0`。`evictBucket` 的 COUNT 与 DELETE 共用此 where → pinned 同时从计数与淘汰集合中剔除。更新该处注释（pinned 与 active 同属「桶外」豁免行）。

### 读写序列化
- **[serialize.ts](src/lib/history/sqlite/serialize.ts)**：`EntryRow` 增 `pinned: number`；`serializeHeadEntry` 设 `pinned: entry.pinned ? 1 : 0`（加注释说明此值仅为类型完整，**不被 INSERT_ENTRY_SQL 写入**，列由 `setEntryPinned` 独占）；`deserializeEntry` / `assembleFullEntry` 把 `row.pinned === 1` 映射到 `HistoryEntry.pinned`。
- **[read.ts](src/lib/history/sqlite/read.ts)**：`querySummaries` 的显式 SELECT 列表加 `pinned`；`rowToSummary` 设 `pinned: r.pinned === 1`（`SummaryRow = Omit<EntryRow,"blob_gz">` 会自动含 pinned）。`getEntryById` 用 `SELECT *`，经 `assembleFullEntry` 已自动带出。
- **[write.ts](src/lib/history/sqlite/write.ts)**：新增 `export function setEntryPinned(id: string, pinned: boolean): boolean`——先 `SELECT 1 FROM entries_v2 WHERE id=?` 判存在（**不读 `.run().changes`**：entries_fts AFTER UPDATE 触发器写入会被 bun:sqlite 计入 changes，见 reference-bun-sqlite-get-null-and-trigger-changes），再 `UPDATE entries_v2 SET pinned=? WHERE id=?`，返回是否命中。`INSERT_ENTRY_SQL` **保持不动**。

### 类型
- **[types.ts](src/lib/history/types.ts)**：`HistoryEntry` 与 `EntrySummary` 各增 `pinned?: boolean`。

### Store 层 + 广播
- **[entries.ts](src/lib/history/entries.ts)**：新增 `export function setPinned(id, pinned): boolean`——`historyState.enabled` 门控；调 sqlite `setEntryPinned`；命中则 `getSummary(id)`（import 自 `./queries`，无循环：queries 不 import entries）重读并 `publishEntryUpdated(summary)`（复用既有私有 publisher，使已连接的 WS 客户端同步 pinned 状态）。
- **[store.ts](src/lib/history/store.ts)**：barrel 增 `setPinned` 导出。

### REST API
- **[handler.ts](src/routes/history/handler.ts)**：新增 `handlePinEntry` / `handleUnpinEntry`（或单 handler 经路径区分）——`isHistoryEnabled` 门控、取 `id` param、调 `setPinned(id, true/false)`；命中返回更新后的 `getEntry(id)`（richest-data-flow，客户端拿到完整条目），未命中返回 404。
- **[route.ts](src/routes/history/route.ts)**：`historyRoutes.post("/api/entries/:id/pin", handlePinEntry)` + `.../unpin`。沿用 plain Hono（history sub-API 故意不进 `/openapi.json`）。

## 测试（`bun run test:backend`）
- **`tests/history/sqlite/reaper.unit.test.ts`**（扩展）：pinned 成功/失败行在超额淘汰后**幸存**、且**不计入**桶 limit（pin 满 limit 条后 unpinned 仍按各自 limit 淘汰）。
- **`tests/history/sqlite/write-read.unit.test.ts`**（扩展）：`setEntryPinned` 往返；后续 `upsertHeadRow`（eager 状态变更）**不重置** pinned；summary/entry 读出 `pinned` 正确；`setEntryPinned` 对未知 id 返回 false。
- **新增 `tests/history/pin-api.http.test.ts`**：`createFullTestApp` → POST pin/unpin 命中返回更新条目、未知 id 404、history 未启用 400、pin 后 `GET /api/entries/:id` 反映 `pinned:true`。
- 无新 module-global 单例 → 不动 `RESETTERS`。

## 文档同步
- **[docs/DESIGN.md](docs/DESIGN.md)**：history 模块行 reaper 契约补「pinned 行与 active 行同属桶外豁免（不计数/不淘汰）」；路由表「基础设施」`/history/api/*` 处或 history.md 记 pin/unpin 端点。
- **[docs/history.md](docs/history.md)**：新增 pin/unpin 小节（语义 + REST 用法 + 与 reaper 桶的关系）。

## 验证
1. `bun run typecheck`（改了 `.ts`）。
2. `bun run test:backend`（reaper/write-read/pin-api 全绿）。
3. `eslint --fix` 触及文件。
4. 手动（需用户启服务器，遵守 no-auto-server）：`curl -XPOST localhost:4141/history/api/entries/<id>/pin` → 返回 `pinned:true` 的条目；`curl localhost:4141/history/api/entries/<id>` 复核；调小 `success_limit` 跑满后确认 pinned 条目未被淘汰。
