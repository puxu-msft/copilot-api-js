# History V2 层移除 —— 实施计划

状态：**✅ LANDED on master（06d928b3，2026-07-19）** —— Phase 0-5 全部落地 + 死事件清理 + 跨模型 review approved（0 blocker）+ 两轮合并 master（c9a2b6a9 compact-storage/timing/diagnostics、06d928b3 Tantivy 搜索 sidecar），经异模型 reviewer + 亲验:merge 解决零缺陷、payload-read 补全无过度、无回归（`test:backend` 全绿 5489 pass；6 个 `.e2e.test.ts` 失败经纯父分支复现确证 pre-existing、已记 backlog）。本地 master FF a387a6da→06d928b3（未推 origin,主 worktree WIP 完好）。分支 `feat/history-v2-removal`（off `master` @ `5187c386`），worktree `.worktrees/v2-removal/`。Phase 3 详见执行报告 `.superpowers/sdd/phase3-report.md`。Phase 4（connection.ts 手术 + schema/migrations/archive-worker 处置 + 三项采纳真接线，子步骤 4a→4d→4b→4c，commits `763b2805`/`1cfaab64`/`a0eaf912`/`aeb27a15`）详见 `.superpowers/sdd/phase4-report.md`。Phase 5（doc-sync + 归档，commit `a09a6058`）：history.md 重写为 V3-primary、4 份 V2-history spec 归档、DESIGN/API/README/lifecycle 死引用修、backlog 补 D-2/step-6、断链 gate 通过。

依据：[docs/todo/v2-removal-scope.md](../../todo/v2-removal-scope.md)（blast-radius 逐文件裁决表 + 2026-07-15 用户裁决）。本计划把裁决转化为可执行、可 subagent-driven 的分阶段 TDD 计划。裁判轴：长远正确 + 完整（against-YAGNI）——采纳进 V3 的 DB-health / persist-guard 是**本次必做项**，不是 backlog。

## 0. 目标（Goal）

1. 从 `src/lib/history/` 删除整个 V2 写链 + V2-only 读面（`entries_v2`/`entry_stages`/`response_sessions` 表及其读写代码），History V3（`history-v3.db`，CAS/manifest/tracks/timeline/journal/search，见 skill `history-sqlite-schema`）成为唯一持久化实现。
2. **不仅删除，还把三块用户裁决保留的基础设施真正接入 V3**（一次到位）：
   - `persist-guard.ts`（`runHistoryWrite`/`runHistoryWriteAsync`，never-throw + transient/permanent 分类 + per-stage 计数）包住 V3 的写路径（`enqueueModelOperation`/`commitPreparedOperation`/`recoverV3Journal`）。
   - DB-health 三件套（`checkpointWal`/`incrementalVacuum`/`maybeVacuumOnStartup`/`runOptimize`/`seedAnalyzeIfNeeded`，现居 `connection.ts`）接入 V3 的 `openDatabase` 路径（当前 `v3Only` 分支在 `connection.ts:80-82` 提前 `return`，完全跳过这些调用）与一个新的 V3 periodic maintenance tick（对标已删除的 V2 reaper tick）。
   - Umzug 迁移框架骨架（`migrations/{index,run,storage}.ts`）保留，**首次真正接线**到 `initHistory` 的 V3 open 路径（当前 `applyForwardMigrations` 全仓零生产调用点——已核实：`start.ts`、`history/state.ts`、`telemetry/db.ts` 均未 import，是从未接线的骨架）。
3. `archive-worker.ts`（三层降温归档）删除——src 内零 live 消费者，ADR 存档，需要时从 git 历史取回。
4. 迁移测试地基（`attachHistorySink` 的所有测试消费者）离开 V2 写链，落到 V3 终端总线（`publishModelOperationTerminal`）或已有的 `commitV3HistoryEntry` 测试 fixture；V2-behavior-only 的测试随代码删除。
5. 每个 phase 的最终提交树保持 GREEN（`bun run typecheck` + `bun run test:backend` 全绿）；不留半坏中间态。
6. doc-sync：`docs/DESIGN.md`「活的架构现状」history 行、`docs/API.md` History REST 段、V2 专属 spec/RFC 归档。

## 1. Architecture-after（重构后形态）

```
src/lib/history/
  types.ts                 keep-shared（类型 SSOT，V3-shaped）
  entry-view.ts            keep-shared（核心投影，V3读/TUI/前端共用）
  normalize-message.ts      keep-shared（search 归一化）
  lifecycle-state.ts        keep-shared（ACTIVE_STATES）
  accumulate-response.ts    keep-shared
  in-flight.ts              keep（生产恒空的 facade，见 §6 D-2 裁决）
  queries.ts                 surgery 后 keep（读面，剥离 formatFromEndpoint 依赖）
  sessions.ts / search.ts / stats.ts / search-types.ts   keep-shared（已全 V3）
  entries.ts                 surgery 后瘦身为 in-flight facade + setPinned（V2 写链整体删除）
  persist-guard.ts           keep + ADOPT（新增 V3 写路径消费者）
  state.ts                   keep + 扩展（接入 Umzug + DB-health 到 V3 open 路径）
  store.ts / index.ts        surgery（barrel，剥失效 re-export）

  sqlite/
    driver.ts                keep-relocate → lib/sqlite/driver.ts（中性位置，4+ 非V2消费者）
    compression.ts           keep-relocate → lib/sqlite/compression.ts（V3 store.ts:11 直接依赖）
    connection.ts            surgery（大幅瘦身：只留 open/close/getDatabase + DB-health 函数，
                              删 SCHEMA_SQL/dropLegacyFts/migrateEntriesColumns/reclaimOrphaned*/
                              distinctActiveOwnerPids/hasLiveForeignOwner；v3Only 分支成为唯一路径）
    schema.ts                delete（entries_v2/response_sessions/entry_stages/HISTORY_META_DDL 随框架去留见 §6 D-3）
    meta.ts                  delete（除非 §6 D-3 选择保留 Umzug 骨架 → 则保留其 history_meta KV 原语，改名/瘦身）
    migrations/{index,run,storage}.ts   keep + RELOCATE 概念性保留，改造为对 V3 生效（见 §5）
    write.ts / read.ts / serialize.ts / reaper.ts   delete（V2 写链主体）
    {cache-write,usage-normalize,response-preview,search-index,calibration,legacy-stage}-backfill.ts   delete
    search-index-write.ts    surgery（抽出 formatFromEndpoint → entry-view.ts，其余删）
    search-query.ts / sessions-agg.ts / stats.ts   delete
    archive-worker.ts        delete

  v3/{store,projection,index,terminal-bus}.ts   keep-shared，store.ts 新增 persist-guard 包裹 + DB-health 接线

src/lib/observability/sinks/history.ts   delete（HistorySink 类 + attachHistorySink，仅 tests 消费）
```

## 2. 全局约束（Global Constraints）

- **C1 提交纪律**：每 phase 结束提交一次，`bun run typecheck` clean + `bun run test:backend` 全绿（或该 phase 明确圈定的相关测试子集全绿 + 全量套件在下一 phase 结束前追平）。禁止半坏中间态落盘。
- **C2 顺序纪律**：消费者先搬迁，被消费者才能删。具体锁定顺序：Phase 0（搬迁/剥离）→ Phase 1（测试脱离 V2 写链，最大手术面）→ Phase 2（删死 backfill/read/agg/search-query）→ Phase 3（删 V2 写链主体）→ Phase 4（connection.ts 手术 + schema/migrations/archive 处理 + Umzug/DB-health/persist-guard 真接线）→ Phase 5（doc-sync）。
- **C3 `:memory:` 陷阱**：`connection.ts:68` 判断 `v3Only = dbPath !== ":memory:" && basename === "history-v3.db"` —— **`:memory:` 当前不是 v3Only**，故测试经 `openInMemoryDatabase()` 历来会建 V2 表。Phase 4 删 V2 schema 分支后，`:memory:` 必须无条件走 v3Only 路径（不再存在"非 v3Only"分支）。Phase 1/2 必须先清空所有依赖 `:memory:` 建出 V2 表的测试，否则 Phase 4 一到全红。
- **C4 前端零改动**：`ui-v4` 只经 `~backend/*` re-export `store.ts`/`entry-view.ts`/`accumulate-response.ts` 的类型与 V3-shaped 函数，barrel 手术只删函数级 re-export，不动类型导出。每次改 `store.ts`/`index.ts` 后跑 `bun run typecheck:ui-v4`。
- **C5 L1 完备性守卫**：`tests/infra/resetters-complete.unit.test.ts` 校验 `RESETTERS` 表与全仓 `*ForTest(s|ing)` 导出一一对应。每删一个 backfill/archive-worker，必须同步在 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 数组里删除对应条目，否则该守卫测试变红。
- **C6 采纳非可选**：persist-guard/DB-health/Umzug 三项"保留"不是"留着不动"，是"必须在 Phase 4 结束前接入 V3 并有独立测试证明其确实运行"（见 §5）。任何一项若因时间/难度想推迟到 backlog，属于范围收缩——按 `ask-if-scope-shrink` 必须先问用户，不得自行降级。

