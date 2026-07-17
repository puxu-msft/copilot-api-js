# V2 History Layer Removal — Blast-Radius Map & Removal Proposal

状态：SCOPING 提案（只读调研，未改任何代码）。裁判轴 = 长远正确 + 完整（NOT YAGNI），对「是否真死」持对抗态度——误删活路径是最坏结果。所有 file:line 证据基于 `master` @ `5187c386`。

## 0. 核心事实（决定一切分类的三块地基）

三条已亲手核实的事实，颠覆「V2 是一整坨死码，clean delete 即可」的直觉：

1. **生产写入只走 V3 终端总线；V2 写链在生产里根本不挂载。** `start.ts:406` `initHistory(historyEnabled)` 只装 V3；`start.ts:409-410` 明文注释 “The legacy mutable-context HistorySink is deliberately **not attached** in production”。`initHistory`（`state.ts:96-101`）只开 `history-v3.db`、跑 `V3_SCHEMA_SQL`、订阅 `subscribeModelOperationTerminals(enqueueModelOperation)`。生产的终端持久化生产者是 `request.ts:654 publishModelOperationTerminal(...)` → V3。

2. **V2 写链（`entries.ts` + `HistorySink` + `in-flight` + `sqlite/write|serialize|reaper|persist-guard`）在生产里休眠，但仍是「测试驱动 history 端到端」的机制。** `HistorySink`（`observability/sinks/history.ts`）调 `insertEntry/finalizeEntry/persistEntry*`（→ `entries.ts` → `sqlite/write.ts:insertCompletedEntry`）。`attachHistorySink` 的调用点**全在 tests**：`tests/helpers/test-bootstrap.ts:49,76`、`tests/history/{per-attempt-error-body,leg-stages,restructure-repoint-gate}.*`。这是本次重构**最大的手术面**（见 §6 风险①），不是 clean delete。

3. **读面全走 V3，但 `queries.ts` 仍从两处 V2 目录取「纯 helper」。** `queries.ts` 数据源是 `v3/projection` + `v3/store` + `v3/terminal-bus`（`queries.ts:20-35`），但它 `import { formatFromEndpoint } from "./sqlite/search-index-write"`（`queries.ts:19`）并 `import { getInFlight ... } from "./in-flight"`（读时 merge in-flight）。这两个是需「先搬迁再删」的接缝。

由此，V2 层不是「一个可 clean-delete 的孤岛」，而是「一坨死码 + 几处与 V3/live 缠绕的接缝文件」。

---

## A. 逐文件/模块裁决表

裁决语义：**delete**（V2 独占、无 live 消费者，直接删）／**repoint-then-delete**（有 live 消费者引用一小块，先搬迁再删）／**surgery**（同文件混 V2 与 live/V3，剖开保留活的部分）／**keep-shared**（V3/项目在用，原地留）／**keep-relocate**（在用但应搬出 `sqlite/` 这个 V2 品牌目录）。

### A.1 `src/lib/history/sqlite/` —— V2 主体

