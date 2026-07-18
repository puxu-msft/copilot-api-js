---
name: history-sqlite-schema
description: 当需要了解 copilot-api-js 当前 History V3 SQLite 数据库结构时使用——history-v3.db semantic CAS/manifest/tracks/timeline/journal/search、可选 raw.db exact-byte CAS、artifact identity、zstd 编码与直接查库。旧 history.db/archive.db 仅作退役 V2 取证，不是当前在线 schema。也用于查 Umzug 迁移框架现状（已接线到 V3）与直接查库/调试存储。
---

# History SQLite Schema

## 权威真相源（优先用，别凭记忆）

- **DDL 单一源**：`src/lib/history/v3/store.ts` 的 `V3_SCHEMA_SQL`（唯一持久化 schema，History V2 removal 2026-07-18 后 `entries_v2`/`entry_stages`/`schema.ts` 等全部 V2 表定义已删除）。
- **驱动分流**：`src/lib/sqlite/driver.ts`（Bun `bun:sqlite` / Node `node:sqlite`，无 better-sqlite3；History V2 removal Phase 0 从 `history/sqlite/driver.ts` relocate 到中性位置，4+ 非 history 消费者共享）。
- **压缩**：`src/lib/sqlite/compression.ts`（同批 relocate，`v3/store.ts` 直接依赖）。
- **设计**：`docs/DESIGN.md`「活的架构现状」`src/lib/history/` 行 + `docs/history.md`。
- **库文件**：`$XDG_DATA_HOME/copilot-api/history-v3.db`（`PATHS.HISTORY_V3_DB`）；可选 raw exact-byte capture 默认同目录 `raw.db`。旧 `history.db`/`archive.db` 在线服务**绝不**打开/读取/迁移/删除——只作退役 V2 数据取证用途（需要时用 `sqlite3` 直接开旧文件查，本 skill 不覆盖其 schema，见 `docs/archive/` 下已归档的 V2 spec）。

## 表（`V3_SCHEMA_SQL`）

| 表 | 角色 |
|---|---|
| `v3_meta` | 通用 KV（预留）。 |
| `v3_objects` | 内容寻址 semantic object CAS：`hash` PK，`canonical_gz`（zstd 压缩 canonical JSON）+ `canonical_bytes`。跨 operation 去重共享 payload/frame 对象。 |
| `v3_operations` | 每个已提交 operation（generation/bypass/count-tokens/embeddings 等）恰一行：`operation_id` PK、`revision`/`digest`（幂等/冲突判据）、`kind`、`manifest_gz`（zstd 压缩 manifest）、`pinned`（debug-pin，同 V2 语义但只影响此表）、`committed_at`。只落**终态**——无 V2 那种 pending/executing/streaming 中间态行。 |
| `v3_tracks` | operation 内的具名轨（如 client/upstream 腿、per-attempt 轨）：`(operation_id, track_name, attempt_index)` PK，`refs_json` 引用 `v3_objects.hash`。 |
| `v3_timeline_chunks` | 逐 operation 的时间线分块（`(operation_id, chunk_index)` PK，`payload_gz`）——流式帧序列等时序数据。 |
| `v3_journal` | 自包含提交日志：`(operation_id, revision)` PK，`payload_gz` 独立于 `v3_objects`/`manifest_gz`（回滚可能清空 CAS 对象，恢复不能依赖它们），供 `recoverV3Journal` 重放未完成提交。 |
| `v3_search_objects` | 内容寻址搜索投影：`object_hash` PK，`document_gz`（可重建，非权威——真源仍是 `v3_objects`）。 |
| `v3_search_membership` | operation → 搜索对象的成员关系，`(operation_id, object_hash)` PK，FK CASCADE。 |
| `v3_search_backlog` | 搜索投影构建失败重试队列：`operation_id` PK、`reason`、`attempts`。 |
| `history_meta`（`sqlite/meta.ts`） | Umzug 迁移账本 KV：`schema_migrations` key 存已应用迁移名 JSON `string[]`。V2 时代的 backfill 游标/version 标志（`search_index_version`/`usage_normalize_version` 等）随对应 V2 backfill 模块一起删除，未随 V3 保留。 |