## 3. 分阶段计划

### Phase 0 —— 搬迁 keep-relocate / 剥离共享依赖（不删任何东西）

**目标**：把会被后续 phase 误伤的"真活代码"先移出 V2 品牌目录 / 剥离出共享函数，此阶段不删除任何文件、纯移动 + 改 import，行为零变化。

**文件改动**：
- `src/lib/history/sqlite/driver.ts` → `src/lib/sqlite/driver.ts`（新建 `src/lib/sqlite/` 目录）。改 import 的消费者：`src/lib/telemetry/db.ts:17`、`src/lib/anthropic/thinking-quarantine/store.ts:7`、`src/lib/history/raw/manager.ts:8`、`src/lib/history/sqlite/connection.ts:9`、`src/lib/history/sqlite/migrations/{index,run,storage}.ts`（若引用 `SqliteDatabase` 类型）。
- `src/lib/history/sqlite/compression.ts` → `src/lib/sqlite/compression.ts`。改 import：`src/lib/history/v3/store.ts:11`、`src/lib/history/sqlite/connection.ts`（若引用）、`tests/history/sqlite/compression.unit.test.ts`（改路径，保留测试，V3 仍用）。
- `formatFromEndpoint`（`sqlite/search-index-write.ts:84-96`）搬到 `src/lib/history/entry-view.ts`（或新建 `src/lib/history/endpoint-format.ts`，因 `entry-view.ts` 已经很大——**建议新建独立小文件**，避免把 V2 品牌目录的搬迁变成继续膨胀 keep-shared 大文件）。改消费者：`src/lib/history/queries.ts:19,96`。
- `entries.ts` 的 `setPinned`（entries.ts:359-370）在此阶段**不**物理搬迁（依赖 in-flight facade，Phase 3 才连带瘦身处理），本阶段只确认 `routes/history/handler.ts:163` 的调用契约不变（占位记录，Phase 3 执行）。

**测试**：无新测试（纯移动）。运行既有全套件确认零回归。`tests/history/sqlite/compression.unit.test.ts` 改 import 路径后必须仍绿。

**Commit-invariant**：`bun run typecheck` clean；`bun test` 全绿；`git diff --stat` 应只显示"重命名+import 路径"级别的改动（用 `git diff --cached --stat` 核对每个改动文件的改动行数与"纯移动"的预期相符，参考记忆 `sed-touched-files-bundle-inflight-work` 的对账纪律）。

**风险**：`driver.ts`/`compression.ts` relocate 若漏改任何 import 会在 typecheck 阶段立刻暴露（不会静默通过），风险低。

---

### Phase 1 —— 测试脱离 V2 写链（最大手术面，最高风险，必须最先做完）

**背景事实**（已核实）：
- `attachHistorySink`（`observability/sinks/history.ts:372`）在生产从不挂载（`start.ts:409-410` 明文注释），唯一挂载点是 5 处测试代码：`tests/helpers/test-bootstrap.ts:49,76`、`tests/history/per-attempt-error-body.it.test.ts:49`、`tests/history/leg-stages.it.test.ts:500`、`tests/history/restructure-repoint-gate.it.test.ts:52`。
- `tests/helpers/test-bootstrap.ts` 的 `bootstrapTestRuntime`/`resetTestRuntime` 是 **5 个文件**间接依赖的地基：`tests/helpers/isolated-fixture.ts`（`useIsolatedRuntime()`，被全仓 `.it`/`.http` 测试广泛使用）+ `tests/infra/resetters-complete.unit.test.ts`。删除 `attachHistorySink` 前，必须先让 `test-bootstrap.ts` 不再依赖它。
- `insertEntry`/`updateEntry`/`finalizeEntry`/`persistEntryEager`/`persistEntryStatus`/`persistEntryStages`（`entries.ts`）目前是"V2 写链的公开 API 表面"，但這些函数名本身在 Phase 3 会连同 V2 写链一起消失——它们当前既是 in-flight facade 入口，也是 SQLite 落盘触发点。真正落盘副作用（`upsertHeadRow`/`insertCompletedEntry`）删除后，这些函数只保留"更新 in-flight map + 发 WS 事件"的语义（Phase 3 详述）。
- 直接调用 `insertEntry`/`updateEntry`/`finalizeEntry` 驱动"History 行为断言"（而非"V2 SQLite 内部结构断言"）的测试文件（`history-store.it.test.ts`、`history-summary.it.test.ts`、`history-ws-integration.it.test.ts`、`search-decommission.it.test.ts`、`sessions-agg.it.test.ts`、`search-index-write.it.test.ts`、`search-index-backfill.it.test.ts`、`tests/infra/management-routes.http.test.ts`、`tests/infra/debug-calibration-probe.http.test.ts`）**不需要迁移调用方式**——它们调用 in-flight facade（`entries.ts` 导出，Phase 3 后仍存在，只是内部实现变了）。它们的断言需要审查：断言"读回 SQLite 持久层"的部分（如 `queryEntryCount()` 来自 `sqlite/read.ts`，Phase 2 删除）需要改为读 V3（`listV3StoredOperations`/`getV3StoredOperation`）。

**分类判据**（严格执行，不可仪式化——按代码已锁定的契约分类）：
- **A 类：H 行为测试，机制随 in-flight facade 保留** —— 断言的是"insertEntry 后 getHistory 能查到"这类**行为契约**，且不直接触碰 `sqlite/*` 内部 API。这些测试**不改动调用方式**，只需把任何 `sqlite/read.ts`（Phase 2 删除）的直接读取换成 in-flight 层或 V3 facade 读取。清单：`history-store.it.test.ts`（`queryEntryCount` 换成不依赖 `sqlite/read` 的计数——见下方具体处理）、`history-summary.it.test.ts`、`history-ws-integration.it.test.ts`。
- **B 类：直接测试 V2 内部机制（序列化格式/reaper/迁移/FTS/持久化韧性），随代码删除** —— `tests/history/sqlite/{write-read,serialize,pid-column,raw-path-column,entry-indexes,scoped-delete,legacy-fts-decommission,migrations,reaper-move,finalize-async-golden}`、`tests/history/{per-attempt-error-body,leg-stages,restructure-repoint-gate}.it.test.ts`（这三个显式测 `assembleFullEntry`/`extractStagePayloads`/legacy stage adapter，是 V2 序列化契约测试非 History 行为测试）、`tests/restart/reclaim-liveness.it.test.ts`（V2 `reclaimOrphanedActiveRows`）、`tests/restart/vacuum-liveness.it.test.ts`（需核实是否测 V2 专属 VACUUM 触发路径抑或可迁移断言到 V3 open 路径——若后者，归入 D 类改造）。
  **补充两个易被兜底句吞掉、需显式点名的文件**：
  - `tests/history/finalize-async.it.test.ts`——已核实其 import 全为 V2 专属（`sqlite/read`/`sqlite/reaper`/`sqlite/write`/`sqlite/serialize`），测的是 `docs/rfc/history-finalize-async-offload.md` 的 I2/I4 不变量（`finalizing` re-entrancy 守卫、`pendingFinalizations` drain），随 `entries.ts` 的 finalize 机制 + 该 RFC 一起在 Phase 5 归档，**整体删除**，无需拆分。
  - `tests/history/persist-resilience.it.test.ts`——已逐用例核实全部 8 个 `test()` 断言的都是 V2 专属机制（`persistEntryStages` head-first FK 保护、`finalize` 的 transient-retain/reaper-drain、`finalize` 的 permanent-tombstone 降级、reaper 禁用时立即 tombstone、head-only 行读回、reaper tick 驱动 deferred finalize），import 同样全是 `sqlite/{read,reaper,write,serialize}`，**无 non-V2 用例需拆分保留，整体删除**。注意：persist-guard 本身（`runHistoryWrite`/`isTransientSqliteError` 分类逻辑）的**通用行为**测试在另一个独立文件 `tests/history/persist-guard.unit.test.ts`（测 `isTransientSqliteError`/计数/reset，不依赖 `sqlite/*`），该文件保留不动、Phase 4c 追加 V3 场景用例。