| 文件 | 裁决 | 证据 & 理由 |
|---|---|---|
| `schema.ts` | **delete** | 定义 `entries_v2/response_sessions/entry_stages/msg_blob/req_msg/req_aux` + `HISTORY_META_DDL`（`schema.ts:6,12,79,99,107,120`）。`response_sessions` 唯一读写点是 V2 `write.ts:273,281`/`read.ts:216`——live `response-session-store.ts:1` 用 `new Map`，不碰此表。V3 有自己的 `V3_SCHEMA_SQL`（`v3/store.ts:76`）。唯一非删消费者是 `connection.ts:12,84`（V2 分支）和 `migrations/storage.ts`（同批删）。|
| `write.ts` | **delete** | 消费者仅 `entries.ts:41`（V2 写链）。`insertCompletedEntry/upsertHeadRow/clearAllEntries/upsert*`。|
| `read.ts` | **delete** | 全仓无任何 import（`grep "sqlite/read\""` 零命中）。已是纯死码。|
| `serialize.ts` | **delete** | 消费者 `entries.ts:35` + `observability/sinks/history.ts:49`（均 V2 写链、test-only 挂载）。|
| `reaper.ts` | **repoint-then-delete** | `startReaper(reaper.ts:111)` **无 live 调用**——`start.ts:452 contextManager.startReaper()` 是 `context/manager.ts:328` 的**请求上下文 reaper**，不是这个。此文件被 `entries.ts:27-29` 引 `isReaperRunning/setReaperTickHook`（随 V2 写链一起删）。import `checkpointWal/incrementalVacuum/runOptimize`（`reaper.ts:9-12`）——见 §B 的 DB-health 保留讨论。|
| `meta.ts` | **delete** | `getMeta/setMeta` 消费者全是 backfills（cache-write/response-preview/usage-normalize/search-index/calibration/legacy-stage）+ `migrations/storage.ts`——同批全删。V3 读写路径不碰 `history_meta`。|
| `migrations/{index,run,storage}.ts` | **delete（+开放问题 §D-3）** | Umzug hybrid forward-runner。V3 不用 Umzug——`state.ts:98` 直接 `getDatabase().exec(V3_SCHEMA_SQL)`。`storage.ts` 依赖 `meta.ts` + `schema.ts` 的 `HISTORY_META_DDL`。仅 test（`migrations.it.test.ts`）+ 自身引用。框架本身有长期价值，见 §D-3。|
| `cache-write-backfill.ts` | **delete** | 无 live 启动点（`grep start*Backfill` 仅 `connection.ts:117` 注释残留，start.ts 无实际调用）。|
| `usage-normalize-backfill.ts` | **delete** | 同上，dead backfill。|
| `response-preview-backfill.ts` | **delete** | 同上。|
| `search-index-backfill.ts` | **delete** | 同上。|
| `calibration-backfill.ts` | **delete** | 同上。|
| `legacy-stage-backfill.ts` | **delete** | 同上。V2→V2 阶段迁移，V3 无意义。|
| `search-index-write.ts` | **surgery（搬 `formatFromEndpoint`）** | 主体是 entries_v2 的 search_index 写入（V2）。但 `queries.ts:19`（live V3 读）只用其纯函数 `formatFromEndpoint`。搬 `formatFromEndpoint` 到 `entry-view.ts` 或新建 `endpoint-format.ts`，其余删。|
| `search-query.ts` | **delete** | 无 live 消费者（零命中 `sqlite/search-query"`）。V3 搜索走 `search.ts`→`v3/*`。|
| `sessions-agg.ts` | **delete** | 无 live 消费者。V3 会话走 `sessions.ts`→`v3/store:listV3StoredOperations`。|
| `stats.ts`（sqlite） | **delete** | 无 live 消费者。V3 统计走 root `stats.ts`→`getHistory`（V3）。|
| `archive-worker.ts` | **delete（+开放问题 §D-1）** | src 内**零 live 消费者**（仅 tests + `isolated-fixture.ts:48 resetArchiveWorkerForTests`）。是 V2 时代「三层降温归档」的 worker，操作 sealed durable-unit（作用于 entries_v2 世代）。记忆库记它 landed，但当前无调度接线——见 §D-1。|
| `connection.ts` | **surgery（承重）** | V3 **依赖** `openDatabase/getDatabase/closeDatabase/isDatabaseOpen/openInMemoryDatabase`（`v3/store.ts:12 getDatabase`、`state.ts:26-29`）。但同文件混大量 V2：`v3Only` 分支（`connection.ts:68,80-83`）在 `history-v3.db` 时跑完 5 条 PRAGMA 即 `return`；非 v3Only（含 `:memory:`）才跑 `SCHEMA_SQL`+`dropLegacyFts`+`migrateEntriesColumns`+`reclaimOrphanedActiveRows`+`maybeVacuumOnStartup`（`connection.ts:84-113`）。**注意 `:memory:` 不是 v3Only**（line 68），故测试经 `openInMemoryDatabase` 仍走 V2 schema 路径。手术：删 `SCHEMA_SQL` import/exec、`dropLegacyFtsAndSearchText`、`migrateEntriesColumns`、`reclaimOrphanedActiveRows`、`distinctActiveOwnerPids`、`hasLiveForeignOwner`。VACUUM/WAL 三件套见 §B。|
| `compression.ts` | **keep-relocate** | **V3 直接依赖**：`v3/store.ts:11 import { compressBytes, decompressBytes } from "../sqlite/compression"`。是承重共享件。建议搬出 `sqlite/`（→ `lib/history/compression.ts` 或 `lib/sqlite/`）。|
| `driver.ts` | **keep-relocate（核心共享）** | `createDatabase`/`SqliteDatabase` 是**全项目 SQLite 抽象**（bun:sqlite / node:sqlite runtime-split）。消费者：`telemetry/db.ts:17`（注释「复用 History 的 createDatabase, battle-tested」）、`anthropic/thinking-quarantine/store.ts:7`、`history/raw/manager.ts:8`、`history/sqlite/connection.ts:9`、`migrations/*`。**绝不能删**。强烈建议搬到中性位置（如 `lib/sqlite/driver.ts`），脱离 V2 品牌目录。|

