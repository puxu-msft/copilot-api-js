# 实施状态

> **状态：部分完成。** 本表记录计划内各任务的实现证据与偏差，不替代 `docs/DESIGN.md` 的活架构现状。A2 的合并态复验锚定 `2d4f400d50d1061810db284b44bdbf62203dfff7`：目标套件 `108 pass / 1 skip / 0 fail`，`bun run typecheck` 通过，计划内 22 个变更文件的定向 ESLint 通过。该数字只覆盖本计划已实现的 A1/A2 路径，不代表全后端验收。

| 计划任务 | 当前状态与证据 | 与原计划的差异／剩余工作 |
|---|---|---|
| A0 基线与计划 | 已完成调查与计划冻结，起点提交 `b6fb0947686ea6620bfafb63a4fd151d18599483`。 | 运行中约 6.3 万行 artifact 的性能数字仍是调查快照；执行验收必须重新取数。 |
| A1 summary projection | **部分完成。** `92fcc611` 落 `001-operation-summary-projection` 表／索引／兼容 trigger；`a8a9475c` 落 bounded backfill、manifest repair、poison 可见性与原子 ready gate。 | 尚未实现 002 maintenance command、跨进程独占 writer 门、artifact owner generation 升级、删除旧 `summary_json`／`pinned` 列、真实 pre-001 binary 六臂兼容夹具与真实大库迁移 dry-run。当前是受 ready marker 保护的长期兼容态，不是最终单源态。 |
| A2 SQL 查询基座 | **代码完成，真实大库验收待做。** `8afd3c26..50941d32` 依次落 canonical 专用 status count、双向 keyset list、session／stats SQL 聚合、按页 detail hydrate、manifest-size 性能护栏、filter-aware cursor／overlay 与 recent durability。 | 自动性能护栏使用 512 行、每行 256 KiB manifest，证明读路径与约 128 MiB canonical manifest 解耦；它没有证明真实约 6.3 万行生产副本上的 wall time、WAL／缓存效应或非 4141 HTTP 运行态 max-gap。持久全文 `search` 不属 A2，仍归 A3。 |
| A3 持久全文 search | **代码完成，独立评审待做。** native Tantivy 与 UDS 新增 strict `list-search`：完整全文＋结构 filters、`(startedAt,id)` 双向 keyset、精确 total、冻结 freshness target／同毫秒边界集合／poison attestation；`GET /history/api/entries?search=` 只按返回 IDs 批量读窄表，无法证明完整时 503。 | 目标 History 组、全 backend、ui-v4 Bun／Vitest、根与 ui-v4 typecheck、ui-v4 build、changed-file lint 均通过；mutation control 分别证明提前发布 cursor、删除 native operation-kind filter、handler 退回同步 facade 会精确转红。实施 commit `08046d5c`；尚缺独立 reviewer／verifier 与真实约 6.3 万行副本验收。 |
| A4 H2 canonical diagnostics | 未开始。 | 尚无能把 `NGHTTP2_CANCEL` 按 stream／session／local-abort 归因并落到明确 dispatch 的 canonical 诊断。 |
| A5 文档与独立验收 | 进行中。 | A3 live docs 已对账；全 backend／ui-v4 tests、typecheck、build 与 changed-file lint 已通过。仍需独立代码 review／verifier、CI 的 PTY/E2E 档位和真实大库验收。 |
| Phase B 根因实验 | 未开始，受 A4 诊断门阻塞。 | 不在缺 canonical stream/session 证据时预设 PING cadence 或 generic CANCEL retry 是修复。 |

# Context

近期 GPT 请求失败率在冻结窗口 `2026-08-05T03:28:10.512Z..2026-08-06T03:28:10.512Z` 从前一日的 `10/1665 = 0.601%` 升至 `57/3038 = 1.876%`；真实错误字段显示其中 23 条为 `NGHTTP2_CANCEL`。调查同时确认本地确定性放大器：`/api/status` 为得到 History count 调 `getHistorySummaries({limit:1})`，后者经 `visitV3Summaries` 同步遍历全库并读取每行 `manifest_gz`；一次状态请求可冻结 Bun 主线程 26.54s。以下容量/性能数字是 `2026-08-06` 对运行中 artifact 的只读快照，不是实施常量：约6.3万行时，现行扫描在独立只读基准中需6～13s、读取约2.8GB，`dbstat` 的 `v3_operations` 约2.93GB；直接在宽表上做 JSON SQL pushdown 的冷缓存页面查询仍需21.77s。执行时用 `SELECT COUNT(*)`、`dbstat` 和同一 benchmark重新取数并锚定当时 HEAD/config。