- **C 类：V2 专属 backfill/agg 测试，随代码删除**（Phase 2）—— `search-decommission.it.test.ts`、`sessions-agg.it.test.ts`（`sqlite/sessions-agg.ts` 无 live 消费者）、`search-index-write.it.test.ts`、`search-index-backfill.it.test.ts`、`usage-normalize-backfill.it.test.ts`、`cache-write-backfill.it.test.ts`。**例外**：这些文件里若混有真正测试 `queries.ts`/`entry-view.ts` 行为（non-V2）的用例，需拆出保留（人工逐文件核实，不可整体删）。
- **D 类：test-bootstrap 地基迁移** —— `test-bootstrap.ts` 不再 `attachHistorySink`；改为：`initHistory(true)` 后不装任何 sink（生产同款——V3 终端持久化由 `initHistory` 内部的 `subscribeModelOperationTerminals(enqueueModelOperation)` 完成，见 `state.ts:101`），`attachTelemetrySink` 保留。任何依赖"WS 广播 `history.entry_added`/`entry_updated`"的测试（`history-ws-integration.it.test.ts`）注意：这些事件目前**只由 `entries.ts` 的 `publishEntryAdded`/`publishEntryUpdated` 触发**（`historyState.publisher?.publish`），是 in-flight facade 语义（Phase 3 后仍在，未随 V2 SQLite 写链删除）——`attachHistorySink` 只是"把 request.* 事件翻译成 insertEntry/updateEntry 调用"的胶水层，测试若直接调 `insertEntry`/`updateEntry` 就不依赖这层胶水，可以继续工作。**这是本 phase 的核心洞察**：`attachHistorySink` 本身可删，但它调用的 `entries.ts` facade API 不删（Phase 3 瘦身但保留），所以大部分"看似依赖 HistorySink"的测试其实依赖的是 facade，删 HistorySink 不会破坏它们。
- 唯一**真正**依赖 `attachHistorySink`（订阅 `request.*` 总线事件、驱动整条 ctx 生命周期）的测试是 B 类里的 `leg-stages`/`per-attempt-error-body`/`restructure-repoint-gate` 三个——它们的价值是测 V2 序列化契约（extractStagePayloads/assembleFullEntry），随 V2 删除，**不做行为迁移**。

**具体动作**：
1. 改 `tests/helpers/test-bootstrap.ts`：`bootstrapTestRuntime`/`resetTestRuntime` 移除 `attachHistorySink` 调用与 import；`detachSinks` 只保留 `attachTelemetrySink(bus)`。
2. 审查 A 类 3 个文件，把任何 `~/lib/history/sqlite/read` 的 import（`history-store.it.test.ts:42 queryEntryCount`）换成不依赖被删模块的等价断言——`totalEntryCount()`（history-store.it.test.ts:80-86）当前是 `queryEntryCount() + listInFlightEntries().length`，Phase 3 后 in-flight facade 的持久化落到 V3，等价读法是 `listV3StoredOperations().length + listInFlightEntries().length`（或直接用 `getHistory({}).total`，更贴近行为契约、不碰内部实现）。**建议**：改用 `getHistory({}).total`（已存在的公开 API），比自造计数函数更贴合"行为测试"定位，也更抗未来实现变化。
3. 迁移/删除 B/C 类测试文件（B 类删除；C 类需人工逐文件核实混入的非-V2 断言后再删，若发现混入的 non-V2 断言应先抽出到独立测试文件保留）。
4. `tests/restart/vacuum-liveness.it.test.ts`：核实其断言目标（VACUUM 触发条件）是否可搬到 V3 open 路径断言 —— 若可行，本阶段先标记 TODO，实际改造挪到 Phase 4（DB-health 接线时一并处理，避免本阶段跨越到写实现）。

**测试**：本阶段是"改测试驱动方式"，不删除 `src/` 下任何代码（`src/` 保持 Phase 0 后的状态）。跑全套件确认：删除 HistorySink 调用后 A 类文件仍绿；B/C 类删除后其余套件不受影响；`tests/observability/sink-ordering.unit.test.ts`（测 HistorySink→TelemetrySink→WsSink 顺序契约）需要核实——若断言的是"一个 fake HistorySink"（非真实 `attachHistorySink`），无需改动；若真实调用 `attachHistorySink`，随 HistorySink 类在 Phase 3 才物理删除，本阶段暂不动它（先完成测试驱动迁移，B/C 类删除，Phase 3 再删 `sinks/history.ts` 本体 + 相应调整 `sink-ordering` 测试）。

**Commit-invariant**：`bun run typecheck` clean；`bun run test:backend` 全绿（**这是最关键的门槛**——本 phase 结束时，`src/` 还是 V2 齐全的状态，但没有任何测试再依赖 `attachHistorySink` 驱动 History 断言，Phase 3 删除 HistorySink 类才不会引发级联失败）。

**风险与回滚**：本 phase 若发现某个"看似 A 类"的测试其实深度依赖 V2 内部字段（如断言 `entry_stages` 表结构），需要重新归类为 B 类处理，不可强行留在 A 类硬凑。若牵涉面超出预估（本 phase 是文档裁决里明确点名的"可能是最大工作量"环节），允许拆成 Phase 1a（test-bootstrap 迁移 + A 类改造）/ Phase 1b（B/C 类分类删除）两次提交，只要 Phase 1a 结束时树已绿。

---

### Phase 2 —— 删除死 backfill / 死读写 / 死 agg/stats/search-query/read

**文件删除**：
- `src/lib/history/sqlite/{read,stats,sessions-agg,search-query}.ts`
- `src/lib/history/sqlite/{cache-write,usage-normalize,response-preview,search-index,calibration,legacy-stage}-backfill.ts`
- `src/lib/history/sqlite/search-index-write.ts`（`formatFromEndpoint` 已在 Phase 0 搬出，此处删剩余部分）
- 对应测试（Phase 1 中已分类为 C 类的文件，本阶段物理删除；`tests/history/sqlite/{entry-indexes,pid-column,raw-path-column,scoped-delete}.unit.test.ts` 若未在 Phase 1 处理，本阶段删除——它们测的是 `write.ts`/`read.ts` 内部列结构）。
- `response-preview-column.test.ts`（`src/lib/history/sqlite/response-preview-column.test.ts`，用 `querySummaries` from `sqlite/read`）随 `read.ts` 一起删。