### A.2 `src/lib/history/`（root）—— 混合区

| 文件 | 裁决 | 证据 & 理由 |
|---|---|---|
| `entries.ts` | **surgery（承重）** | 混三样：(1) V2 写链 `insertEntry/updateEntry/finalizeEntry/persistEntry*/clearHistory`（→ `sqlite/write` `insertCompletedEntry`、`serialize`、`reaper`、`persist-guard`；生产休眠、仅 HistorySink 驱动）；(2) **live `setPinned`**（`entries.ts:359-361`→`v3/store setV3OperationPinned`，被 `routes/history/handler.ts:163` 调用）；(3) in-flight facade `listInFlightEntries/getInFlightEntry`。手术：把 `setPinned` 与 in-flight facade 保留（或下沉到别处），删 V2 写链。|
| `in-flight.ts` | **surgery / 开放问题 §D-2** | 被 live `queries.ts`（读时 merge）引用，故不能直接删。但生产里无人 `putInFlight`（HistorySink 未挂），故 in-flight 在生产恒空——即读面 merge 实为死支。见 §D-2「pending 可见性」开放问题。|
| `persist-guard.ts` | **repoint-then-delete（+§B 采纳候选）** | `runHistoryWrite/runHistoryWriteAsync` 仅 `entries.ts` 用；`isolated-fixture.ts:47 resetHistoryPersistErrorStats`。V3 `store.ts` 不用它。是通用 never-throw DB 写守卫，有采纳价值（§B）。|
| `queries.ts` | **surgery（保留，剥两处 V2 依赖）** | Live V3 读。剥 `formatFromEndpoint`（随 search-index-write 搬迁）与 in-flight merge（随 §D-2 定夺）。|
| `sessions.ts` / `search.ts` / `stats.ts` / `search-types.ts` | **keep-shared** | 全走 V3（`sessions.ts:10-11 v3/*`、`search.ts:6-12 v3/*`、`stats.ts:11 getHistory`）。|
| `state.ts` | **keep-shared** | V3 生命周期编排（开库/schema/终端订阅/drain/shutdown）。`startHistoryBackfills`（`state.ts:161`）已是空 no-op，可顺手删或留。|
| `entry-view.ts` | **keep-shared（核心）** | 广泛共享：V3 读（`queries/sessions/stats/in-flight`）、observability projections（`log-line/format`）、TUI、**前端**（`ui-v4` 多处 import `~backend/lib/history/entry-view`）。|
| `normalize-message.ts` | **keep-shared** | `queries.ts:18 extractInboundSearchText`（live V3 读）。|
| `lifecycle-state.ts` | **keep-shared** | `ACTIVE_STATES/isActiveState` 用于 `tui/terminal-ui.ts`（live）+ `queries.ts:17`（live V3 读）。（仅 `sqlite/reaper.ts` 那处随 reaper 删。）|
| `accumulate-response.ts` | **keep-shared** | `entry-view.ts` + 前端 `~backend/lib/history/accumulate-response`。|
| `types.ts` | **keep-shared（类型 SSOT）** | 后端类型单一定义处；前端经 `~backend/lib/history/store` re-export。V3-shaped，非 V2。|
| `store.ts` | **surgery（公共 barrel）** | 前端 `~backend/lib/history/store` 的公共类型/函数出口。删表中被删函数的 re-export（如 V2-only 的 `insertEntry`），保留 V3 存活的（`getEntry/getHistory/setPinned/searchHistory/...` + 全部 type）。|
| `index.ts` | **surgery（barrel）** | 同 store.ts，删已删符号的 re-export。|
| `raw/{index,manager}.ts` | **keep-shared** | Live raw-capture（`request.ts`、`state.ts:20-23`、`routes/status/route.ts`）。用 `driver.ts` 独立开库，与 V2 无关。|
| `v3/{store,projection,index,terminal-bus}.ts` | **keep-shared（canonical）** | 唯一活的规范存储。|