目标分两阶段：先修本地查询架构、公开契约假实现和 transport 诊断丢失，经独立 agent review/verification 后交付；再利用新增证据仔细研究 `NGHTTP2_CANCEL` 的成因与 keepalive/H2 PING 是否有效。第二阶段先实验后裁决，不预设调参就是修复。

## 已冻结决定与约束

- `v3_operations`/CAS/manifest 继续是 authoritative semantic History；详情/export 仍走 richest canonical projection。
- 新增独立窄型 `v3_operation_summaries` 作为唯一活的 list/session/stats 派生投影；迁移校验后删除 `v3_operations.summary_json`，不留永久死字段或长期双写。这是比较过“同表 typed columns＋covering index”和 Worker/sidecar 后的推荐最佳：前者可行但会把 summary projection 隐藏成宽表列/巨大覆盖索引、继续耦合 canonical 与产品读生命周期；后者只搬走坏查询。此处不声称窄表是逻辑唯一方案。
- 对外 `SummaryResult`、默认 newest-first、cursor ID、过滤参数、in-flight 合并语义保持兼容；补齐已声明但未真正实现的 `direction` 与持久 `search`。
- 全文索引不回流 `history-v3.db`；沿用独立 Tantivy sidecar。生产 History 删除面已退役，本轮不新增 destructive API；修正 `handler.ts` 把 list/scoped-delete 并列描述的陈旧注释，并保留 `read-consumer-guard` 对 `deleteSession/deleteEntries` 的禁止。
- 4141 主服务器绝不停止。迁移与新行为先在隔离 worktree、临时数据库和非 4141 测试实例验证。
- 所有实现按 TDD：先写目标测试并确认因目标缺陷而红，再实现；关键 gate 做正反样本和 mutation control。

# Phase A — 本地根因与诊断修复

## A0. 固化基线和决策真相