**同步动作**：
- `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表删除对应条目：`resetCacheWriteBackfillForTests`、`resetCalibrationBackfillForTests`、`resetLegacyStageBackfillForTests`、`resetResponsePreviewBackfillForTests`、`resetSearchIndexBackfillForTests`、`resetUsageNormalizeBackfillForTests`（连同其 import）。
- `state.ts:161` 的 `startHistoryBackfills()`（已是空 no-op）保留不动（不属于本 phase 范畴，其调用点 `start.ts:598` 与 `store.ts` barrel 导出不变——若一并清理见 Phase 5 doc-sync 順手项，非必须）。

**测试**：typecheck 会自然暴露任何残留 import；跑 `bun run test:backend`。

**Commit-invariant**：typecheck clean + 全套件绿 + `tests/infra/resetters-complete.unit.test.ts` 绿（验证 RESETTERS 表同步）。

**风险**：`queries.ts` 仍 import `formatFromEndpoint`（Phase 0 已搬到独立文件），确认无残留旧路径 import。

---

### Phase 3 —— 删除 V2 写链主体

**文件改动**：
- 删除：`src/lib/observability/sinks/history.ts`（`HistorySink` 类 + `attachHistorySink`，Phase 1 已确认测试零依赖）。
- 删除：`src/lib/history/sqlite/{write,serialize,reaper}.ts`。
- `src/lib/history/persist-guard.ts`：**不删**（用户裁决保留 + 采纳，Phase 4 才真正接入 V3；本阶段先只删除 `entries.ts` 里对它的调用，函数本体留待 Phase 4 改造消费者）。
- `src/lib/history/entries.ts`**大幅瘦身**（surgery，非整体删除）：
  - 删除：`insertEntry`/`updateEntry`/`finalizeEntry`/`persistEntryEager`/`persistEntryStatus`/`persistEntryStages` 中依赖 `sqlite/write.ts`（`insertCompletedEntry`/`upsertHeadRow`/`clearAllEntries`）、`sqlite/serialize.ts`（`extractStagePayloads`/`STAGE`）、`sqlite/reaper.ts`（`isReaperRunning`/`setReaperTickHook`）、`persist-guard.ts`（`runHistoryWrite`/`runHistoryWriteAsync`）的**落盘逻辑**。
  - **保留**（改名或原地精简）：in-flight map 操作（`putInFlight`/`publishEntryAdded`/`publishStatsChanged` 等）、`setPinned`（→ `setV3OperationPinned`，live，`routes/history/handler.ts:163` 消费）、`clearHistory()`（改为只清 in-flight + 调用 V3 的清空原语，见下）、`listInFlightEntries`/`listInFlightSummaries`/`getInFlightEntry`。
  - `finalizeEntry`/`doFinalizeEntry` 的 non-lossy retry 语义（transient 重试 / tombstone 降级）**是 V2 独有的机制**（`isReaperRunning()` 判据、`upsertHeadRow` tombstone 写）——V3 的落盘路径是 `v3/terminal-bus.ts` 的 `publishModelOperationTerminal`（生产同步注册在 `state.ts:101`），**不经过 `entries.ts` 的 `finalizeEntry`**。这意味着 `finalizeEntry`/`persistEntryEager`/`persistEntryStatus`/`persistEntryStages` 这四个函数在生产路径上**本来就是死码**（`HistorySink` 是唯一调用者，且从不在生产挂载）——本阶段确认后随 `HistorySink` 一并删除，而不是保留精简版。**唯一活的写入口是 `insertEntry`（in-flight 展示用）+ `setPinned`（V3 pin）**。
  - Phase 1 里被归为 A 类、断言"insertEntry/updateEntry/finalizeEntry 驱动 History 行为"的测试（`history-store.it.test.ts` 等）需要在本阶段重新审视：若 `finalizeEntry` 等函数确认为死码删除，这些测试的对应用例需要**跟随删除**（它们测的实际上是 HistorySink 时代的 in-flight→SQLite 生命周期，而非当前生产行为）。**这是本 phase 相对 Phase 1 初步分类的一次修正**——Phase 1 分类是保守估计，Phase 3 深入到 `entries.ts` 内部实现后才能精确判定哪些 in-flight facade 函数是真活码。
  - 重新核实后的存活集合：`insertEntry`（生产：无调用者！核实 `putInFlight` 生产调用点——已核实 `entries.ts:64` 是唯一 `putInFlight` 调用，而 `insertEntry` 本身生产也无调用者，因为 `HistorySink` 才是调用方）。**结论**：`entries.ts` 里除 `setPinned`/`listInFlight*`/`getInFlightEntry`/`clearHistory` 外，`insertEntry`/`updateEntry`/`finalizeEntry`/`persistEntry*` 在生产链路上全部随 `HistorySink` 一起失去唯一调用者，成为纯测试 API——**保留它们作为"测试注入 in-flight 状态"的工具函数**（in-flight map 是 `queries.ts` 读面合并的一部分，见 §6 D-2），但移除它们对已删除 SQLite 模块的调用，只保留 in-flight map 操作 + WS 事件发布。
- `clearHistory()` 改为：`clearInFlight()` + 清空 V3（新增 `clearAllV3ForTests()` 原语于 `v3/store.ts`，`DELETE FROM v3_operations/v3_objects/v3_journal/v3_search_*` 事务，供测试专用）+ 保留 `consola.warn` 提示 + 保留 `publishHistoryCleared`/`publishStatsChanged`。
- 剥离 `store.ts`/`index.ts` barrel 失效 re-export：删 `insertEntry`（若判定连测试都不再需要，视 Phase 1 结论而定——若仍需注入 in-flight fixture 数据则保留）、`drainPendingFinalizations`/`retryPendingFinalizations`/`finalizeEntry`/`persistEntry*`（若判定为死码则删除其 barrel 导出）。**保留**：`getInFlightEntry`/`listInFlightEntries`/`listInFlightSummaries`/`setPinned`/`clearHistory`/`__setTerminalWriterForTests`（若 `terminalWriter` 机制整体删除则此项也删）。
- **`state.ts` 的 `shutdownHistory` 收尾缝（显式手术步骤，不留给 typecheck 隐式暴露）**：`shutdownHistory`（`state.ts:140-156`）当前从 `./entries` import `drainPendingFinalizations`/`retryPendingFinalizations`，并在关库前依次 `await drainPendingFinalizations()` → `await retryPendingFinalizations()` → `await drainPendingFinalizations()`（RFC history-finalize-async-offload 的 I4 drain 语义，专为 V2 async finalize 设计）。这两个函数若判定为死码随 `finalizeEntry` 一起删除，**必须同步手术 `shutdownHistory` 函数体**：
  1. 删除对 `drainPendingFinalizations`/`retryPendingFinalizations` 的两次调用 + 对应 import。
  2. **保留**并理顺 V3 侧的等价收尾语义——`unsubscribeV3Terminal?.()` → `await drainModelOperationTerminalSubscribers()` → `await drainV3Writer()`（这三步是 V3 自己的 drain 链，与已删除的 V2 collection drain 完全独立，本来就不依赖 `entries.ts`，本阶段**不改动**这部分，只确认删除前两步后此处顺序仍然正确：先停订阅、再排空 terminal-bus 订阅者队列、再排空 V3 writer 队列、最后关库）。
  3. 新增/调整一个测试（可并入 Phase 4 的某个 V3 测试文件，或本阶段新建 `tests/history/state-shutdown.unit.test.ts`）显式断言 `shutdownHistory()` 精简后仍然：不早于 `drainV3Writer` 完成就关闭 db；不再引用任何已删除的 V2 collection 函数（typecheck 会自然捕获引用错误，但行为断言需要显式测试覆盖，不能只依赖"没有编译错误"）。

**测试**：本阶段是全仓最大一次结构性删除，需要重新跑一次 Phase 1 的 A/C 类归档结论——对每个仍标注"待重新审视"的测试文件，逐个确认其断言在瘦身后的 `entries.ts` 下是否仍成立，不成立的用例删除，成立的调整为读 V3。

**Commit-invariant**：typecheck clean + 全套件绿。

**风险**：本 phase 是"先设计后编码"里最容易出现范围误判的环节——`entries.ts` 表面上是"in-flight facade"，实际混入了不少只有 HistorySink 才触达的死码。执行者必须先用 `grep -rn "insertEntry(\|updateEntry(\|finalizeEntry(\|persistEntry" src --include=*.ts | grep -v test` 交叉核实生产调用点为空，再动手删，不可凭 Phase 1 阶段的粗判直接删代码（那时尚未深入验证 in-flight facade 内部真实死活边界）。

---

### Phase 4 —— `connection.ts` 手术 + schema/migrations/archive-worker 处置 + 三项采纳真接线

这是范围最广的收尾 phase，拆成 4a（connection.ts 瘦身 + schema 删除）/ 4d（Umzug 接线 + `initHistory` 改 async）/ 4b（DB-health 接线）/ 4c（persist-guard 接线）四个子步骤，每个子步骤单独提交，子步骤之间保持树绿。

**子步骤顺序为 4a → 4d → 4b → 4c**（非文档编号顺序，是实际执行顺序——理由）：
- **4d 先做**：`initHistory` 改 `Promise<void>` 是本次唯一一处**结构性**签名变化（返回类型变化会 ripple 到全仓所有调用点），越早定型越能让后续子步骤（4b 要在 `initHistory`/`shutdownHistory` 里加 maintenance tick 启停）踩在稳定的函数签名上写代码，不用等 4b/4c 写完后再回头补 `await`。
- **4b 次之**：主要改 `connection.ts`（`openDatabase` 尾部追加 DB-health 调用）+ `state.ts`（`initHistory`/`shutdownHistory` 里加 `startV3Maintenance`/`stopV3Maintenance` 调用，此时 `initHistory` 已是 async，直接顺接不需要二次改造）。
- **4c 最后**：只改独立文件 `v3/store.ts`（`commitPreparedOperation`/`runDrain`/`enqueueModelOperation`），**不触碰** `connection.ts`/`state.ts`，与 4a/4d/4b 的改动面完全不重叠，风险最低、放最后避免与前面步骤产生合并/审查噪音。
- **纠正一处过度陈述**：先前版本的 Cutover 表暗示"4b/4c/4d 都改同一批文件（state.ts/connection.ts）需顺序执行避免冲突"——**不准确**。实际改动面是：4b 主改 `connection.ts` +（`state.ts` 仅新增 tick 启停两行调用）；4c 只改 `v3/store.ts`，与 4b/4d 零重叠；4d 只改 `state.ts`（`initHistory` 签名 + 插入 `applyForwardMigrations` 调用）+ 全仓 `await` 补全。真正会碰到同一文件（`state.ts`）的是 4d 与 4b，故两者按顺序（4d 先）执行，4c 可与它们并行执行、不受影响。见下方修正后的 Cutover 表。

#### 4a. `connection.ts` 瘦身 + schema/archive-worker 删除

- 删除：`SCHEMA_SQL` import/exec、`dropLegacyFtsAndSearchText`、`migrateEntriesColumns`、`reclaimOrphanedActiveRows`、`distinctActiveOwnerPids`、`hasLiveForeignOwner`（`connection.ts:84-98,151-357,379-458`）。
- `openDatabase` 收窄为：mkdir → `createDatabase` → `assertV3Owner` → PRAGMA 五件套（含 `connection.ts:75` 的 `PRAGMA auto_vacuum = INCREMENTAL`，**该 PRAGMA 在 `v3Only` 分支判断之前就已无条件执行，故 V3 本来就享有它**——瘦身只是删除它之后、原本只对非-v3Only 分支生效的那段 V2 专属代码）→ **无条件**走原 `v3Only` 分支的逻辑（因为 V2 schema 分支已删，`:memory:` 也天然走这条路径——解决 C3 陷阱：不再需要 `v3Only` 判断，`openDatabase` 只有一条路径）。
- `assertV3Owner` 保留（针对"拒绝打开非 V3 owned 的既存文件"的安全网，逻辑不变）。
- 删除文件：`src/lib/history/sqlite/schema.ts`、`src/lib/history/sqlite/archive-worker.ts`。
- `meta.ts`：**取决于 §5/§6 D-3 的 Umzug 决定**——若保留 Umzug 骨架（本计划推荐保留），则 `meta.ts` 的 `getMeta`/`setMeta`/`deleteMeta`/`MIGRATIONS_RUN_KEY` 保留（改名去掉 backfill 专属常量，只留 Umzug 账本需要的部分）；`HISTORY_META_DDL` 从 `schema.ts` 搬到 `meta.ts` 自身（避免依赖已删除的 `schema.ts`）。
- 同步删除测试：`tests/history/sqlite/{legacy-fts-decommission,v3-path-isolation}.it.test.ts` 中依赖已删函数的用例（`v3-path-isolation.it.test.ts` 的两个测试断言"V3 不碰 legacy history.db"——这在瘦身后依然成立且更简单验证，**保留但简化**：无需再验证"非 v3Only 分支不执行"，因为该分支已不存在，改为验证 `openDatabase` 全程只操作 `history-v3.db` 路径）。
- `tests/helpers/isolated-fixture.ts` 删除 `resetArchiveWorkerForTests` 条目 + import。

**验证**：typecheck + 全套件绿；新增/调整一个测试显式断言 `openDatabase(":memory:")` 不再创建 `entries_v2` 表（`PRAGMA table_info(entries_v2)` 返回空数组）——这是 C3 陷阱的正面回归测试。

#### 4d. Umzug 骨架真接线到 V3（采纳 3/3，先于 4b/4c 执行——理由见上）

**背景**：`applyForwardMigrations`（`migrations/run.ts:49`）当前**全仓零生产调用点**（已核实 `start.ts`/`history/state.ts`/`telemetry/db.ts` 均未 import）——是从未激活的骨架，其设计（hybrid：地板 reconcile 不进账本，001+ 前向 DDL 才进 Umzug）原本是为 V2 `entries_v2` 设计，`MIGRATIONS` 数组当前为空。

**改造**：
- `HistoryMetaStorage`（`migrations/storage.ts`）依赖的 `history_meta` 表 DDL（`HISTORY_META_DDL`）在 4a 已从 `schema.ts` 搬到 `meta.ts` 自身——本阶段确认 V3 的 `openDatabase` 路径会创建这张表（在 V3_SCHEMA_SQL 之外新增一次 `db.exec(HISTORY_META_DDL)` 调用，或让 `HistoryMetaStorage` 构造函数的自建逻辑继续承担这个职责——**推荐后者**：不改动 `openDatabase`，让 `applyForwardMigrations` 调用点自带的 `HistoryMetaStorage` 构造自建 `history_meta`，与骨架原设计一致，零改动风险）。
- 在 `state.ts` 的 `initHistory` 中，`getDatabase().exec(V3_SCHEMA_SQL)` 与 `recoverV3Journal(getDatabase())` 之间插入 `await applyForwardMigrations(getDatabase())`（`MIGRATIONS` 仍为空数组——**首次接线的价值是让管线跑通并有测试证明"下次加 001 migration 时框架真的会执行"，而非本次新增任何具体 schema 变更**）。`initHistory` 本身是同步函数——**需要改造为 async**（这是本次唯一一处需要 ripple 的函数签名变化）。核实调用点：`start.ts:406`（顶层 async 函数内，加 `await` 零风险）、`tests/helpers/test-bootstrap.ts`（`bootstrapTestRuntime`/`resetTestRuntime` 已是可 async 调用环境，多处直接调用 `initHistory(true, ...)` 需补 `await`——全仓 grep 统计见下）、所有测试文件里裸调用 `initHistory(true, N)` 的地方需补 `await`（`beforeEach` 回调本身多为 `async`，改动是"补 await"级别的机械修改，不改变语义）。
- `MIGRATIONS`（`migrations/index.ts:64`）保持空数组不变（无新 schema 变更需求，这次只是"把水管接通"）。

**测试**：
- 新增 `tests/history/v3/migrations-wiring.it.test.ts`：
  1. 断言 `initHistory(true)` 后 `history_meta` 表存在于打开的 V3 db（`v3Only` 路径本不建 `history_meta`，这是**新增行为**，需要显式验证）。
  2. 注入一个非空的临时 `MIGRATIONS` 数组（通过测试内直接调用 `applyForwardMigrations(getDatabase(), testMigrations)`，绕开生产用的空数组）验证一条 DDL 迁移能对着已开启的 V3 db 成功执行、记账、幂等重跑不报错——这是"框架确实对 V3 生效"的核心证明，而非只是"接口存在不报错"。
  3. 断言 `initHistory` 全程仍是"迁移失败→rethrow→调用方可感知"（不能因为接入 V3 而悄悄吞掉迁移失败）。
- **全仓机械改动 + await 缺口的检测边界（已核实，措辞订正）**：`grep -rln "initHistory(" src tests --include=*.ts` 逐一确认调用点已加 `await`。检测手段按目录分层，不能只依赖一种工具：
  - **`src/` 下**：ESLint `@typescript-eslint/no-floating-promises` 在根 `eslint.config.js` 是 **error 级别**（`bunx eslint --print-config <file> | grep no-floating-promises` 实测输出 `[2]`，即报错而非警告）——`src/` 下任何遗漏 `await` 会让 `bun run lint:all` **直接失败退出**，是一道硬门槛而非可忽略的警告，必须清零才能收尾本 phase。
  - **`tests/**` 下**：`eslint.config.js:121` 对 `**/*.test.ts`/`tests/**/*.ts` 显式把 `@typescript-eslint/no-floating-promises` 设为 `"off"`——**测试文件里遗漏 `await` 不会被 lint 拦下**，也不是 TypeScript 类型错误（`Promise<void>` 的返回值不 await 在类型层合法），CI 不会兜底。这意味着测试文件里若有遗漏，会造成真实的时序 bug（例如某个 `beforeEach` 里 `initHistory(true)` 未 `await` 就紧接着 `getDatabase().exec(...)`，此时 db 可能尚未真正打开完成/迁移未跑完），且不会在 typecheck/lint 报错、只会在运行时随机 flaky。**执行者必须对 `tests/` 下的每个 `initHistory(` 调用点逐一人工确认补了 `await`，不能依赖 CI 兜底**（这是本阶段唯一一处"检测手段本身有盲区、需要人工过一遍 grep 结果"的步骤，务必按此执行而非假设 lint/typecheck 会自动兜底）。

#### 4b. DB-health 三件套接入 V3 open 路径（采纳 1/3，接在 4d 之后）

**V3 现状缺口（已核实、精确到函数级）**：
- `connection.ts:75` 的 `PRAGMA auto_vacuum = INCREMENTAL` 在 `v3Only` 判断**之前**就无条件执行——**V3 已经拥有这一句**，新库从第一次 open 起就是 `auto_vacuum=INCREMENTAL`。这不是本次要补的缺口，写测试时不要重复断言这句已生效的 PRAGMA，也不要在"制造高 freelist 场景"时忘记这个前提（见下方测试设计的数据量注意事项）。
- 真正缺的是两类：
  1. **一次性 open-time 维护**——`maybeVacuumOnStartup`（一次性 full VACUUM，仅当 freelist ratio ≥ 25% 且 ≥ 64MB 可回收时触发）与 `seedAnalyzeIfNeeded`（首次 `ANALYZE`，仅当 `sqlite_stat1` 表不存在时触发）：`connection.ts:80-82`（瘦身前）的 `v3Only` 分支在 5 条 PRAGMA 后直接 `return`，两者都从未在 V3 open 路径被调用。
  2. **周期性 tick 维护**——`incrementalVacuum`/`checkpointWal`/`runOptimize`：三者只被已删除的 `sqlite/reaper.ts` 调用，V3 目前没有任何 periodic tick 会调用它们（reaper 本身在生产也从未被启动，`startReaper`/`stopReaper` 全仓零生产调用点）。
  3. **不采纳**：`reclaimOrphanedActiveRows`/`hasLiveForeignOwner`/`distinctActiveOwnerPids`——V2 专属逻辑绑定 `entries_v2` 的 pid/status 列，V3 的 `v3_operations` 没有等价的"pid 存活行"概念（v3 只落终态，没有 pending/executing/streaming 状态），VACUUM 期间没有"别的进程正在写自己的行"这个并发风险维度（详见 §6 排除项讨论）。

**改造**：
- `openDatabase`（瘦身后的唯一路径，此时已由 4d 确认 `initHistory` 是 async 调用环境）末尾追加：直接跑 `maybeVacuumOnStartup(db, dbPath)`（不加 `hasLiveForeignOwner` 门槛，理由见上）+ `seedAnalyzeIfNeeded(db)`（无条件，函数本身已幂等守卫 `sqlite_stat1` 存在性）。
- 新增 V3 periodic maintenance tick（对标已删除的 V2 reaper tick，但职责收窄——不做"reclaim stale rows"，只做 DB 维护）：新建 `src/lib/history/v3/maintenance.ts`，导出 `startV3Maintenance(intervalSeconds)`/`stopV3Maintenance()`/`runV3MaintenanceTick()`，tick 内调用 `checkpointWal(db)` + `incrementalVacuum(db)` + `runOptimize(db)`（复用 `connection.ts` 现存的三个 export，签名不变）。在 `state.ts` 的 `initHistory`/`shutdownHistory` 中启停（此时 `initHistory` 已是 4d 定型后的 async 函数，新增两行 `startV3Maintenance(...)`/`stopV3Maintenance()` 调用即可，不再需要额外的签名改造）。
- 复用现有 config 项：`state.staleRequestMaxAge` 是请求上下文专属，不适用；改用一个新的、默认值合理的常量间隔（如 300 秒），**不新增 config 键**（config 层零改动的裁决延续——若用户希望可调，走 backlog，非本次范围）。

**测试（本阶段的核心验证——不能只是"删除干净"）**：
- 新增 `tests/history/v3/db-health.it.test.ts`：
  1. 用真实临时文件路径（非 `:memory:`）构造"高 freelist ratio"的 V3 库——**注意**：由于 `auto_vacuum=INCREMENTAL` 从 open 起就已生效（见上），普通的写入-删除循环可能被增量回收提前吃掉 freelist、导致断言脆弱；构造场景需绕开增量回收的"随写随收"效应，例如：单个事务内一次性写入大量数据后一次性大批量删除（而非多次小批量删除+incremental_vacuum 有机会介入的模式），确保 freelist 在下次 `openDatabase`（重新打开同一文件）时仍处于高比例状态，再断言 `maybeVacuumOnStartup` 触发、`freelist_count` 显著下降。
  2. 断言首次 open 后 `sqlite_stat1` 表存在（`seedAnalyzeIfNeeded` 生效）。
  3. 断言 `startV3Maintenance` 启动后，一次 `runV3MaintenanceTick()` 调用后 WAL 文件不再无限增长（可用一个短 interval + 等待一次 tick，断言 `checkpointWal`/`incrementalVacuum`/`runOptimize` 被调用，用注入的 spy 或直接断言其副作用 PRAGMA 状态）。
- 迁移 `tests/restart/vacuum-liveness.it.test.ts` 的核心断言到 V3 路径（Phase 1 标记的 TODO 在此收口）——若原测试断言"VACUUM 在存活共享库场景被跳过"，因不采纳 `hasLiveForeignOwner`，该场景检测点在 V3 不适用，改为断言"V3 open 无条件跑 maybeVacuumOnStartup（无共享库跳过语义）"，并在 doc 里记录这个行为差异（V2→V3 的 VACUUM 门槛简化，因 V3 无"多进程共享 pending 行"模型）。

#### 4c. persist-guard 接入 V3 写路径（采纳 2/3，独立文件、可与 4b/4d 并行，风险最低放最后）

**改造**：`src/lib/history/v3/store.ts`：
- `commitPreparedOperation` 内部**分两段处理，不可整体包裹**（这是本子步骤最容易踩错的地方）：
  1. **conflict-throw 分支（`store.ts:302-304`）不进 persist-guard**——`existing.revision === prepared.revision && existing.digest === prepared.digest` 判断为假时的 `throw new Error(`[history/v3] operation conflict: ${prepared.id}`)` 是一个**幂等冲突的编程错误信号**（同 operationId 出现了不同 revision/digest 的重复提交，意味着上游调用方违反了"同一 operation 只应以递增 revision 提交"的契约），不是"持久化层的瞬时/永久失败"，调用方（`runDrain`/未来的直接调用者）需要**感知这个 throw**、按现有语义计入 `status.conflicts`（`store.ts:305`，**已存在的独立计数器，与 persist-guard 的 `getHistoryPersistErrorStats()` 是两套不同维度的统计——conflict 计数不因接入 persist-guard 而重复计数或被吸收**）。若把这段也用 `runHistoryWrite` 包起来，conflict 会被静默降级成 `{ ok: false, transient: false }` 交回调用方，`status.conflicts` 的语义就从"编程错误、需要人工排查"退化成"和 SQLITE_BUSY 一样的普通持久化失败"——这是一个真实的行为回归，必须避免。
  2. **真正的持久化写（`store.ts:310`起的 journal insert + `store.ts:319-355` 的 `db.transaction`）才包 `runHistoryWrite`**——这段才是"SQLite 层面可能因 BUSY/LOCKED/IOERR/磁盘满 等瞬时或永久原因失败"的部分，用 `runHistoryWrite("v3-commit", () => { ...journal insert...; tx(); })` 包裹。
- `enqueueModelOperation`→`runDrain` 内对 `commitPreparedOperation` 的调用（`store.ts:378`起）现有 `try { ... } catch (error) { status = {...failedOperations...} }` 手写分类逻辑，改为 `runHistoryWriteAsync("v3-drain", async () => { const prepared = await ...; commitPreparedOperation(getDatabase(), prepared) })`——**但 conflict-throw 会从 `commitPreparedOperation` 内部穿透到这里**（因为 4c 明确不用 persist-guard 包 conflict 分支），故 `runDrain` 的这层包裹需要保留一个前置判断：conflict 类型的 Error（可用 message 前缀 `[history/v3] operation conflict:` 识别，或更稳妥地让 `commitPreparedOperation` 在 conflict 分支用一个自定义 Error 子类/带 `.isConflict` 标记的错误对象，供上层精确辨识而非脆弱的字符串匹配）应该**先**被识别并计入 `status.conflicts`（复用已有逻辑，**不**经过 persist-guard 的 transient/permanent 分类），只有非 conflict 的异常才交给 `runHistoryWriteAsync` 的 transient/permanent 分类路径。**推荐实现**：在 `commitPreparedOperation` 里定义一个 `class V3OperationConflictError extends Error {}`，conflict 分支 `throw new V3OperationConflictError(...)`；`runDrain` 里先 `catch` 判断 `instanceof V3OperationConflictError` 专门处理（复用现有 `status.conflicts` 逻辑），再把其余情形交给 persist-guard 包裹的路径。
- `getHistoryPersistErrorStats()` 的 per-stage key 会新增 `v3-commit:*`/`v3-drain:*` 前缀，与已删除的 V2 stage 名（`finalize`/`eager-head`/`stage`/`finalize-tombstone`）自然区分，也与 `status.conflicts` 是完全独立的两套计数器（不重复统计同一次失败）。
- **不动**：`prepareModelOperation`（纯函数，不涉及 IO）、`hydrateManifest`（读路径，读失败应直接抛而非 never-throw——读一个损坏的 manifest 是真正的数据完整性问题，与写守卫的"降级不阻断"语义不同，故**不**用 persist-guard 包读路径，只包写路径）。

**测试**：
- 新增 `tests/history/v3/persist-guard-wiring.it.test.ts`：
  1. 注入一个会抛 `SQLITE_BUSY`-classified 错误的 db mock（或直接 mock `db.prepare` 抛出一个 `Error("database is locked")` 实例），断言 `commitPreparedOperation`/`enqueueModelOperation` 遭遇该错误后不抛出（对调用方 never-throw），`getHistoryPersistErrorStats()` 中出现 `v3-commit:transient` 或 `v3-drain:transient` 计数递增。
  2. **新增：conflict 场景不被 persist-guard 吸收的回归测试**——构造同一 `operationId` 以不同 `revision`/`digest` 两次调用 `commitPreparedOperation`，断言第二次调用**仍然 throw**（不是被 persist-guard 降级为 `{ok:false}` 静默返回）、且 `status.conflicts`（经 `getV3StoreStatus()` 或等价读取途径）递增，而 `getHistoryPersistErrorStats()` 的计数**不**因这次 conflict 而增加（两套计数器互不越界）。
  3. `resetHistoryPersistErrorStats()`（已有）清零后正确重置（复用现有 persist-guard 测试 `tests/history/persist-guard.unit.test.ts` 的既有断言模式，追加 V3 stage 名的用例）。

**Commit-invariant（整个 Phase 4）**：typecheck clean + lint clean（尤其 4d 的 `src/` 下 floating-promise error 级别检查必须清零；`tests/` 下的 `await` 遗漏需人工 grep 核实，见 4d 测试节）+ 全套件绿 + 4b/4c/4d 各自的新增验证测试绿 + 真实非-4141 端口测试实例手动验证一次 V3 open/读写正常（可选人工验证步骤，不阻塞 CI 绿）。

---

### Phase 5 —— doc-sync + 归档

**动作**：
1. `docs/DESIGN.md`「活的架构现状」表：更新 `src/lib/history/` 一行，删除 V2 专属描述（reaper 分桶淘汰、启动 VACUUM 触发条件变化、search_index backfill、usage-normalize-backfill 等 V2-only 机制描述），改为描述 V3 + 本次新增的 DB-health/persist-guard/Umzug 接线现状（含 `lib/sqlite/driver.ts`/`lib/sqlite/compression.ts` 新路径）。SQLite driver 行（`| SQLite | ... | lib/history/sqlite/driver.ts |`）路径更新为 `lib/sqlite/driver.ts`。
2. `docs/API.md`「History REST」段：**已核实定案**——config 层不存在 `history.archive.*` 键（grep 全仓 config schema 确认零命中），archive tier 的拒绝逻辑已经是纯代码层面的固定拒绝：`src/routes/history/handler.ts:48` `rejectsRetiredArchiveTier` 对 `?tier=archive` 直接返回 `c.json({ error: "The built-in archive tier has been retired" }, 400)`。**`docs/API.md:123` 当前描述的是过时的 409 契约**（`history.archive.enabled=false` 或 Archive handle 未初始化时返回 `409 archive_unavailable`）——这段描述已经与当前代码（固定 400 "retired"）不符，需要在本 phase **订正为准确的 400 描述**，不需要任何 config 层改动（archive-worker 删除不产生新的 config 清理待办，见 §6 已改为定案结论）。
3. 归档到 `docs/archive/`（加"V2 已移除，仅存历史参考"批注）：`docs/spec/2026-04-17-sqlite-history-persistence-design.md`、`docs/spec/migration-framework-umzug.md`（**注意**：此文档描述的框架仍然存活并被本次接入 V3，只是不再是"未来 V2 迁移"语境——**不整体归档，改为更新其"现状"描述指向 V3**，避免误导）、`docs/spec/search-text-slim-drop-fts.md`、`docs/spec/operational-stats-and-lineage-removal.md`、`docs/spec/history-finalize-async-offload.md`（V2 async finalize 机制随 `entries.ts`/`sqlite/write.ts` 删除，此 spec 归档）、`docs/rfc/2026-07-07-history-data-model-restructure.md`、`docs/decisions/2026-07-14-tiered-archive-cold-format.md`（archive-worker 的 ADR——**不归档删除**，改为在文档顶部加"2026-07-XX：代码已删除，此 ADR 仅记录历史决策与取回方式"批注，ADR 本身不因代码删除而失效，它记录的是曾经的决策理由）。
4. skill `history-sqlite-schema`（`.claude/skills/history-sqlite-schema/SKILL.md`）：这份 skill 已经是 V3-only 描述（已读取确认：明确写"V2（history.db/archive.db）是退役取证用途，非在线 schema"），核实其"权威真相源"部分（`schema.ts`——已删除，需改指向 `v3/store.ts` 的 `V3_SCHEMA_SQL`）与"迁移"节（Umzug 现状描述需要更新为"已接线到 V3"而非骨架待接线）。
5. 跨文档 grep 验证：`grep -rn "entries_v2\|history/sqlite/read\|history/sqlite/write\|insertCompletedEntry\|attachHistorySink" docs/ src/ tests/` 应只剩归档文档 + 本计划文档自身的引用。

**Commit-invariant**：文档改动不影响 `bun run typecheck`/`test:backend`（纯文档 phase），但需要跑一次 `bun run test:backend`（design-doc-tree 之类的 doc 结构测试，见 `tests/infra/design-doc-tree.unit.test.ts`）确认文档结构测试仍绿。

## 4. Cutover / commit-invariants 一览表

| Phase | 主要动作 | 前置依赖 | Commit-invariant | 关键验证 |
|---|---|---|---|---|
| 0 | 搬迁 driver/compression/formatFromEndpoint | 无 | typecheck+test 绿 | 纯移动零行为变化，diff 对账 |
| 1 | 测试脱离 attachHistorySink，A/B/C 类分拣 | Phase 0 | typecheck+test 绿 | `test-bootstrap.ts` 不再 import HistorySink |
| 2 | 删死 backfill/read/agg/search-query | Phase 1 | typecheck+test 绿+RESETTERS 同步 | resetters-complete 守卫绿 |
| 3 | 删 V2 写链主体（HistorySink/write/serialize/reaper），entries.ts 瘦身，`state.ts` `shutdownHistory` 同步手术 | Phase 2 | typecheck+test 绿 | 生产调用点 grep 确认 insertEntry/finalizeEntry 无生产调用者后再删；`shutdownHistory` 不再引用已删除的 V2 collection drain 函数 |
| 4a | connection.ts 瘦身 + schema/archive-worker 删除 | Phase 3 | typecheck+test 绿 | `:memory:` 无条件走单一路径，无 entries_v2 表新回归测试 |
| 4d | Umzug 接线到 V3 open，`initHistory` 改 async（**先于 4b/4c 执行**——结构性签名变化先定型） | 4a | typecheck（`src/` 下 no-floating-promises error 级别必须清零）+lint+test 绿+专项测试绿 | 新测试证明非空 MIGRATIONS 数组能对 V3 db 真正执行迁移；`tests/` 下遗漏 `await` 不被 lint/typecheck 拦截，需人工逐点核实 |
| 4b | DB-health 接入 V3 open + 新 maintenance tick（改 `connection.ts` 为主，`state.ts` 仅追加 tick 启停两行） | 4d（依赖 `initHistory` 已是 async） | typecheck+test 绿+专项测试绿 | 新测试证明 VACUUM/ANALYZE/checkpoint 真的对 V3 生效；测试数据构造须绕开已生效的 `auto_vacuum=INCREMENTAL` 的随写随收效应 |
| 4c | persist-guard 包 V3 写路径（只改独立文件 `v3/store.ts`，与 4b/4d 改动面零重叠，可并行） | 4a（不依赖 4b/4d，可与它们同时进行） | typecheck+test 绿+专项测试绿 | 新测试证明 v3-commit/v3-drain stage 计数生效 + conflict-throw 分支不被 persist-guard 吸收（`status.conflicts` 与 persist-guard 计数互不越界） |
| 5 | doc-sync + 归档 | Phase 4 全部完成 | test 绿（doc 结构测试）| 跨文档 grep 无残留引用 |

## 5. 采纳（keep-and-adopt）子计划——V3 接线精确坐标

| 采纳项 | 源文件（保留） | V3 接线点（file:line，Phase 4a 瘦身后的坐标待重新核实，此处标注瘦身前的锚点函数名） | 新增验证 |
|---|---|---|---|
| DB-health 三件套 | `connection.ts`：`maybeVacuumOnStartup`/`seedAnalyzeIfNeeded`/`incrementalVacuum`/`checkpointWal`/`runOptimize` | `openDatabase` 内（原 `v3Only` 分支 `connection.ts:80-82` 提前 return 处，改为继续执行到 `maybeVacuumOnStartup`+`seedAnalyzeIfNeeded`）+ 新建 `v3/maintenance.ts` 的 periodic tick，挂载于 `state.ts` `initHistory`/`shutdownHistory` | `tests/history/v3/db-health.it.test.ts`（新建）：真实临时文件验证 VACUUM 生效 + ANALYZE 生效 + maintenance tick 生效 |
| persist-guard | `persist-guard.ts`：`runHistoryWrite`/`runHistoryWriteAsync`/`getHistoryPersistErrorStats` | `v3/store.ts`：`commitPreparedOperation`（同步事务）+ `runDrain`/`enqueueModelOperation`（异步路径，取代手写 try/catch） | `tests/history/v3/persist-guard-wiring.it.test.ts`（新建）：注入 transient 错误验证 never-throw + 计数 |
| Umzug 骨架 | `migrations/{index,run,storage}.ts` + `meta.ts` 的 `getMeta`/`setMeta`/`HISTORY_META_DDL`（搬迁后） | `state.ts` `initHistory`：`getDatabase().exec(V3_SCHEMA_SQL)` 与 `recoverV3Journal` 之间插入 `await applyForwardMigrations(getDatabase())`；`initHistory` 签名改 async | `tests/history/v3/migrations-wiring.it.test.ts`（新建）：注入非空测试用 migrations 数组验证真实执行+记账+幂等 |

## 6. 排除/暂缓（Excluded / Deferred）

- **archive-worker.ts —— 删除**（用户已裁决，非待定）。理由：src 内零 live 消费者（仅 tests + `resetArchiveWorkerForTests`），ADR `docs/decisions/2026-07-14-tiered-archive-cold-format.md` 保留存档、顶部加"代码已删除，需要时 `git log` 取回"批注，不删除 ADR 本身（ADR 记录决策理由，与代码存续无关）。
- **D-2（in-flight 可见性缺口）—— 建议纳入 backlog，不在本次范围**：`queries.ts` 的 in-flight merge 逻辑在生产因 `putInFlight` 无调用者而恒空（Phase 3 已确认 `insertEntry`/`putInFlight` 生产无调用者），意味着**当前生产的 History list 不显示进行中的请求**，只显示 V3 终端已落库的。这是一个真实存在、独立于本次重构的产品缺口（V2 时代由 HistorySink 挂载 `insertEntry` 填充 in-flight map，V3 cutover 后这条链路断了，无人注意到）。
  - **不纳入本次范围的理由**：(a) 这是**新增功能**（让 pending 请求在 History list 可见需要在 V3 生产路径新增一个"ingress 时刻"的轻量写入，其设计涉及"V3 该不该有非 terminal 的中间态记录"这个架构问题，超出"移除 V2 + 接线三项裁决"的既定范围）；(b) 本次删除后 in-flight facade（`entries.ts` 精简后的 `insertEntry`/`putInFlight`）在生产依然存在但仍无调用者，删除 V2 不会让这个缺口变得更差或更好——它是重构前就存在的独立缺口。
  - **建议**：写入 `docs/todo/deferred-backlog.md`，条目内容：根因（V3 cutover 时未把 ingress 阶段的"标记为 pending"接回 in-flight map）、当前行为（History list 只显示已终结请求，TUI 的实时面板走独立的 `active-request-wire`/WS 广播、不经过 History list）、理想架构（V3 增加一个轻量 ingress 记录或复用 in-flight map + 在 `request.ts` 的 ingress 阶段调用 `putInFlight`）、为何暂缓（本次范围是移除 V2，新增 V3 能力是独立特性）、若做需改什么（`request.ts` ingress 阶段新增 in-flight 写入调用 + `queries.ts` 合并逻辑不变即可复用）。
- **`docs/API.md:123` 的 409 契约描述已过时——定案为纯文档订正，无需 config 层改动**（已核实定案，非待决项）：config schema 中不存在任何 `history.archive.*` 键（全仓 grep 零命中），archive tier 的拒绝逻辑早已是 `src/routes/history/handler.ts:48` 的固定 `rejectsRetiredArchiveTier`（返回 400 "The built-in archive tier has been retired"），与 config 无关。`archive-worker.ts` 代码删除**不产生任何新的 config 清理待办**——Phase 5 只需把 `docs/API.md:123` 那段旧的"`history.archive.enabled=false` → 409 archive_unavailable"描述订正为准确的"`?tier=archive` → 400 retired"描述，不涉及 Phase 4a 范围扩大，也不涉及 config 兼容层弃用规范。
- **VACUUM 的 "存活共享库跳过" 语义不采纳到 V3**（见 4b）——`hasLiveForeignOwner`/`reclaimOrphanedActiveRows` 绑定 `entries_v2` 的 pid/status 列，V3 的 `v3_operations` 没有等价的"进行中行"概念（v3 只落终态）。若未来 V3 需要"多进程共享写"安全网，需要先在 V3 引入等价的进行中状态列，这是独立的架构决策，本次不做（备选方案：保留该函数原样但改造为读 `v3_operations` 的某个假设列——**不采用**，因为会凭空引入 V3 目前不存在的语义，属于捏造需求）。

## 7. 前置：Phase 1 归类清单需要执行者逐文件确认

本计划 §3 Phase 1 的 A/B/C 类划分基于当前调研（file:line 已核实到函数级），但"某个混合测试文件里哪些具体 `test()` 用例属于 A 还是 C"需要执行者打开每个文件逐用例判断（判据已给出：断言 History 行为契约 vs 断言 V2 内部结构/序列化格式）。这不是本计划的模糊地带，而是"计划到实现"必然存在的最后一层精细颗粒度，留给执行阶段按判据机械执行，不构成待用户裁决的开放问题。