### A.3 `src/lib/observability/`

| 文件 | 裁决 | 证据 |
|---|---|---|
| `sinks/history.ts`（`HistorySink`/`attachHistorySink`） | **repoint-then-delete（承重风险 §6-①）** | 生产不挂（`start.ts:409-410`）。唯一挂载点全在 tests。删它 = 删 V2 写链的入口，但牵动 `test-bootstrap.ts` 这条测试地基。|

### A.4 config —— 无 V2 history 键需删

`grep max_entries|reaper|entries_v2|tiered_archive|archive @ src/lib/config` 未命中任何 V2-history 配置键（命中的 `reaper` 全是请求上下文/stale-request reaper，无关）。`initHistory(enable, _legacyMaxEntries?)` 的 `_legacyMaxEntries` 是残留形参（code，非 config），手术时可清。**config 层零改动。**

---

## B. 应「carry-forward」的长期可采纳模块（用户明确指令：保留）

| 模块 | 现状 | 为何保留 / 采纳建议 |
|---|---|---|
| `driver.ts`（`createDatabase`/`SqliteDatabase`） | 已被 telemetry / thinking-quarantine / raw / V3 广泛复用 | 项目级 SQLite runtime-split 抽象（bun:sqlite↔node:sqlite），battle-tested。**必留**，建议 relocate 到 `lib/sqlite/driver.ts` 脱离 V2 目录。|
| `compression.ts`（`compressBytes`/`decompressBytes`） | V3 `store.ts` 正在用 | 内容寻址存储的压缩原语。**必留**，relocate。|
| DB-health 三件套 `checkpointWal` / `incrementalVacuum` / `maybeVacuumOnStartup` / `runOptimize` / `seedAnalyzeIfNeeded`（`connection.ts:193-277,468`） | 现仅 V2 reaper + V2 open 路径调用；**V3 open（v3Only 分支）在 line 82 提前 return，完全没跑 VACUUM/checkpoint/analyze** | 这是真·长期价值缺口：V3 的 `v3_objects` 也会增长，却无 WAL checkpoint / 空间回收 / planner-stats。**建议保留这些函数并作为 follow-up 接到 V3**（不在本次删除范围内一删了之）。→ 开放问题 §D-4。|
| `reclaimOrphanedActiveRows`（`connection.ts:335`）+ `process-identity` 存活判定 | 现作用于 entries_v2 的 pending/executing/streaming 行 | 「重启 overlap 回收孤儿活跃行」的设计对 V3 同样适用（V3 若有 in-flight/pending 概念）。设计思想可采纳，但当前实现绑 entries_v2 列，需重写而非搬。→ 归入 §D-2/§D-4。|
| `persist-guard.ts`（never-throw + transient/permanent 分类 + 错误统计） | 仅 V2 写链用 | 通用「持久化写永不抛、区分瞬时/永久」守卫，V3 写路径当前是自造错误处理。可采纳统一。→ §D-5。|
| Umzug 迁移框架 `migrations/`（hybrid forward-runner + `HistoryMetaStorage`） | V3 用裸 `exec(V3_SCHEMA_SQL)`，无版本化迁移 | 框架本身长期有价值：V3 schema 迟早要演进，届时裸 exec 不够。→ §D-3（保留框架 vs 随 V2 删）。|

> 判据提醒：以上「保留」不等于「本次接线」。多数是 carry-forward 的**源文件保留 + follow-up 采纳**，避免把正确基础设施跟着 V2 一起误删。

---

## C. 分阶段删除计划（每阶段 commit 后 tree 绿）

顺序原则：**先搬迁 live 消费者引用的接缝 → 再删死码 → 再拆 schema/连接手术 → 再清测试 → 最后 doc-sync**。每阶段独立 typecheck + 相关测试绿。

