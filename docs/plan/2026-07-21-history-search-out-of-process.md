# Plan: History 全文搜索移出主进程（独立 sidecar 进程 + UDS）

> 状态：**已签核，实现中**（隔离 worktree + implementer subagent 执行，主会话监督）。前置止血已落地（`d5e2309d`：in-process 批量提交消除段爆炸崩溃）。本计划在其上做进程隔离。Phase 0（readonly store 读取面）已完成，`cbe163c2`；Phase 1（sidecar 可独立运行）已完成，`d7c64d5d`+`064a1d55`；Phase 2+ 待续。
> 用户签核决定：① 投影用重建法（不加 `search_text` 列）；② 分 Phase 0→P4 落地；③ sidecar 不可用降级返空；④ 游标用 `(committed_at, operation_id)` keyset；⑤ `source` 契约**收窄到 `inbound`**（其余 facet 返空 + OpenAPI 注明、扩展留 backlog）。

## Context（为什么做）

前置修复（`d5e2309d`）已消除本次崩溃根因（每请求一个 Tantivy segment → 232GB → mmap 撑爆 → 16MB arena 分配失败 → Rust abort）。但**残余结构性风险**：Tantivy `.node` 仍加载在主进程内，任何其它原因（坏输入、tantivy bug、索引损坏）导致的 Rust abort 仍会**带崩整个主服务器**（它承载用户实时使用 / History / 诊断）。

**用户决定**：把 search **完全移出主进程**，做成一个独立子进程——① 独立进程**自读 `history-v3.db`** 建 Tantivy 索引（主进程零 search 负载、零 `.node`）；② 主进程经 **Unix domain socket** 向它查询。目标：search 进程无论怎么崩，都**物理上无法**拖垮主服务器；主进程只在需要搜索结果时经 UDS 问它，问不到就降级返空（契约已支持 `partial`）。

## 现状事实（Explore 摸底，file:line 为准）