## 直接查库

```bash
sqlite3 ~/.local/share/copilot-api/history-v3.db ".tables"
sqlite3 ~/.local/share/copilot-api/history-v3.db ".schema v3_operations"
# 最近 operation（kind/created_at/pinned）
sqlite3 history-v3.db "SELECT operation_id,kind,created_at,pinned FROM v3_operations ORDER BY created_at DESC LIMIT 10"
```

`*_gz` 列是 zstd 压缩（`compression.ts::compressBytes`/`decompressBytes`）；应用层读面是 `v3/projection.ts::recordToHistoryEntry`（把 record 投影为 `HistoryEntry`），不要对运行中库直读——用 `/history/api/entries/:id` 或 in-flight 优先的读面。

## 数据模型：为什么是 CAS + manifest + tracks + timeline + journal

V3 用内容寻址代替 V2 的「head 表 + stage 子表」1:N 模型：

- **`v3_objects` 去重**：同 operation 内高度重复的 payload/frame（如同一请求多次重试共享的请求体）按 hash 只存一次，`v3_tracks`/manifest 引用 hash 而非内联数据。
- **`v3_journal` 独立于 CAS**：提交是「先写 journal（自包含、不依赖 CAS 对象）→ 再写 operation+tracks+timeline 事务」——即使事务回滚清空了刚插入的 CAS 对象，journal 仍完整，`recoverV3Journal` 可从它重放未完成的提交（见 `store.ts::recoverV3Journal`）。
- **冲突 vs 持久化失败是两条正交轴**：`commitPreparedOperation` 里，同一 `operation_id` 以不同 `revision`/`digest` 二次提交是**编程错误信号**（`V3OperationConflictError`），与「真正的 SQLite 写失败」（BUSY/LOCKED/IOERR）完全不同类——前者必须原样穿透计入 `status.conflicts`，后者才走 persist-guard 的 transient/permanent 分类（`getHistoryPersistErrorStats()`）。两套计数器互不越界，见下节。

## 持久化韧性（persist-guard 接入 V3，History V2 removal Phase 4c）

`src/lib/history/persist-guard.ts` 的 `runHistoryWrite`/`runHistoryWriteAsync` 包裹 V3 真正的 SQLite 写：

- `commitPreparedOperation`（同步事务：journal insert + `db.transaction`）→ `runHistoryWrite("v3-commit", ...)`。
- `runDrain`/`enqueueModelOperation`（异步排空路径）→ `runHistoryWriteAsync("v3-drain", ...)`。
- **conflict-throw 分支不经 persist-guard**——`V3OperationConflictError` 必须原样穿透到 `runDrain` 的调用方（先 `instanceof V3OperationConflictError` 判断计入 `status.conflicts`，不进 persist-guard 的 catch），绝不被静默降级为 `{ok:false, transient:false}`。
- 失败分类沿用 V2 同款：`SQLITE_BUSY`/`LOCKED`/`IOERR`/`PROTOCOL` → transient（稍后可重试）；约束/序列化错误 → permanent。per-`stage:class` 计数经 `getHistoryPersistErrorStats()`（`v3-commit:*`/`v3-drain:*` 前缀，与 `status.conflicts` 是完全独立的两套计数器，不重复统计同一次失败）。

## DB-health（接入 V3 open 路径 + 新 periodic tick，History V2 removal Phase 4b）

`src/lib/history/sqlite/connection.ts::openDatabase` 现是**唯一无条件路径**（不再有 `v3Only` 分支判断——`:memory:` 与磁盘路径同走一条，闭合了旧 V2 时代 `:memory:` 会意外建出 V2 表的陷阱）：