**Phase 0 — 先搬迁（keep-relocate / repoint），不删任何东西**
- 搬 `driver.ts` → `lib/sqlite/driver.ts`，`compression.ts` → 中性位置；改所有 import（telemetry/thinking-quarantine/raw/v3/connection/migrations）。
- 抽 `formatFromEndpoint` 出 `search-index-write.ts` → `entry-view.ts`（或新 `endpoint-format.ts`）；改 `queries.ts:19`。
- 把 live `setPinned` 从 `entries.ts` 解耦（让 `routes/history/handler.ts` 经一个瘦 facade 或直接调 `v3/store setV3OperationPinned`）。
- 门槛：全绿。此阶段纯移动，无行为变化，byte-equivalent 消费者。

**Phase 1 — 迁移测试离开 V2 写链（最难，先于删除）**
- 把依赖 `attachHistorySink`/`insertEntry`/`finalizeEntry` 驱动 history 的测试改为驱动 **V3 终端总线**（`publishModelOperationTerminal`）；或明确判定这些是纯 V2 行为测试 → 随代码删。
- 改 `test-bootstrap.ts:49,76` 不再 `attachHistorySink`。
- 判定 `queries.ts` in-flight merge 去留（§D-2）——若移除，同步改读测试。
- 门槛：全套件绿（此阶段不删 src，只改 test 驱动方式，便于隔离回归）。

**Phase 2 — 删死 backfills + 死读写 + 死 agg/stats/search-query/read**
- 删：6 个 backfill、`read.ts`、`sqlite/stats.ts`、`sessions-agg.ts`、`search-query.ts`、`search-index-write.ts`（剩余）。
- 同步删 `isolated-fixture.ts` 里对应 backfill resetter 注册（`isolated-fixture.ts:49-54`），并让 L1 守卫 `tests/infra/resetters-complete.unit.test.ts` 仍绿（它校验 RESETTERS 表完备——删注册项后须同步）。
- 门槛：typecheck + 全套件绿。

**Phase 3 — 删 V2 写链主体**
- 删 `HistorySink`（`sinks/history.ts`）、`entries.ts` V2 部分、`sqlite/write.ts`、`serialize.ts`、`sqlite/reaper.ts`、`persist-guard.ts`（除非 §D-5 决定采纳保留）。
- 删 `in-flight.ts`（若 §D-2 判定其读贡献为死支）或保留瘦身版。
- 清 `store.ts`/`index.ts` barrel 里失效 re-export。
- 门槛：typecheck + 全套件绿。

**Phase 4 — 拆 `connection.ts` V2 body + 删 schema/migrations/meta/archive**
- `connection.ts` 手术：删 `SCHEMA_SQL` import/exec、`migrateEntriesColumns`、`dropLegacyFtsAndSearchText`、`reclaimOrphanedActiveRows`、`distinctActiveOwnerPids`、`hasLiveForeignOwner`；DB-health 三件套按 §D-4 决定（留着接 V3 或暂留）。**注意 `:memory:` 分支**——测试若还靠 `openInMemoryDatabase` 建 V2 表会炸，须先确认无残留 V2 表测试（已在 Phase 1/2 清）。
- 删 `schema.ts`、`meta.ts`、`migrations/`（除非 §D-3 保留框架）、`archive-worker.ts`（§D-1）。
- 删对应 sqlite 测试文件（见 §E）。
- 门槛：typecheck + 全套件绿；真起一个非 4141 端口测试实例确认 V3 开库/读写正常。

**Phase 5 — doc-sync + 归档**
- 更新 `docs/DESIGN.md`「活的架构现状」表（删 V2 行）、`docs/API.md`（history 端点若有 V2 描述）、把 `docs/spec/2026-04-17-sqlite-history-persistence-design.md`、`docs/spec/migration-framework-umzug.md`、`docs/spec/search-text-slim-drop-fts.md`、`docs/spec/operational-stats-and-lineage-removal.md`、`docs/spec/history-finalize-async-offload.md`、`docs/rfc/2026-07-07-history-data-model-restructure.md` 等 V2 文档移 `docs/archive/` 并加「V2 已移除」注解。
- 跨文档 grep `entries_v2|history/sqlite|insertCompletedEntry` 验证无悬挂引用。

---

## D. 待用户裁决的开放问题