- **无现成 sidecar spawn/监管**（全仓无 `Bun.spawn`/`child_process` 起子进程）；但 `src/lib/restart/` 有可复用原语：`pidfile.ts`（原子写 + `isProcessAlive` + compare-and-delete）、`process-identity.ts`（pid+bootTime 中立叶子层）。
- **tail 游标**：`v3_operations`（[store.ts:168](src/lib/history/v3/store.ts#L168)）是 `TEXT PRIMARY KEY` 但**非 `WITHOUT ROWID`** → 有严格递增的隐式 **rowid** = commit 顺序。`operation_id` 是随机 UUID（非单调）、`terminal_sequence` 是 per-record（非全局）、`committed_at` 单调但无索引。**rowid 是最干净的 append 游标**。
- **投影**：[projection.ts:106](src/lib/history/v3/projection.ts#L106) `projectSearchableText(record)` 已存在，但吃**内存 `ModelOperationRecord`**；DB 里存的是 `manifest_gz`（压缩 manifest），需经 store 的 manifest 展开重建 record 再投影。**这是最大实现面。**
- **REST 契约已在、返空**：[route.ts:39](src/routes/history/route.ts#L39) `GET /api/search` → [handler.ts:216](src/routes/history/handler.ts#L216) `handleSearch` → [search.ts:6](src/lib/history/search.ts#L6) `searchHistory()` **硬编码返 `{rows:[],nextCursor:null,partial:false}`**（"retired until independent sidecar serves this contract"）。Hono handler 是 async，直接 `await udsClient` 即可。
- **主进程喂 search 的接线全集中在 [state.ts](src/lib/history/state.ts)**：`:128` `subscribeModelOperationTerminals(enqueueTantivyOperation)`（要拆）、`:127` `configureTantivySearch`、`:192` `drainTantivySearch`。**保留** `:121` `subscribeModelOperationTerminals(enqueueModelOperation)`（这条写 DB，正是 sidecar tail 的数据源）。status 报告在 [status/route.ts:213](src/routes/status/route.ts#L213)。
- **进程入口**：[main.ts:34](src/main.ts#L34) citty `subCommands` → 可加一个 search 子命令当 sidecar 入口。`main.ts:24-32` 全局 `uncaughtException`/`unhandledRejection` → `process.exit(1)` 对子进程也生效（崩了退出、监管器重启）。
- **UDS 无 stream 先例**：[notify.ts](src/lib/restart/notify.ts) 只有 AF_UNIX **datagram**（sd_notify，走 bun:ffi）。stream UDS 需新建；`node:net`（`createServer({path})` + `connect(path)`）双运行时（Bun+Node）都支持、最可移植。SQLite driver（[driver.ts:57](src/lib/sqlite/driver.ts#L57)）factory **不接受 options**，需扩展支持 `readonly`。

## 架构决策（已定，理由钉死）

1. **投影数据源 = sidecar 从 manifest 重建**（非「主进程写 `search_text` 列」）。理由：后者给每行加最多 128KB 文本会把 `history-v3.db` 撑爆（与 compact-storage 相悖），且只有重建法才真正零主进程负载。sidecar 隔离、重建开销高也无所谓。
   - **⚠ blocker 修正（审查实测）**：现有 store 无可复用导出。`hydrateManifest`（[store.ts:973](src/lib/history/v3/store.ts#L973)）是私有未导出；`getV3StoredOperation`/`listV3StoredOperations`/`visitV3StoredOperations` 全用 `getDatabase()` 单例、不接受 db 参数；`openDatabase()`（[connection.ts:47](src/lib/history/sqlite/connection.ts#L47)）无条件写 `PRAGMA auto_vacuum=INCREMENTAL` + `maybeVacuumOnStartup` → 对 readonly 连接**实测抛 `attempt to write a readonly database`**。**Phase 0 前置**：① 导出 `hydrateManifest` 并改造成不依赖 store 模块级状态的纯读函数；② `connection.ts` 新增 `openDatabaseReadonly(path)` 跳过所有写 pragma / vacuum / analyze；③ 读函数加可选 `db` 参数（默认 `= getDatabase()`，向后兼容，对齐 `commitPreparedOperation(db, ...)`/`ensureV3Schema(db=...)` 风格）。
2. **sidecar 自读 `history-v3.db`（readonly, WAL 并发读）**，tail 新记录。游标持久化在 sidecar 索引目录 meta，崩溃重启续 tail、不重建全量。
   - **⚠ 游标改用 keyset（审查 major）**：不用裸 rowid。rowid 实测跨 VACUUM 稳定，但 SQLite 文档对 TEXT-PK 表明确「VACUUM **may change** ROWIDs」、且 `maybeVacuumOnStartup` 会在生产跑真实 VACUUM，恰在 sidecar 重启续跑窗口 → 未来 SQLite 版本变行为会静默丢/重。改用**文档保证单调的 `(committed_at, operation_id)` keyset**（`committed_at` 单调、`operation_id` 打破同毫秒并列），与项目既有教训 [[methodology-recoverable-backfill-cooperative-stop-and-keyset]] 同构。补一条「VACUUM 后续跑不丢不重」回归测试。
   - **append-once 前提（审查确认）**：`v3_operations` 对语义内容 append-once（`commitPreparedOperation` [store.ts:604](src/lib/history/v3/store.ts#L604) 冲突即 `idempotent` 跳过或抛 `V3OperationConflictError`，无「新 revision 覆写同行」路径）；仅 `pinned`/`summary_json`/`ended_at` 有非语义 UPDATE，**都不影响 `projectSearchableText` 输入**。故 keyset tail 不会漏「改变可搜索内容的修订」。在 sidecar 写测试锁定此假设，而非留隐式前提。
   - **WAL tail 须自动提交（审查建议）**：tail 轮询每次独立事务（autocommit），**绝不长期持 `BEGIN`**——否则长快照令 PASSIVE checkpoint 永远停在同点、WAL 无限增长（checkpoint starvation）。做成显式代码约束。
3. **传输 = `node:net` stream UDS**（双运行时可移植，审查确认 worker_threads 不行——共享地址空间、native abort 会杀主进程），socket 路径 `path.join(APP_DIR, "history-search.sock")`。协议 = 长度前缀 JSON 请求-响应。sidecar 当 server，主进程 handler 当 client。
4. **进程入口 = citty 隐藏子命令** `history-search-daemon`。
   - **⚠ spawn 解析须双部署形态（审查 major）**：主进程 spawn 用 `process.execPath`（当前运行时 bun/node）+ **显式计算的入口路径**——dev 态 `src/main.ts`、打包态 `dist/main.mjs`（[package.json bin](package.json)）。两种形态各写一条集成测试，防「dev 可行、打包悄悄失效」。
5. **监管 = 主进程 spawn + 指数退避重启 + crash-loop 上限**，挂进 History 关闭顺序。
   - **⚠ crash-loop 上限（审查 major）**：指数退避须有上限 +「连续失败 N 次进入长期冷却 / 停止自动重启」，避免持续畸形输入令 sidecar 反复 abort 烧 CPU/日志。`/api/status.history_search` 暴露「是否已放弃自动重启」布尔量。
   - socket `error` 事件（监管器 + UDS client）**必须挂 listener**（否则冒泡成主进程 uncaughtException → exit(1)，[[debugging-server-crashes]] 放大链）。
6. **status 降级**：主进程不再有 in-process `getTantivySearchStatus()`；改报「sidecar 存活 + 上次 UDS 延迟/错误 + 是否放弃重启」。

## 复用 / 搬迁

- **复用**（已提交、几乎不动）：Rust `HistoryIndex` class（[lib.rs](native/history-search/src/lib.rs)）、`projectSearchableText`（[projection.ts](src/lib/history/v3/projection.ts)）、批量/去抖 committer 逻辑（[search-tantivy.ts](src/lib/history/search-tantivy.ts)）——**搬进 sidecar 进程**，喂养源从 terminal bus 换成 DB-tail。
- **`search-native.ts`**（`.node` 加载器）**只在 sidecar 进程**存在；主进程彻底移除对它的 import。
- **拆除**：主进程 [state.ts:128](src/lib/history/state.ts#L128) 的 `enqueueTantivyOperation` 订阅、`configureTantivySearch`/`drainTantivySearch` 调用；改为 spawn/停 sidecar 监管器。

## 实现阶段（TDD）

### Phase 0 — readonly store 读取面（blocker 前置，审查发现）✅ **已完成**（2026-07-21，`cbe163c2`）
- 导出 `hydrateManifest`（[store.ts:973](src/lib/history/v3/store.ts#L973)）为不依赖模块级状态的纯读函数。
- [connection.ts](src/lib/history/sqlite/connection.ts) 新增 `openDatabaseReadonly(path)`：跳过 `auto_vacuum` 写 pragma / `maybeVacuumOnStartup` / `seedAnalyzeIfNeeded`，只 `PRAGMA busy_timeout` + 校验 owner。
- 扩展 [driver.ts](src/lib/sqlite/driver.ts) factory 支持 `{ readonly }`（bun `{readonly:true}` / node `{readOnly:true}`）。
- `getV3StoredOperation`/`listV3StoredOperations`/`visitV3StoredOperations` 加可选 `db` 参数（默认 `= getDatabase()`）。
- 测试：readonly 打开真 db fixture、hydrate 一条 operation → record，`projectSearchableText` 出对话+响应文本。**不碰主进程行为**（纯增量、向后兼容）。
- **实测确认**（bun 1.3.14 / node 24.16）：bun:sqlite 选项键为 `readonly`（拼错大小写直接 throw `Misspelled option`）；node:sqlite 选项键为 `readOnly`（大小写错了**不抛错、静默忽略、打开可写连接**——比 bun 更危险的失败模式，driver 已按运行时精确映射两种大小写）。`openDatabase()` 原序列里五个基础 PRAGMA（`auto_vacuum`/`journal_mode`/`synchronous`/`busy_timeout`/`foreign_keys`）本身在 readonly 连接上不抛；真正会抛 `attempt to write a readonly database` 的是 `VACUUM`/`ANALYZE`（在 `maybeVacuumOnStartup`/`seedAnalyzeIfNeeded` 内部，两者都有 never-throw try/catch 会静默吞掉——故"跳过"不是可选项而是防止误导性静默失败的正确性要求）以及 schema migration 分支的 `ALTER TABLE`。`openDatabaseReadonly` 全部跳过，只做 busy_timeout + owner 校验。
- 新测试 `tests/history/v3/readonly-store.it.test.ts`（7 test，含负样本基线证明旧序列确实抛错）；`bun run typecheck` + `bunx eslint`（无 cache）全绿；`test:fast`（unit+http）4329 pass；全量 `.it` 分档 1669 pass/4 fail——4 个失败经 stash 掉本次改动后复现完全相同（`record.attempts` undefined @ projection.ts:246，`store-performance.it.test.ts`/`store.it.test.ts` 自身既有缺陷，与 Phase 0 无关，未修）。

### Phase 1 — sidecar 可独立运行（不接主进程）✅ **已完成**（2026-07-21，`d7c64d5d`+`064a1d55`）
- 新 `src/lib/history/search/daemon.ts`：`openDatabaseReadonly` → `(committed_at, operation_id)` keyset tail `v3_operations`（autocommit 轮询）→ hydrate → `projectSearchableText` → `HistoryIndex.upsert` + 去抖 flush；游标持久化在索引目录 meta。
- 测试（`.it`）：真 history-v3.db fixture（若干 operation）→ 跑 daemon 一轮 tail → 断言索引出对话+响应 token、排除 upstream；**游标续跑不重复**；**VACUUM 后续跑不丢不重**（审查回归用例）。
- **API 形态**：`createHistorySearchDaemon({ dbPath, indexPath, index, pageSize? })` 返回 `{ tailOnce(): Promise<{processed, cursor}>, getCursor(), close() }`；`index` 由调用方持有（`getNativeHistorySearch()` + `new native.HistoryIndex(indexPath)`），daemon 只管 upsert、不管 flush/close（去抖节奏留给调用方，对齐止血版 `search-tantivy.ts` upsert/flush 分离）。游标读写 `readTailCursor(indexPath)`/`writeTailCursor(indexPath, cursor)` 是独立导出的纯函数（原子 tmp+rename，仿 `src/lib/restart/pidfile.ts`），崩溃/损坏文件 never-throw 退化为「从头重 tail」（`HistoryIndex.upsert` 是 delete-then-add 幂等，重 tail 安全只是变慢）。`tailOnce()` 内部循环到某页不足 `pageSize` 才停，故一次调用总能追平到当前所有已提交行。
- **committed_at 索引**：加进 `V3_SCHEMA_SQL`（`CREATE INDEX IF NOT EXISTS idx_v3_operations_committed ON v3_operations(committed_at, operation_id)`），**未 bump `SCHEMA_VERSION`**——实测确认 `V3_SCHEMA_SQL` 的 `db.exec` 在 `ensureV3Schema` 顶部无条件执行（不受 `schema_version` 门控），对已是当前版本的既有 db 重开仍会补上新增索引；且既有两条索引（`idx_v3_operations_created`/`idx_v3_operations_kind`）当年引入时也未 bump 版本，做法一致。
- **VACUUM 回归怎么证**：真实 5 条 operation 落库 → daemon tail 一轮（5 processed）→ 对同一 db 路径经生产 `openDatabase` 打开后跑真实 `VACUUM;`（非 mock）→ 再落一条新 operation → 新建 daemon 实例（读回持久化游标，模拟崩溃重启）→ 断言 `processed===1`（不多不少）且全部 6 条（5 条 pre-VACUUM + 1 条 post-VACUUM）都可搜到，无遗漏无重复。
- **实测发现**：native `.node` 在本 worktree 已存在且早于本次改动（`bun run build:history-search` 已在别处跑过），测试直接复用无需额外构建步骤；`append-once` 前提在测试里补了负面分支——同一 `operationId` 灌入不同内容会**抛 `V3OperationConflictError`**（而非静默覆写），补全了「幂等 no-op」与「冲突必抛」两侧，锁死 keyset tail 不会漏「内容变更的修订」这个假设的完整性。
- **测试范围外确认**：`bun run typecheck`、`bunx eslint`（无 cache）全绿；`bun run test`（unit+http）4335 pass（较 Phase 0 后的 4329 净增 6，即新增用例）；全量 `.it` 分档（`bun run test:backend`）6008 pass / 4 fail——与 Phase 0 交付时确认的 4 个既有缺陷（`store.it.test.ts` 2 个 + `store-performance.it.test.ts` 2 个，根因 `record.attempts` undefined @ projection.ts:246）完全一致，未新增失败、未修复（超出 Phase 1 范围）。

### Phase 2 — UDS 服务端 + 协议
- 新 `uds-server.ts`（`node:net` `createServer({path})`，长度前缀 JSON），daemon listen；`uds-client.ts`（主进程侧 `net.connect`，超时 + socket error 挂 listener + 连不上返空）。
- 测试：daemon + client 往返；client 在 socket 不存在/超时/错误帧下**返空不抛**。

### Phase 3 — 主进程监管器 + 拆 in-process 接线
- 新 `supervisor.ts`：`process.execPath` + 显式入口路径 spawn 子命令、指数退避 + crash-loop 上限、关闭杀子进程；复用 `process-identity`/`isProcessAlive`；socket error 挂 listener。
- [main.ts](src/main.ts) 加隐藏子命令 `history-search-daemon`。
- [state.ts](src/lib/history/state.ts)：删 `enqueueTantivyOperation` 订阅 + `configureTantivySearch`/`drainTantivySearch`；enable 启动 supervisor、shutdown 停 supervisor。**保留** `enqueueModelOperation` 订阅（写 DB，sidecar tail 源）。
- 测试（`.it`）：主进程起 supervisor → sidecar 起 → 写一条 operation → 轮询 UDS 查到；**`kill -9` sidecar → 主进程不崩、supervisor 重启 → 恢复可查**（崩溃隔离核心验收，实测主进程 PID 不变）；crash-loop 达上限进入冷却 + status 反映；dev/打包双形态 spawn 各一测。

### Phase 4 — REST cutover
- [handler.ts](src/routes/history/handler.ts) `handleSearch`/`handleSearchContains`：调 `searchHistory`（空）→ `await udsClient.query(...)`；保留 query 解析、`partial` 语义（sidecar 不可用返空 + `partial:true`）。
- **⚠ `source` 5-facet 契约取舍（审查 major）**：REST `SearchSource` 有 5 facet（`inbound`/`rewrites-req`/`rewrites-resp`/`req-headers`/`resp-headers`，[types.ts:729](src/lib/history/types.ts#L729)），但「对话+响应」投影只能服务 `inbound` 语义。**按用户既定「只查对话和响应」收窄**：cutover 后只服务 `inbound`，其余 facet 显式返空 + 更新 OpenAPI 描述（[openapi-compat.ts](src/routes/openapi-compat.ts) 附近）说明当前仅 `inbound`；其余留 backlog（未来扩 Rust schema + 多字段投影，不 silently 砍）。
- [status/route.ts](src/routes/status/route.ts) `history_search`：改报 sidecar 存活 + 延迟 + 是否放弃重启。
- 测试：HTTP `/history/api/search?source=inbound` 端到端返真结果；其余 source 返空 + `partial`/说明；sidecar 不可用返空。

## 验收 / 验证
- 各 Phase `.it` 测试绿；`typecheck` + `eslint`（无 cache）；`test:backend` 无回归。
- **崩溃隔离核心验收**（非 4141 隔离实例）：起主进程 + sidecar → `kill -9` sidecar → 主进程存活、continues serving、supervisor 重启 sidecar → 搜索恢复。用 PTY/进程探针实测主进程 PID 不变。
- **真上游靶向验证**：非 4141 隔离实例发真请求 → sidecar tail 到 → UDS 查到真结果；主进程 RSS/存活稳定。
- **绝不 kill 用户 4141 主服务器**；测试用独立端口 + 独立 db/socket/index 目录。

## 待用户签核的点
1. 架构决策 1（投影用重建法、不加 `search_text` 列撑爆 DB）——确认。
2. 分阶段落地（Phase 0 readonly 读取面 → P1 sidecar → P2 UDS → P3 监管+拆接线 → P4 REST cutover），中间态：cutover 前 REST 仍返空（现状），不引入回归。
3. sidecar 崩溃/不可用时主进程**降级返空**（契约 `partial`），不阻塞、不重试上游——确认这是可接受的搜索可用性取舍。
4. **游标用 `(committed_at, operation_id)` keyset**（文档保证单调）而非裸 rowid——已按审查采纳 root-cause 版。
5. **`source` 5-facet 契约收窄**：按你既定「只查对话和响应」，cutover 后只服务 `inbound`、其余 facet 返空 + OpenAPI 注明、扩展留 backlog——确认收窄可接受（而非现在就扩 Rust schema 支持全 5 facet）。

> **本 plan 已过两轮异模型对抗审查**（gpt-souls:reviewer，含 `cargo build` + SQLite VACUUM/WAL 十余组实测 + 文档核实）。第二轮：1 blocker（manifest 重建无可复用导出 + readonly open 崩）+ 4 major（rowid 非文档保证→改 keyset、5-facet 契约、crash-loop 上限、spawn 双形态）已全部并入。崩溃隔离（真子进程）、WAL tail 快照隔离、append-once 前提经独立实测确认成立。