**读取/更新**：`docs/DESIGN.md`、`docs/history-v3-schema.md`、`docs/history.md`、`docs/API.md`、`docs/todo/deferred-backlog.md`；新增仓库计划 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`，其内容与本文件同步。

- 在临时数据库副本上冻结现行 API fixtures、行数、DB 大小、`/api/status`/list/session/stats 延迟、事件循环 max-gap，以及当前 SQL query plans。
- 明确记录当前假实现：`direction` 未进入持久查询；持久 `search` 只因 recent terminal cache 测试而假绿；`success`/`state` 注释与真实 precedence 不完全一致。
- 新增测试 helper，使每个读路径测试都能执行“提交→drain→清空 recent/in-flight cache→重新打开数据库”后再查询，证明命中持久路径。

## A1. 建立窄型 summary projection 和安全迁移

**主要文件**：
- `src/lib/history/sqlite/connection.ts`（artifact owner generation fence）
- `src/lib/history/sqlite/migrations/index.ts`（默认 runner 只登记001）
- 新建 `src/lib/history/sqlite/converge-summary.ts`（command-only 002 readiness、备份/独占门、DROP COLUMN、校验）
- `src/lib/history/v3/store.ts`
- 新建 `src/lib/history/v3/summary-store.ts`（DDL、row codec、filter builder、page/count/group aggregate）
- `src/lib/history/state.ts`
- `packages/cli/src/main.ts`
- 新建 `packages/cli/src/history-converge-summary.ts`（one-shot maintenance command）
- `tests/history/v3/store.it.test.ts`
- `tests/history/v3/read-cutover.it.test.ts`
- `tests/history/v3/migrations.it.test.ts`
- 新建 `tests/history/v3/summary-convergence.it.test.ts` 与 CLI smoke test

### Schema

新增 `v3_operation_summaries`，一行一 operation，FK `operation_id -> v3_operations ON DELETE CASCADE`。保留 nullable `summary_json` 作为 REST row codec，同时把所有查询/聚合维投影为 typed columns：`operation_kind, session_id, agent_id, started_at, ended_at, endpoint, state, pid, request_model, response_model, response_success, duration_ms, input/output/cache token counts, preview_text, response_preview_text, pinned`，并加 `projection_status = pending|ready|poisoned`、`projection_error`。其余轻量展示字段继续从 ready row 的 `summary_json` 解码；pending/poisoned row只用于迁移完整性/运维可见性，产品list/detail在ready marker前仍走旧读，marker gate禁止任何pending/poisoned进入新读。001兼容期canonical operation只写旧`v3_operations`，由同事务trigger唯一产生projection；post-002才由canonical writer直接写ready summary row。`pinned`是可变产品投影而非canonical digest，最终由summary表单一拥有。

索引至少覆盖：
- `(operation_kind, started_at DESC, operation_id DESC)` 与全 kind `(started_at DESC, operation_id DESC)`；
- session 聚合/明细 `(session_id, started_at, operation_id)`；
- 常用 exact filters 的复合前缀由生产 query plan 实测决定，避免为每个低选择性列盲建单列索引。

### 迁移分为“在线兼容准备”与“显式维护窗口收敛”

`v3_operations` 当前约 2.93GB；删除列需要重建整张宽表，不能藏在普通启动迁移里。采用两步、各自可验收的 forward migration：

1. **001 在线兼容准备与 mixed-version writer bridge**：事务内新建summary表、索引及条件化database triggers。`AFTER INSERT`：`NEW.summary_json IS NOT NULL`才按codec写ready；NULL只写pending row＋typed`pinned`，其余查询列保持NULL。`AFTER UPDATE OF summary_json`：从NULL/poisoned修复成非NULL时原子写完整typed fields、清`projection_error`并转ready；仍为NULL时不得改status/error。独立`AFTER UPDATE OF pinned`只更新typed pin，绝不解析summary或改变projection状态。这样旧binary在hot-restart overlap中的terminal insert、旧backfill repair、pin都在父写同一SQLite事务自动投影；NULL/poison pin不会误升ready、覆盖poison或因codec抛错回滚。新binary在001阶段也只写旧表，由trigger作为唯一compat projection writer。Trigger DDL、backfill`INSERT…SELECT`和post-002 direct writer必须由同一`SUMMARY_PROJECTION_FIELDS`描述生成／校验列名、JSON path、null/boolean编码；schema test逐项比较三条载体。后台job先复制非NULL历史ready row，再为NULL建pending并做bounded manifest repair；成功更新旧summary后trigger转ready，失败由backfill owner显式转poisoned并保留backlog/error。全程keyset让出、不丢canonical、不无限重试。旧binary clear由FK cascade覆盖；真实旧binary fixture验证insert、repair update、ready/NULL/poison pin、clear，并用trigger-throw证明父事务整体回滚。
2. **准备态机械 gate＋在线 read cutover**：要求两表`COUNT(*)`相等、operation ID集合双向差为空、`COUNT(*) FILTER (WHERE projection_status <> 'ready') = 0`、旧`summary_json IS NULL`为0、每行新旧`summary_json`字节相等、typed columns与JSON字段逐项一致；每条gate都有独立错误样本证明会红。特别注入“summary非NULL、typed fields全正确、仅status=pending”的样本，并mutation掉repair trigger的ready状态转移，证明marker不会落地。Gate校验与写`summary_projection_ready` marker在同一个SQLite `BEGIN IMMEDIATE`事务内完成；任何旧/新binary INSERT/UPDATE都受同库trigger约束，故writer要么在gate快照前完整可见，要么在marker后仍原子产生projection，不存在count后插入半边或mixed-version漏写。marker后新binary下一次查询立即切窄表读，不等待002维护窗口；旧binary仍从旧列工作。未满足时新binary保持旧读兼容态，并在status按pending/poisoned分别显示进度与错误。写确定性并发测试停在gate中点，并用真实pre-001 binary fixture在marker前后插入＋pin，证明trigger bridge使两边同步。
3. **mutable pin兼容门**：001期间product pin只更新旧`v3_operations.pinned`，由同事务UPDATE trigger单源投影到summary row，typed`pinned`覆盖JSON快照；补pin→list/detail→清recent cache→重开库、旧binary pin和删除任一trigger的mutation。002停服事务先确认无writer，再删除compat triggers与旧列，随后新代码直接写summary表成为最终单源。
4. **002 显式维护窗口收敛**：002不进入默认`MIGRATIONS`/`applyForwardMigrations()`，由独立maintenance command和convergence marker管理；legacy owner下服务可长期运行001兼容态、由trigger bridge持续投影并暴露readiness。用户另行安排停服维护窗口后，命令取得跨进程独占writer门、确认无旧/新服务writer、重跑readiness gate、验证磁盘和用户明确指定的可恢复备份/快照；随后在同一个`BEGIN IMMEDIATE`事务中按固定顺序：DROP compat triggers→原生`ALTER TABLE v3_operations DROP COLUMN summary_json`与`DROP COLUMN pinned`→切换post-002 direct-writer schema/marker→升级owner→执行键集合/FK检查后COMMIT。只要trigger仍引用旧列，DROP COLUMN会硬失败；Bun/Node SQLite 3.53.0实测也确认DROP trigger+DROP column的事务回滚会完整恢复trigger与列，因此加每个中点failpoint的rollback测试。执行后另跑`integrity_check`；runtime SQLite低于3.35则明确拒绝，不手写降级table-rebuild。
5. **artifact generation fence**：maintenance command 在同一事务把 `history_store_identity.owner` 从 legacy `copilot-api-history-v3` 升级为新 generation marker，并写 convergence/schema marker。新 binary 的 schema floor 先读 owner：legacy owner 只创建/维护含旧列的001兼容 floor；新 owner 只接受 post-002 floor，绝不补旧列。旧 binary 因 owner 不匹配在任何 reconcile/读写前 fail-loud，不能半可用启动或复活旧列。分别用真实 pre-002 binary/fixture 与新 binary 做兼容期启动、升级、降级、重复执行、崩溃回滚和备份恢复六臂测试。
6. **读取状态机**：`legacy owner + 无 ready marker`＝旧读＋双写/backfill；`legacy owner + ready marker`＝新 binary 窄表读＋双写，旧 binary 仍旧读；`new owner + convergence marker`＝新 binary 窄表读＋单写，旧 binary 开库拒绝。任何其它组合都 fail-loud，并在测试中逐格覆盖。ready marker 只由机械 gate 事务写入；convergence marker只由停服002事务写入。
7. **最终单源**：002 完成后停止旧列写入并删除兼容 backfill；pin/detail/list 全部从 summary 表读写，不保留永久双写、死字段或慢 fallback。

先在真实生产库副本上测 001 backfill 与 002 原生 DROP COLUMN 的 wall time、WAL/临时空间峰值、DB 文件峰值和主线程 max-gap，并记录“它没有证明什么”。任何真实 4141 迁移、备份覆盖或维护窗口都需用户另行明确授权；本任务只交付代码、验证过的 migration command 和操作文档，不自行迁移运行中主库。

## A2. SQL 查询基座：filter/count/keyset/session/stats

**主要文件**：
- `src/lib/history/v3/summary-store.ts`
- `src/lib/history/queries.ts`
- `src/lib/history/sessions.ts`
- `src/lib/history/stats.ts`
- `src/routes/status/route.ts`
- `tests/history/history-summary.it.test.ts`
- `tests/history/history-api.it.test.ts`
- `tests/history/v3/read-cutover.it.test.ts`
- `tests/infra/management-routes.http.test.ts`
- 新建 `tests/history/v3/summary-query-performance.it.test.ts`，固定查询计划、manifest 体积解耦和 event-loop max-gap gate

### Shared filter compiler

单一 typed builder 把 `QueryOptions` 编译成 SQL `WHERE + params`，list/count/session/stats 所需子集共用；`state` 与 `success` precedence 写成一个函数并用双向样本锁定。`model` 保持 request/response 子串、不区分大小写；endpoint/session/agent/mainAgent/pid/from/to/operationKind 全部下推。

### Cursor contract

- cursor resolver 按 operation ID 依次查 in-flight、recent terminal、窄表，取得统一 `(started_at,operation_id)`；只要 cursor 由任一源存在且满足当前 filter，就是有效。三源均不存在或不满足 filter 才返回 400，避免服务刚签发 recent/in-flight cursor、下一请求却误拒。
- `older` 用 tuple `< cursor`、DESC；`newer` 用 tuple `> cursor`、ASC 取页后反转成 API 的 newest-first 展示。
- 持久页查 `limit+1`，再与满足同一 tuple 边界的 recent/in-flight overlay 合并、按 ID 去重排序、截到 limit。Overlay 中已持久化同 ID 只替换 row，不增加 total；尚未持久化且满足 filter 的 terminal/in-flight ID 集合才加入 `persisted COUNT(*)` 得精确 total。持久失败的 recent terminal 仍作为可见 overlay并携带 `durability: pending|failed`，直到离开 recent cache；不得静默冒充已落盘。
- next/prev 由合并后的全序、反向是否存在任一源 row和持久 `EXISTS` 查询共同判定，不靠 `startIdx+limit<total`。写跨页并发插入、同 startedAt tie、recent尚未落库、in-flight转终态、持久失败、正反方向与错误 cursor 的双控。

### Consumer cutover

- `/api/status` 直接对 canonical `v3_operations` 做专用 `COUNT(*)`，不得调用 list facade；它只数 operation 行且不读 manifest，无需依赖 projection readiness。
- History summaries 只取目标页 JSON，不全库遍历。
- sessions 用 SQL group aggregate；首/末 preview 通过 window function 或两次 keyset join 取得，不在 JS 持有全量 session entries。
- stats 用 SQL aggregate/group queries；recent/in-flight 只作增量去重合并。
- `getSessionEntries` 先用窄表 keyset 取得 IDs，再按该小页 hydrate canonical detail；不扫描所有 manifest。
- detail/export 继续按 operation ID hydrate canonical record。

性能验收在固定临时库（≥当前约 6.3 万行，含大 manifest）上测：status count、默认 list page、常用 exact filter page/count、sessions、stats 均不得读取 `manifest_gz`；`EXPLAIN QUERY PLAN` 正样本必须命中预期索引且无默认页 temp B-tree。记录 wall 与 event-loop max-gap，不写硬编码“必须 N ms”作为唯一正确性 gate；以“与行内 manifest 体积解耦＋数量级相对改善”为主，另设宽松绝对 watchdog 防回归。

**已实现的自动护栏边界（`70b7f1c0`）**：`tests/history/v3/summary-query-performance.it.test.ts` 构造 512 行、每行 256 KiB manifest，对 list／sessions／stats／status 做行为等价、wall time 与 event-loop max-gap 对照，并显式执行一次 canonical manifest 全扫作为反样本。它证明这些读取不随约 128 MiB manifest 体积放大，且反样本确实触达大 BLOB；它没有替代上述真实约 6.3 万行副本验收，后者仍是 A5 的交付门。

## A3. 修复持久全文 search 契约

**主要文件**：
- `native/history-search/src/lib.rs`
- `src/lib/history/search-native.ts` 及生成的 native 类型接缝
- `src/lib/history/search/protocol.ts`
- `src/lib/history/search/uds-client.ts`
- `src/lib/history/search/uds-server.ts`
- `src/lib/history/search/daemon.ts`
- `src/lib/history/search.ts`
- `src/routes/history/handler.ts`
- `src/lib/history/queries.ts`
- `tests/history/search/*`
- `tests/history/history-summary.it.test.ts`
- `tests/history/history-api.it.test.ts`

现有 Tantivy `created_at` 只是 `STORED`，只能 score top-N 后读取，无法支持全匹配集的 newest-first keyset。升级 disposable index format marker；将 `(created_at,operation_id)` 建成可排序 fast fields，并把持久 list 所有结构过滤维复制为最小 typed Tantivy fields：`operation_kind, endpoint, state, pid, session_id, agent_id, request_model, response_model`。新增与现有 score-ranked query 正交的 `list-search` 模式，由 sidecar 在完整“全文＋结构 filter”匹配集上按 `(created_at DESC,operation_id DESC)` 排序、应用 `older|newer` cursor、返回 `limit+1` IDs、精确 `total` 和 tail high-watermark/freshness。原 `/history/api/search` 继续 score-ranked、无分页，契约不变。`success` 在主进程先按同一共享 precedence 归一成 state 集合后传入；`from/to/mainAgentOnly` 转成明确范围/null filter，避免 sidecar 复制第二套业务判断。

`GET /history/api/entries?search=` 改为 async handler：sidecar list-search 完成全文、结构过滤、排序、count/keyset；主进程只按返回 IDs 从窄表批量读取 summary JSON并核对 ID/顺序，不再二次过滤改变 total。`QueryOptions` 到 sidecar filter DTO 由单一共享 converter 产生，类型层用 exhaustive `satisfies`/字段集合 guard 防新增 filter 只接一侧。不得用“拉一个大 top-N 再本地过滤”或“先全文分页后结构过滤”冒充完整性。

freshness gate 按请求冻结目标，不追逐持续写入：主进程在发查询前从 authoritative DB 读取 target `(committed_at,operation_id,indexedAtBoundaryMs)`，包含该毫秒已提交 operation ID 集；sidecar response attestation 必须证明其 index generation 已覆盖该 target 及完整边界集，并报告 poison IDs/count。查询发出后的新提交不使本次 503。unreachable、partial、protocol 旧版、未覆盖冻结 target 或 target 区间有 poison 时，list-search 返回 503＋具体 lag/poison 诊断，不返回假空集。持久回归必须执行提交→drain→清空 recent/in-flight cache→重开 fixture，仍能搜索消息/tool 名，且不匹配 model/system/error；另做持续写入、同毫秒晚到 row、poison、正确已追平查询四臂 false-green/false-red。

生产 History 删除面已退役；本轮只修正 `handler.ts` 的陈旧“list / scoped-delete”注释和相关文档，不新增删除 API，并保留 `tests/history/v3/read-consumer-guard.unit.test.ts` 对 `deleteSession/deleteEntries` 的禁止。

## A4. H2 canonical transport diagnostics

**主要文件**：
- `src/lib/transport/http2-client.ts`
- `src/lib/transport/upstream-fetch.ts`
- `src/lib/transport/send.ts`
- `src/lib/transport/http-transport.ts`
- `src/lib/pipeline/types.ts`
- `src/lib/pipeline/generation/dispatch-scheduler.ts`
- `src/lib/pipeline/driver.ts`
- `src/lib/context/types.ts`
- `src/lib/context/request.ts`
- `src/lib/context/model-operation-record.ts`
- `src/lib/history/v3/projection.ts`
- `packages/foundation/src/error/transport-reason.ts`
- `tests/transport/http2-client*.test.ts`
- `tests/transport/http-transport.it.test.ts`
- `tests/history/v3/*diagnostic*.it.test.ts`

### Explicit dispatch ownership

给 `TransportDispatchOptions` 增加必填 canonical `dispatch: DispatchHandle`；实际构造点 `dispatch-scheduler.ts` 已在调用 `open()` 前持有 handle，直接下传。新增 `RequestContext.recordGenerationDispatchDiagnostic(dispatch, diagnostic)`，直接调用 recorder，不使用 `currentAttempt`。Responses HTTP/WS transport choice 同步按显式 handle 记录，逐步收敛 legacy `setAttemptTransport`。Hook/mock transport 也必须透传同一 handle；兼容测试若缺 explicit recorder，用 branded compat handle但不得回退全局 current-attempt 归属。

### Transport event schema

诊断分两层，避免把 session 事件任意归给一个 dispatch或无标记复制给所有 sibling：
- `H2SessionDiagnostic`：`session_id`（进程内单调 ID）、origin、generation/lifecycle、created/retired/closed epochs、effective TCP keepalive/H2 PING/session cap；GOAWAY code/lastStreamID/opaqueData；PING sequence/sentAt/ackAt/durationMs/payload/callback error；rolling outstanding count、last ACK/RTT。由 session owner 保持有界 ring/rolling snapshot。
- `H2StreamDiagnostic`：显式 `dispatch`、session ref、stream ID、phase（acquire/connect/headers/body/end/error/close）、RST code/name、错误 name/code/message、headersReceived、ended、local signal/cancellation/transport reason；在 headers/settle/close 时附 session rolling snapshot version。只有明确影响该 stream 的 GOAWAY/close 才引用到该 dispatch。

敏感 headers/body/token 不进入 diagnostic。stream 事件经 `onTransportDiagnostic` callback 到显式 dispatch；canonical `AttemptDiagnostic` 自然随 manifest/timeline 持久化。session ring 通过稳定 session ref 在 status/独立 transport telemetry 展示；dispatch detail 保存 settle snapshot与关联 session-level terminal events，不复制每个周期 PING 到所有请求。`EntrySummary` 新增紧凑 `transportFailure` 分类/session ref/RST概要用于列表展示和既有 stats 分组；本轮不新增 `QueryOptions` 过滤维或新的公共端点。完整事件只在 detail/export，`docs/API.md` 明确字段为加性诊断且可能为空。

PING 从 NOOP ACK 改为真实 ACK/RTT 观测，但本阶段不据此关闭 session、不改变 cadence；诊断不得改变行为。扩展 `createDispatchLifecycle` 增加 transport-owned teardown barrier 注册；H2 transport在 request 建立后注册 `requestClosed`。每个 stream 建立 exactly-once `releaseStreamSlot()`，由正常 close 与 force-dispose 共用，替代散落的 `activeStreamCount -= 1`。

Barrier 由现有 `generation.cleanup_grace_sec`（默认10s）限定。正常 close先写最后stream diagnostic、detach listeners、release slot再quiesce。每个dispatch diagnostic sink有显式状态`open → forcing → sealed`：普通异步listener只允许在`open`写；force-dispose coroutine持有独立的一次性owner通道，在原子切到`forcing`后，先禁止/ detach data/headers/error等异步producer，但owner通道仍可直接写到该canonical dispatch。Owner依次写`barrier_timeout/close_missing`→对stream发送RST_CANCEL→等待固定且更短的transport teardown尾窗；仍不close则destroy/evict不可复用session并写`forced-session-dispose`及受影响sibling refs；调用同一idempotent release primitive；资源与listener静止后写final dispose snapshot，再把owner通道切`sealed`。迟到close/error只能命中detached listener或exactly-once no-op，不能写sealed recorder、不能重复减slot。只有这之后`dispose/quiesced`才resolve，满足`UpstreamDispatchLifecycle.dispose`“无local callback”契约并返回`connectionReusable=false`。Driver settle/seal前await有界quiescence。对正常end、error/RST、GOAWAY、local abort、close永不发生、callback throw、timeout后迟到close/error、forced session dispose影响sibling写确定性h2c双控；mutation删除/错绑handle、提前quiesce、取消timeout、移除listener fence、提前seal owner通道或破坏exactly-once release时目标History/池容量测试必须红。目标History断言必须从最终持久record读取`barrier_timeout`和dispose snapshot，不能只断内存callback被调。

ACK解释边界写进 schema/docs：ACK只证明对端HTTP/2 connection endpoint回帧，不证明DATA stream可写、flow-control未耗尽、上游应用健康或随后不会GOAWAY/RST。h2c oracle必须包含“ACK正常但DATA stall”“ACK正常后RST/GOAWAY”与“event-loop stall延迟ACK callback”反例，并与stream close/RST时序独立记录。

## A5. 文档、结构复核与独立评审

- 更新 `docs/history-v3-schema.md`、`docs/history.md`、`docs/API.md`、`docs/DESIGN.md` 活架构表；旧 summary 列和假 search/direction 叙述全部清理。
- 每个 semantic commit 跑目标测试；结构提交跑 architecture guards、typecheck、lint、`bun run test:backend`。前端 API 未改形时跑受影响 ui-v4 tests；若 search handler async/wire有改，跑 `test:ui-v4`。
- 对性能 gate 做正样本与反样本：恢复一次 `manifest_gz` 全扫或 OFFSET，确认 gate 红且失败来自目标机制。
- 独立 `gpt-souls:reviewer` 做代码/迁移/错误状态与正确状态双向 review；`verifier` 从 API/History schema 独立推导 oracle，在临时大库和本地 h2c 上验收。逐条核 reviewer 的 file:line，处置后 resume 原 reviewer 复评，直到 blocker/major 清零；最后做 merged-state review。

# Phase B — NGHTTP2_CANCEL 根因实验与缓解裁决

Phase B 在 A4 诊断上线并积累样本后启动；实验代码与“它没有证明什么”写入 `exp/nghttp2-cancel/`，结论落 `docs/todo/` 或新 ADR/spec，不只留对话。

## B1. 建立分型与基线

按真实 diagnostic 把 CANCEL 分成：peer RST_STREAM、session GOAWAY/close、local abort 导致的 CANCEL、主线程 starvation 后积压回调、clean EOF missing terminator。统计每型的 request size/message count、headers/first/last token、tail silence、session age、PING ACK/RTT、同 session sibling、event-loop max-gap。

先校准本地 h2c fake 与真实 node:http2 协议：注入 RST codes、GOAWAY、丢 ACK、silent peer、活动输出中断，确认 fake 的 event sequence/rstCode 与真实 runtime一致。

## B2. A/B 实验矩阵

在非 4141 隔离测试实例上运行，并固定请求/并发/网络条件：

1. H2 PING 15s vs disabled；比较 ACK 可达性、CANCEL 型别和存活时间。
2. TCP keepalive 15s vs disabled；用 `ss -tno` 证明内核 timer 真生效。
3. PING cadence 5/15/30/60s；检验是否存在上游 idle-reaper threshold，避免把频率越高当成越好。
4. 主线程正常 vs 注入现行 History scan 等价阻塞；用 metronome max-gap＋headers/ACK callback delay验证 starvation 因果。
5. fresh session per request vs pooled session；N=1 维持，比较 session age/GOAWAY。
6. 缓冲/continuation retry on/off，按 pre-content、mid-body before/after committed block 分型；核对重复计费、语义连续性和客户端完整终止符。

真实 GHC 只做少量靶向请求，复用相同 prompt/model/max_tokens；先 mock/h2c 覆盖矩阵，再按 `live-ghc-e2e-verification` 补真上游。所有数字锚定 commit、配置和命令，并用第二种原理交叉验证。

## B3. 裁决规则

- 若 CANCEL 前 PING 持续 ACK 且 RTT 正常：只排除“已失去 H2 connection endpoint 响应”这一子假设，不据此判 PING 对该 CANCEL 型无效。PING 是否有效必须由 enabled/disabled 在固定负载、足够样本下比较该型发生率，并结合 stream-level DATA/flow-control/close/RST/GOAWAY 时序裁决；无显著差异才停止盲调并转向上游请求生命周期、model/service limit或流级 policy。
- 若 disabled 复现、enabled 显著消失，且 ACK 证明帧到达：保留/调整 PING，并补统计显著性与副作用；不能只凭一次成功。
- 若 ACK 消失早于 CANCEL：实现可配置的 unacked-ping fast-fail/新 session retry前，先确定 ACK timeout 与误杀率；不把“未 ACK”自动等同连接死亡。
- 若 max-gap 与三连 CANCEL 因果复现：把 event-loop stall 作为独立根因修复，PING 无法在冻结线程里发送，不能作为缓解。
- pre-response close 可 fresh-session retry；mid-body close 只有已有 buffered/continuation 机制满足无重复/无丢失/完整终止符时才启用。不得把 generic `NGHTTP2_CANCEL` 无条件重试。
- 若证据仍混合：保持诊断，不改产品行为；提出下一轮最小可证伪实验，而非给出未经证实的“最佳参数”。

# Verification commands and evidence

执行期按阶段选择，最终至少包括：

- `bun test tests/history/v3/... tests/history/history-summary.it.test.ts tests/history/history-api.it.test.ts`
- `bun test tests/transport/... tests/history/v3/*diagnostic*.it.test.ts`
- `bun run typecheck`
- 目标文件 lint 后 `bun run lint:all`
- `bun run test:backend`
- `bun run build:history-search` 后显式运行 `tests/history/search/*`；断言目标 native suites 实际执行（非 skip），再跑 `bun run test:ci` 覆盖构建＋全后端＋pty/e2e
- `bun run test:ui-v4`（若触及 list/search client behavior）
- `bun run scripts/update-circular-deps-baseline.ts` 仅当架构守卫明确显示合法减环；绝不为过门改 baseline。
- 临时大库 migration dry-run：行数/ID 集/逐行 JSON/typed column/foreign_key_check/integrity_check/磁盘峰值/wall time。
- 非 4141 实例测 `/health`、`/api/status`、默认/过滤/双向 cursor list、sessions/stats；并发 metronome 证明状态轮询不再冻结事件循环。
- `EXPLAIN QUERY PLAN` 保存到测试/exp 产物；mutation 恢复全扫/错误索引时性能 guard 红。
- h2c diagnostic oracle＋少量真实 GHC probe；读取 History detail 证明 diagnostic 落到正确 dispatch，且任何输出都显式脱敏。

# Structural-smell disposition

- `src/lib/history/v3/store.ts` 同时承担 canonical CAS、summary 派生、查询/backfill：本轮把 summary 物理与查询职责抽到 `summary-store.ts`，canonical store只协调同事务提交。
- `src/lib/history/queries.ts` 三源合并与 SQL 过滤混杂：SQL selection下沉，facade只负责 in-flight/recent/persisted去重合并。
- `src/routes/status/route.ts` 健康端点依赖产品 list facade：改专用 count。
- `ui-v4/src/hooks/useStatus.ts` 3s poll 本身合理的前提是 status 常数/低成本；后端修复后保留，若实测仍超预算再按运行态刷新机制单独设计，不先掩盖后端问题。
- `src/lib/transport/http2-client.ts` PING ACK 被丢弃、session/stream无身份、错误只留字符串：本轮补 canonical structured diagnostic，不先调参。
- legacy current-attempt recorder 与并发 hedge 不相容：新增显式 dispatch diagnostic API，逐步消除 transport 层 legacy setters。