**D-1. `archive-worker.ts`（三层降温归档）真的一起删吗？** 它 src 内零 live 消费者，但记忆库记它「已合并 master」，且 `docs/decisions/2026-07-14-tiered-archive-cold-format.md` 是 ADR。判断：它是 V2-tier（作用于 entries_v2 世代 sealed unit），V3 用内容寻址无分层归档。**倾向删**（无 live 接线 + 绑 V2），但因是 ADR 决策产物，请用户确认是否 (a) 删并归档 ADR，还是 (b) 保留代码作为 V3 未来分层归档的采纳基础。

**D-2. `queries.ts` 的 in-flight merge 是死支吗？pending/streaming 请求在生产 list 里可见吗？** 生产 HistorySink 未挂 → 无人 `putInFlight` → in-flight 恒空 → 读面 merge 实为死码。含义：**当前 master 生产的 history list 可能根本不显示进行中的请求**（只显示 V3 终端已落库的）。这可能是既有 gap。请用户确认：(a) pending 可见性本就不需要 / 由别的机制（TUI live 面板？WS？）承担 → in-flight.ts 读贡献可删；(b) 需要 → 那是独立 follow-up，需把 in-flight 接到 V3，此时 in-flight.ts 保留。**我不替用户拍板删 in-flight。**

**D-3. Umzug 迁移框架保留吗？** V3 现用裸 `exec(V3_SCHEMA_SQL)` 无版本化迁移。长期看 V3 schema 会演进，届时需要迁移框架。选项：(a) 随 V2 一起删，V3 未来另起；(b) 保留 `migrations/` 框架（剥掉 V2 具体迁移），作为 V3 采纳的基础设施。倾向 (b) 保留框架骨架——但它依赖 `meta.ts`/`schema.ts` 的 `HISTORY_META_DDL`，保留需一并保留 meta 的一小块。

**D-4. DB-health 三件套（WAL checkpoint / incremental vacuum / startup VACUUM / ANALYZE）接到 V3 吗？** 当前 V3 open 路径（`connection.ts:82` v3Only 提前 return）**完全不跑**这些——V3 库无空间回收/checkpoint/planner-stats。这是长期健康缺口。倾向：本次保留这些函数，**开 follow-up 把它们接到 V3 的 open + 一个 V3 维护 tick**（而非跟 V2 一删了之，符合项目「long-term-wins」）。

**D-5. `persist-guard.ts`（never-throw 写守卫）采纳到 V3 吗？** V3 写有自己的错误处理。是否统一到 persist-guard 的 transient/permanent 分类 + 错误统计？倾向采纳统一，但属独立改进，可 defer 到 backlog。

---

## E. 测试文件处置

**随代码删（V2 独占）**：`tests/history/sqlite/` 下 `write-read`、`serialize`、`pid-column`、`raw-path-column`、`entry-indexes`、`scoped-delete`、`legacy-fts-decommission`、`migrations`、`reaper-move`、`finalize-async-golden`；`tests/history/{per-attempt-error-body,leg-stages,restructure-repoint-gate}`；`tests/restart/reclaim-liveness.it.test.ts`（V2 reclaim）。（共 57 个 history 测试，需逐个分类，上表为确定项。）

**保留但改（共享 infra）**：
- `tests/history/sqlite/compression.unit.test.ts` → 随 compression relocate 改 import 路径，**保留**（V3 在用）。
- `tests/history/sqlite/v3-path-isolation.it.test.ts` → 校验 V3 库不碰 legacy，**保留**（删 V2 后仍有意义，可能需调整断言）。
- `tests/helpers/isolated-fixture.ts` → 删 backfill/archive resetter 注册（line 48-54）。
- `tests/helpers/test-bootstrap.ts` → 停止 attachHistorySink（Phase 1）。
- `tests/infra/resetters-complete.unit.test.ts`（**L1 完备守卫**）→ 删注册项后必须仍绿；这是防「reset 表漏项」的地基，改 RESETTERS 表后同步它。