- **一次性 open-time 维护**：`maybeVacuumOnStartup`（一次性 full VACUUM，仅当 freelist ratio≥25% 且≥64MB 可回收时触发，never-throw）+ `seedAnalyzeIfNeeded`（首次 `ANALYZE`，仅当 `sqlite_stat1` 不存在时触发）无条件跑（`auto_vacuum=INCREMENTAL` 在这之前已无条件设置）。
- **周期性 tick 维护**：新建 `src/lib/history/v3/maintenance.ts`（`startV3Maintenance`/`stopV3Maintenance`/`runV3MaintenanceTick`，默认 300s，挂载于 `state.ts::initHistory`/`shutdownHistory`），对标已删除的 V2 reaper tick 但**只保留 DB 维护半职责**——`incrementalVacuum`+`checkpointWal`+`runOptimize`（三者定义仍在 `connection.ts`，签名不变，只是调用者从已删除的 `sqlite/reaper.ts` 换成新 tick）。
- **不采纳**：V2 的 `reclaimOrphanedActiveRows`/`hasLiveForeignOwner`/`distinctActiveOwnerPids`——绑定 `entries_v2` 的 pid/status 列，`v3_operations` 只落终态、无等价的「pending 行存活」概念，VACUUM 期间没有「另一进程正在写自己的行」这个并发风险维度。

## reaper / 分桶淘汰 —— V3 无等价物（非缺口，是设计收敛）

V2 的 `sqlite/reaper.ts`（成功/失败分桶按数量淘汰）随 V2 整体删除，**V3 没有等价机制**——在线服务对 V3 无 count retention、无自动删除、无内置冷归档；`pinned` 列仍在（`v3_operations.pinned`，经 `POST /history/api/entries/:id/pin|unpin` 切换），但只是普通标志、不再服务任何淘汰豁免逻辑（没有淘汰，也就没有"豁免淘汰"这回事）。

## 迁移（Umzug forward-runner，History V2 removal Phase 4d 起真接线）

`applyForwardMigrations`（`migrations/run.ts`）在 History V2 removal 之前是**全仓零生产调用点**的骨架，Phase 4d 起真正接线到 V3：`state.ts::initHistory` 在 `getDatabase().exec(V3_SCHEMA_SQL)` 与 `recoverV3Journal` 之间插入 `await applyForwardMigrations(getDatabase())`，`initHistory` 因此改签名为 `Promise<void>`（全仓调用点已补 `await`）。`MIGRATIONS`（`migrations/index.ts`）**仍是空数组**——本次接线的价值是让管线跑通、有测试证明"下次加 001+ 迁移时框架真的会对 V3 生效"，而非新增任何具体 schema 变更。