**风险点重述（§6）**：
- **① 最大风险：`test-bootstrap.ts` 的 HistorySink 依赖。** 它是许多测试的地基，用 V2 写链 populate history 再断言。删 HistorySink 前必须先把这些测试迁到 V3 终端总线驱动，否则大面积红。**这是本次重构从「删除」变成「迁移+删除」的根本原因。** 建议 Phase 1 单独成阶段、单独 review。
- **② `connection.ts` 的 `:memory:` 非 v3Only 分支**：测试历来靠 `openInMemoryDatabase` 拿到带 entries_v2 的库。手术后 :memory: 不再建 V2 表，任何残留假设 V2 表存在的测试会炸——须在 Phase 1/2 清干净。
- **③ 误删 `driver.ts`/`compression.ts` = 打爆 telemetry / thinking-quarantine / raw / V3。** 已核实 4+ 非-V2 消费者，务必 relocate 而非 delete。
- **④ barrel（`store.ts`/`index.ts`）是前端 `~backend/*` 公共面**：前端只 import 类型 + `entry-view` + `accumulate-response`（均 V3-compatible，无直接 V2 模块 import），故**前端零 repoint**——只要 barrel 保持导出同名 V3-shaped 类型即可。删 barrel 里失效函数 re-export 时别误删类型导出。

---

## 一句话结论

V2 不是可 clean-delete 的孤岛，而是「一坨真死码（backfills / read / write / serialize / agg / schema / migrations，无 live 消费者）+ 数处与 V3/live/测试缠绕的接缝（`connection.ts` 手术、`entries.ts` 手术、`driver.ts`/`compression.ts` 必留搬迁、`queries.ts` in-flight 与 `formatFromEndpoint` 依赖、`HistorySink`+`test-bootstrap` 测试地基迁移）」。最大工作量与风险在**测试从 V2 写链迁到 V3 终端总线**（Phase 1），而非删除本身。config 层零改动。5 个开放问题（archive-worker / in-flight pending 可见性 / Umzug 框架 / V3 DB-health / persist-guard 采纳）需用户裁决，尤其 D-2、D-4 涉及是否顺手补 V3 的既有缺口。

---

## 用户裁决（2026-07-15）—— 供 planner 转化为分阶段计划

**背景**：feat/history-cas-stage 的 20-task V2 内容寻址重构完成 + 终局 review Approved，但合并时发现 peer 的 History V3 cutover 已使 V2 层整体下线（V3 成唯一在线 store、自带更完整无损 CAS）。该分支不合并、作废存档。新方向 = 从 master 移除 V2。

**裁决**：
1. **可采纳模块——保留 + 采纳进 V3**：
   - `persist-guard`（never-throw 写守卫）→ 接 V3 write 路径。
   - **Umzug 迁移框架骨架** → 保留供 V3 将来 schema 版本化演进（V3 现用裸 `exec(V3_SCHEMA_SQL)`）。
   - **DB-health 三件套**（WAL checkpoint / VACUUM / ANALYZE）→ 接 V3 open 路径（**V3 现完全不跑、无空间回收，是真实长期健康缺口**）。
2. **archive-worker（三层降温归档）——删**（src 内零 live 消费者；需时从 git 取回、有 ADR 存档）。
3. **V3 缺口处置 = 移 V2 + 顺手补**：本次不仅移除 V2，还把保留的 DB-health / persist-guard **实接到 V3 open/write 路径**（一次到位，不只 backlog）。D-2（in-flight 可见性）仍作独立缺口——planner 评估是否纳入或写 backlog。
4. **执行方式**：先写完整分阶段计划（本 planner 任务）→ 异模型对抗 review → 新建 master 基础 worktree（已建 `feat/history-v2-removal`）subagent-driven 执行。

**承重纪律（planner 必须落进计划）**：
- 每 phase commit 终态绿（commit-invariants，中间态绝不半坏）。**最大手术面 = Phase 1 把测试从 V2 HistorySink 迁到 V3 终端总线**（attachHistorySink 仅 tests，删 V2 前必先迁测试，否则 history e2e 测试全塌）。
- 保留 + 搬迁：driver.ts（createDatabase，4+ 非-V2 消费者）、compression.ts（V3 store.ts:11 直接依赖）、lifecycle-state.ts（ACTIVE_STATES）。
- 手术（混 V2 与 live/V3）：connection.ts（V3 靠它开库但混 entries_v2 schema/migrate/reclaim/VACUUM，v3Only 分支隔离；`:memory:` 非 v3Only 注意）、entries.ts（V2 写链 + live setPinned→V3 被 routes/history/handler.ts:163 调）、barrel store.ts/index.ts。
- 前端零 repoint（ui-v4 只 import barrel 类型 + entry-view + accumulate-response，全 V3-compatible）。
- doc-sync：DESIGN.md history 行、docs/API.md history 端点、V2 spec/docs 归档。