- **hybrid 边界不变**：`openDatabase` 内的 `V3_SCHEMA_SQL` 是 conceptual **000 地板**（`CREATE TABLE IF NOT EXISTS`，每次开库跑、**不进账本**）；Umzug 只追 **001+ 前向 DDL**。首条真实迁移落地时优先用 `sqlMigration(name, body)`（见下）。
- **账本落 `history_meta`**（`meta.ts` 的 `HISTORY_META_DDL`，Phase 4a 从已删除的 `schema.ts` 搬到 `meta.ts` 自身单一源）——`schema_migrations` key 存已应用迁移名 JSON `string[]`。`HistoryMetaStorage` 构造即自建 `history_meta` 表 + `executed()` 表缺返回 `[]`（Umzug 在建账本表前就会调 `executed()`，此 chicken-egg 守卫使 runner 与开库顺序解耦、可隔离测）。
- **失败策略二分**：schema 迁移失败 `applyForwardMigrations` **rethrow** → `initHistory` 调用方（`start.ts`）`process.exit(1)`（半迁移 schema 比不启动危险）；与数据层 backfill 的 never-throw 相反——但 V3 目前无任何 backfill（无等价 V2 那种历史数据回填机制，新写路径一次到位产出全部字段，projection 缺口靠 projection 层修复而非 backfill）。
- **partial-DDL wedge 防护**（对抗 review 抓到、两 runtime 实测确认）：Umzug **不把 `up` 包事务**且**仅在 `up` resolve 后才记账**；SQLite 未显式开事务时每条 DDL 自动 commit。故多语句迁移中途抛→前缀语句已 commit 但迁移**未记账**→下次重启从头重跑撞「table already exists」永久卡死。首选 `sqlMigration(name, body)` 把 body 包进 driver `transaction()`（SQLite 支持事务化 DDL，bun native `.transaction` 与 node:sqlite 手搓 BEGIN/COMMIT/ROLLBACK 两 runtime 实测 rollback 一致）使多语句 all-or-nothing、失败可重试。非事务型迁移须逐语句 re-entrant（`IF NOT EXISTS`/`PRAGMA table_info` 探测）。
- **选型记录（battle-tested > hand-rolled）**：driver-无关纯 JS 的 Umzug 胜 drizzle-kit——后者稳定版无 `node:sqlite` driver、autogenerate 表达不了部分索引 `WHERE`、裂双账本。详见 ADR `docs/decisions/2026-07-05-dependency-selection-bun-first.md` + `docs/spec/migration-framework-umzug.md`（LANDED，现状已更新指向 V3）。异步持久化不变量见 skill `persistence-async-invariants`。

## 内容寻址归一化（search_index 去重）——方法论仍适用于 V3 搜索投影

`v3_search_objects`/`v3_search_membership` 沿用 V2 时代验证过的内容寻址去重方法论（`src/lib/history/normalize-message.ts` 单一 owner），三条原则不变：

- **① 哈希投影必须 config-无关、确定、稳定，且哈希输入 == 存储搜索文本（单一投影）。** 同消息恒同输出，与运行时 config 无关——**绝不**复用 config 驱动的清洗函数（如 `removeSystemReminderTags` 读 `state.rewriteSystemReminders`）。canonical = 递归剥易变 key（`cache_control`）+ sorted-key JSON。
- **② 剥注入样板用 own-line 边界锚定正则，绝不用全局 `<tag>.*</tag>`。** 真实 transcript 含合法 inline 字面提及同名标签，全局正则会误删真内容。正解：`(?:^|\n)[ \t]*<tag>...lazy...</tag>[ \t\r]*(?=\n|$)`——只匹配自起一行+自终一行的结构块。
- **③ 易变子串清单靠真实数据实测枚举，不靠想象。** 从运行中后端 `/history/api/entries/:id` 拉真实消息对比同 session 连续两请求哪些字段每轮变。安全网 = `v3_search_backlog` 的失败重试记账（取代 V2 时代的 dedup-ratio tripwire——V3 无 backfill，靠写入时失败即入 backlog 而非事后统计比对）。
- **④ 测试要独立 oracle，自洽抓不到。** 同消息含/不含 cache_control 哈希相等的 golden 取真实连续两请求实测 pair（非合成）。

## FTS5 陷阱 —— 不适用于 V3（内容寻址取代全文索引）

V2 时代的 `entries_fts` trigram FTS5 external-content 索引（及其 COUNT 穿透/`'delete'` 腐败/VACUUM renumber rowid/trigram 大小写折叠四陷阱）已随 V2 整体退役，随 V3 的 `v3_search_objects`/`v3_search_membership` 内容寻址搜索一起消失——**没有 FTS vtable，这些陷阱对 V3 天然不存在**。若排查旧 `history.db`（仅作退役 V2 取证，见 `docs/archive/` 归档 spec）遇到这些坑，方法论仍可参考归档文档，但不影响任何在线路径。

（bun:sqlite 的 `.get()` 返回 `null` 而 `node:sqlite` 返回 `undefined`、触发器写入被计入 `.run().changes` 等通用运行时分歧见 skill `bun-node-runtime-gotchas`。）
