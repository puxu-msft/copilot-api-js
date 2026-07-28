# Spec A：History 读路径性能核心重构

- 状态：草案，待用户裁决 §10 后冻结
- 日期：2026-07-28
- 拆分说明：本 spec 由一份更大的草案拆出（经三轮异模型对抗评审）。姊妹文档：
  - [Spec B：History 过滤语义收敛](2026-07-28-history-filter-semantics.md) —— model 过滤可索引化、三方过滤语义收敛、`requestBucket` 收紧。**不阻塞本 spec**。
  - [待办 C：任意 filter 组合的 exact total](../todo/history-filtered-exact-total.md) —— 独立立项，可能不做。
- 相关：PoC `exp/history-read-path/FINDINGS.md`；schema 权威 skill `history-sqlite-schema`；端点 SSOT [docs/API.md](../API.md)

## 1. 问题（生产库实测，非推断）

| 端点 | 实测 | 性质 |
|---|---|---|
| `GET /history/api/sessions` | **67.5 s** | UI 会话列表 |
| `GET /api/status` | **36.3 s** | **UI 轮询端点** |
| `GET /api/logs?limit=10` | **4.5 s** | 诊断 |
| `GET /health`（基线） | 5.9 ms | — |

这些路径是**同步** SQL 遍历。实测 sessions 请求期间 `/health` 被阻塞 **30 s 以上**（探测超时上限）——事件循环被独占，所有代理请求（Claude Code 在飞流）一并被卡住。

`/api/status` 最严重：它被 UI 轮询，只为取一个 `total` 就全表扫（`src/routes/status/route.ts:126`）。36 秒级冻结在后台**周期性反复发生**，与有没有人打开会话列表页无关。

实测环境：`history-v3.db` 8.3 GB；`v3_operations` 在调查期间从 33,980 增长到 36,175 行；`manifest_gz` 均值约 56–59 KB / 最大 6.6 MB；`summary_json` 均值约 790 B；`summary_json IS NULL` 与 `v3_summary_backlog` 当前均为 0 行；distinct sessionId = 100。

## 2. 根因

三个缺陷叠乘，全部落在 `visitV3Summaries`（`src/lib/history/v3/store.ts:999`）：

**R-1 白读大 BLOB。** SQL 无条件 `SELECT manifest_gz`，但 `summaryFromRow`（`984-996`）快路径根本不碰它——该 BLOB 只在 `summary_json IS NULL` 走 `hydrateManifest` 时才用，生产库当前占比 0%。全扫白读约 **2.0 GB** 只为拼出 28 MB。

**R-2 ORDER BY 末项不在索引里。** `idx_v3_operations_kind(kind, created_at DESC)` 对 `ORDER BY created_at DESC, operation_id DESC` 只覆盖到 `created_at`：

```
SEARCH v3_operations USING INDEX idx_v3_operations_kind (kind=?)
USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

**R-3 `LIMIT/OFFSET` 翻页。** 第 k 页重走前 k×256 行（O(N²)）；因 R-2 索引无法独力满足 ORDER BY，被跳过的行也要回表读 sort key 并带上大 BLOB——R-2 与 R-3 相乘。实测页成本：offset 0 为 254 ms，offset 33,792 为 19,076 ms。

逐层剥离实测（生产库，同批运行）：

| 变体 | 耗时 |
|---|---|
| A 现状 | 67,880 ms |
| B 去掉 `manifest_gz` | 14,166 ms |
| C 再消除 temp B-tree | **680 ms** |
| D 单遍不分页 | 500 ms |
| E 纯扫描（不 `JSON.parse`） | 300 ms |

> PoC 初版报告的 23.20 分钟是**实验污染**（PoC 自建索引改变了查询计划），已撤回并加防复发闸。对外一律以生产实测 67.9 s 为准。
>
> **E 变体的 300 ms 是本 spec 的关键约束**：即使不读 BLOB、不做 `JSON.parse`，扫过 36 k 行本身就要 300 ms 且随增长恶化。任何仍需扫全表的同步路径都无法满足 `/health < 50 ms`。

## 3. 受影响路径

| 路径 | 入口 | 现状 | 实测 |
|---|---|---|---|
| 会话列表 | `getSessionSummaries`（`sessions.ts:18`） | 全表遍历 + JS 分组 | 67.5 s |
| 会话内请求列表 | `/history/api/entries?sessionId=X` → `persistedSummaryCandidates`（`queries.ts:144`） | 全表遍历后 JS 过滤 | — |
| 状态轮询 | `/api/status`（`status/route.ts:126`） | 只为 total 全表扫 | **36.3 s** |
| 日志列表 | `/api/logs`（`logs/route.ts:64`） | 全表扫 | 4.5 s |
| History 统计 | `/history/api/stats` → `getStats`（`stats.ts:78`） | 全表扫；**被 `ui/` 消费** | — |
| 全量导出 | `exportHistory`（`stats.ts:85`） | `getHistory({limit:1_000_000})` hydrate 全库 | — |
| Responses 会话重建 | `rebuildConversationMessages`（`conversation-rebuild.ts:54`）→ `getSessionEntries` | 全表遍历**并 hydrate 每个 manifest**；在代理请求处理中同步执行 | — |

最后一条只在 **Responses → Chat Completions 的 fallback 腿**上懒触发（`codec.ts:225`）。

## 4. 目标 / 非目标

**目标**

1. **交互路径**响应时间与历史总量解耦：会话列表、会话内请求列表、`/api/status`、`/api/logs`、`/history/api/stats`、Responses 会话重建。
2. 消除同步全表遍历对事件循环的独占（用户裁决走「物化到底」而非移出主进程）。
3. 保持既有对外契约：`total` 精确性、双向游标、stats 三源语义（`ui/` 与 ui-v4 都在消费）。
4. 正确性不退化：分页顺序确定、聚合值与既有投影逐字段一致、不因派生列为 NULL 而静默丢行。

**非目标（明确划界，不是砍范围）**

- **不承诺任意 filter 组合的 exact total 与总量解耦。** 带过滤的 `COUNT(*)` 是 O(匹配行数)——covering index 只降常数、不改复杂度。任意组合 O(1) 需要 OLAP cube / bitmap 倒排，是独立工程，见待办 C。本 spec 保证的是：不再 O(全库) 且不再 hydrate BLOB。低选择性组合（如 `state=completed` 无其它条件）仍线性于匹配行数——**而这正是要退役的全局请求列表页所用的形状，UI 上不再存在，只余 API 消费者**。
- 不把 history 读路径移出主进程（sidecar / worker）。残留代价见 §9。
- 不改动 `ui/`（Vue，退役中）代码，但必须保持它消费的端点契约可用（§5.10）。
- 不引入 History V4，不改变 canonical 存储形态。
- `exportHistory` 保持 O(N)，只要求改流式、内存与总量解耦。它不是交互路径。
- `model` / `search` / `success` 三个维的下推与语义收敛属 Spec B（§5.8 只下推语义已一致的维）。

## 5. 设计

### 5.1 派生列：VIRTUAL generated columns

从既有 `summary_json` 派生。理由：**写入路径零改动、无 backfill、单一事实源不变**，派生列是纯函数投影，不会漂移。

PoC 实测能力边界（bun 1.3.14 / SQLite 3.53.0，Node 24.16 独立复核）：`ALTER TABLE ADD COLUMN ... GENERATED ALWAYS AS (...) VIRTUAL` 成功；嵌套路径 `$.usage.input_tokens` 成功；其上 `CREATE INDEX` 成功。`STORED` 实测失败：`SQLiteError: cannot add a STORED column`。

**空值规范化是契约的一部分。** `json_extract` 对字段缺失或 `summary_json` 为 NULL 一律返回 SQL NULL（两方独立实测确认）。不规范化会让 `SUM` 得到 NULL、写入 NOT NULL 列失败，或在逐行算术中静默漏贡献。

| 列 | 表达式 | 空值处理 |
|---|---|---|
| `session_id` | `$.sessionId` | 保持 NULL（无 session 合法） |
| `started_at` | `$.startedAt` | 承重，迁移 gate 保证非 NULL |
| `state` | `$.state` | 保持 NULL，过滤按 `IS NULL` 显式处理 |
| `endpoint` | `$.endpoint` | 同上 |
| `agent_id` | `$.agentId` | **NULL 是语义值（主 agent）**——`mainAgentOnly` 须译成 `agent_id IS NULL` |
| `pid` | `$.pid` | 保持 NULL |
| `response_success` | `$.responseSuccess` | 保持 NULL（三态） |
| `request_model` / `response_model` | `$.requestModel` / `$.responseModel` | 保持 NULL |
| `effective_model` | `COALESCE($.responseModel, $.requestModel)` | 与 `stats.ts:127` 对齐 |
| 四个 token 列 | `COALESCE(...,0)` | **必须 COALESCE** |
| `duration_ms` | `COALESCE($.durationMs,0)` | 同上 |
| `preview_text` / `response_preview_text` | `COALESCE(...,'')` | 同上 |

### 5.2 索引与 kind 语义

**kind 是四值枚举。** `OperationKind = "generation" | "count_tokens" | "embeddings" | "responses_ws"`（`src/lib/context/model-operation-record.ts:13`），`responses_ws`（`routes/responses/ws.ts:264`）与 `embeddings`（`routes/embeddings/route.ts:48`）原样写入 `v3_operations.kind`。生产库当前只出现两种是**数据现状，不是契约**。

既有语义：`operationKind='generation'` 实际匹配 `kind IN ('generation','responses_ws')`（`queries.ts:92-98`、`projection.ts:448-454`）。这是**集合谓词**——评审用 Bun SQLite 探针实证：`kind IN (...)` 配 `(kind, 排序键)` 前缀索引会重新出现 `USE TEMP B-TREE FOR ORDER BY`。

**采用 SQL `UNION ALL` 归并**（评审实证 SQLite 生成 `MERGE (UNION ALL)`，两腿各走有序 covering index、无 temp B-tree）：

```
MERGE (UNION ALL)
LEFT  → SEARCH ... (kind=?)
RIGHT → SEARCH ... (kind=?)
```

**但「看到 `MERGE` 就判绿」是错的。** 评审分别实测两种索引：仅 `(kind, created_at DESC)` 时外层虽显示 `MERGE (UNION ALL)`，**每条腿仍带 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`**；只有扩到 `(kind, created_at DESC, operation_id DESC)` 才得到两腿纯 covering `SEARCH`。守卫必须先确认索引确实包含 `operation_id DESC`，再断言**整个 plan 无任何 temp 节点**（含各腿内部），不能只看外层。

**不采用 JS 侧 k 路归并**——那会把已下推的排序语义拽回 JS。

**两个承重陷阱**：

1. `idx_v3_operations_kind` 的扩展**不能**靠 `CREATE INDEX IF NOT EXISTS`（同名索引已存在时是 no-op）。必须 `DROP INDEX` 后重建或用新名字。
2. 消除 temp B-tree **只能扩索引，绝不能砍 `ORDER BY` 末项 `operation_id`**——后者破坏 tie-break 确定性，分页下静默丢行/重复。

建索引锁持有期实测约 1–2.4 s/条。

### 5.3 物化 `v3_sessions`

```sql
CREATE TABLE v3_sessions (
  session_id TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  agent_ids_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  first_started_at INTEGER NOT NULL,
  first_operation_id TEXT NOT NULL,
  last_started_at INTEGER NOT NULL,
  last_operation_id TEXT NOT NULL,
  completed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  aborted INTEGER NOT NULL,
  models_json TEXT NOT NULL,
  first_preview TEXT NOT NULL,
  preview TEXT NOT NULL
);
CREATE INDEX idx_v3_sessions_last_started ON v3_sessions(last_started_at DESC, session_id DESC);
```

**存在的唯一理由是结构性的。** 会话聚合的形状是 `GROUP BY session_id ORDER BY max(started_at) DESC`——按聚合结果排序无法被任何 B-tree 满足，独立验证：

```
SEARCH v3_operations USING INDEX idx_poc_session_started (kind=?)
USE TEMP B-TREE FOR ORDER BY          ← 加派生列与索引也消不掉
```

物化后 `SELECT ... ORDER BY last_started_at DESC LIMIT ?` 实测中位数 **0.365 ms**。

集合字段存集合而非计数，以便 distinct 聚合可增量维护；对外投影时才折算成 `agentCount` / `models[]`。

只投影 committed terminal records，不合并 in-flight（与现状一致，`sessions.ts:18-25`）。session eligibility 见 §10-2。

### 5.4 物化统计计数器

```sql
CREATE TABLE v3_stat_counters (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  total_requests INTEGER NOT NULL,
  successful INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  aborted INTEGER NOT NULL,
  interrupted INTEGER NOT NULL,
  total_input_tokens INTEGER NOT NULL,
  total_output_tokens INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL
);
CREATE TABLE v3_stat_model_counts(model TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE v3_stat_endpoint_counts(endpoint TEXT PRIMARY KEY, n INTEGER NOT NULL);
```

`singleton PRIMARY KEY CHECK(singleton=1)` 是必需的：无主键的单行表在 SQLite 里可以有 0 行或多行，而 0 行时 `UPDATE` **静默不更新**。迁移原子插入固定行；reader 断言恰一行；每次 update 检查 affected row count。

`averageDurationMs` 由 `total_duration_ms / total_requests` 算，不存平均值。

**契约边界必须写死，避免各物化表各自猜默认值：**

- `requestBucket = none` 导致四桶之和 < `total_requests` 是**合法状态**，不是 bug。
- `total_input_tokens` / `total_output_tokens` **不含 cache token**（当前 `stats.ts:121-122` 行为）；而 `v3_sessions.input_tokens` **包含** cache read/creation（`sessions.ts:40`）。两者语义不同，不得互相复用。
- `duration_ms` 缺失按 0。
- SQLite INTEGER 累加后映射 JS number 的 `2^53` 精度边界须显式记录。

**`/api/status` 的 `total` 必须保持三源语义。** 当前值来自 `getHistorySummaries`，含 in-flight + terminal bus + persisted 并按 operation ID 去重（`queries.ts:217-269`；terminal bus 在落盘前就把 record 放进 recent map，`terminal-bus.ts:20-35`）。改成裸 `COUNT(*)` 只数 durable persisted，会让异步 writer 未落盘时计数**短暂下降**，而这个数字 UI 直接展示（`ui-v4/.../OverviewShadcn.tsx:44-58`、`ui/.../VDashboardPage.vue:82-94`）。正确形状：`v3_stat_counters.total_requests` + 内存两源增量，按 ID 去重。

**`activeSessions` 不能直接用 `COUNT(v3_sessions)`。** 当前语义是「三源全部 summaries 的 distinct sessionId」，且 `visitV3Summaries(consume)` **不传 kind**（`stats.ts:132`），即覆盖所有 operation kinds；而 `v3_sessions` 只含特定 kind 的 committed terminal。两者不等价。处置见 §10-3。

分桶必须与既有 `requestBucket`（`stats.ts:54`）逐分支等价——该原语的注释记录了它修掉的真实 bug（`state==="completed" || responseSuccess===true` 双条件让一个请求同时进 success 与 failure，两者之和超过 total）。**本 spec 只要求 stats 侧等价；把它提升为公开 `success` filter 原语属 Spec B，那里需要先收紧它的输入类型。**

`recentActivity` 字段初始化为 `[]` 后**代码中再未写入**（`stats.ts:90`），是死字段。本 spec 不擅自删除，处置见 §10-4。

### 5.5 单一 contribution contract

四类物化对象（sessions / counters / model counts / endpoint counts）的资格判据与字段来源各不相同。若各自在 commit 事务里独立拼装参数，会重演本 spec 正在消灭的平行语义漂移。

**要求：一次 canonical projection 产出一份 `OperationProjectionContribution`，所有物化更新只消费这份 record。**

```
operationId
kind
sessionContribution?      // 含 sessionId、first/last tuple、agent、preview
requestBucket
usage                     // 区分 net tokens 与 cache tokens
durationMs
endpoint
requestModel? / responseModel? / effectiveModel?
```

重建（backfill）复用**同一个 contribution producer**——这保证「增量维护」与「全量重建」不会漂移。

**但测试 ground truth 不得复用它**：预期值必须从 canonical fixture 独立声明，否则是同源自证（早期草案曾错误地把「backfill 与重建同一实现」称为「天然独立 oracle」，逻辑上不成立）。

### 5.6 写路径一致性契约

1. **同事务**：全部物化 upsert 与 operation insert 在同一事务内（`commitPreparedOperation`）。测试须覆盖**任一方失败时整体回滚**。
2. **exactly-once**：按 `operation_id` 保证只累加一次。PoC 实测重复 replay 会让 `request_count` 从 250 错增到 251。
3. **代价**：配对实验实测（500 条真实 summary、真实长度随机 manifest、WAL + `synchronous=FULL`、交替顺序、连跑 5 轮）中位附加 **0.08–0.18 ms**。未含 CAS/track/timeline/journal 完整写链与 `v3_stat_*`，实现后须在真实 `commitPreparedOperation` 内复测。
4. **删除**：V3 当前没有 scoped delete / session delete / 归档 move——唯一删除是 `clearV3Store`（`store.ts:1127`），文档明确为 test-only（本 spec 作者与评审各自对照代码核实）。`clearV3Store` 须在同一事务内一并清空全部物化表。注：`routes/history/handler.ts:149-151` 留有已失真的 DELETE 路由注释，应顺手清理。
5. **可重建性**：全部物化表必须可从 canonical operations 完整重建。若将来恢复 scoped delete / move，应对是**同一事务内按受影响 session 原子回扫重建**（平均 319 行 session 中位数 8.84 ms，最大 3,356 行 58.75 ms），而非引用计数。

### 5.7 迁移：三段状态机 + 排他 cutover

**机制：Umzug forward migration（001+），不是 `ensureV3Schema`。** V3 启动路径是 `openDatabase` → `ensureV3Schema` → `applyForwardMigrations`（`state.ts:133-143`），该处注释明写这条 pipe 就是为「第一条真实 001+ migration」准备的。`ensureV3Schema` 每次读写都调用，不是放一次性大变更的位置。

**幂等探测必须用 `PRAGMA table_xinfo`。** 实测确认 `table_info` **不返回** VIRTUAL generated column（`table_xinfo` 返回且 `hidden=2`）。用 `table_info` 探测会导致第二次 `ADD COLUMN` 报 `duplicate column name`。

#### 5.7.1 三段划分与 002 的调度

单个 `up()` 无法同时满足「可恢复的长时修复 + 遇损坏仍能启动 + 不被误记为完成」：`applyForwardMigrations` 在 `up()` 抛错时 rethrow 并使 `initHistory()` 失败（`migrations/run.ts:34-63`），而 `HistoryMetaStorage` 只存 applied 名字数组（`storage.ts:44-79`）。

| 段 | 内容 | 记账 |
|---|---|---|
| **001** | 只创建 repair-state 与 diagnostics schema（`operation_id` + reason + 持久 cursor + phase） | Umzug 正常记账；快、幂等、无长事务 |
| **repair worker** | 按持久 cursor 分批推进；phase ∈ `pending / repairing / blocked / ready`；每批短事务；崩溃后从 cursor 续跑 | 自有状态表，**不经 Umzug** |
| **002** | 仅在 phase = `ready` 时执行 schema cutover | Umzug 记账 |

**002 的调度必须靠 runner 改造，不能靠「什么都不做的 up()」**——后者同样会被记为 applied（`run.ts:49-64` 无条件执行传入的 migrations）。可实施形状二选一：

- **构造 Umzug 前读取 repair phase，未 ready 时不把 002 放进 migrations 列表**；或
- 002 不进入常规 startup `applyForwardMigrations`，由 repair orchestrator 在 ready 后单独调用。

还须定义：worker 达到 ready 后是本进程立即 cutover，还是下次启动 cutover。测试必须证明**未 ready 时 002 不执行、不记账、也不阻止启动**。

#### 5.7.2 cutover 不是「一次原子元数据切换」

**SQLite 没有 `ALTER INDEX ... RENAME`**（本 spec 作者实测：`near "INDEX": syntax error`）。generated column 也必须先加到真实表才能在其上建索引。因此「影子对象预建 + 一次纯元数据切换」不可实现。

可实施形状：

1. `ADD` generated columns（快，元数据操作）
2. 用**最终索引名**逐条构建，**每条有自己的停写/锁窗口**（各 1–2.4 s）
3. 新索引可以先存在而不被读路径依赖——read-path gate 尚未切换
4. 002 最后建立并回填小物化表，然后切换 read-path phase
5. 旧索引后续独立 `DROP`

连接 `busy_timeout` 只有 5 s（`sqlite/connection.ts:18-29`），而三条索引 + backfill 串行下界约 4.2 s、冷态可达 8.4 s——这是**逐条**必须有独立窗口的原因，不能包成一个大事务。验收需**双连接持续写探针**。

**逐条构建必须有 per-index 持久 phase。** 若第二条索引失败，数据库处于「部分新索引」状态；下次启动若只用 `CREATE INDEX IF NOT EXISTS` 判断**名字**，会重蹈「同名旧定义 no-op」的覆辙（§5.2 陷阱 1）。因此 repair/cutover 状态表须包含 index-build 子阶段：

- 每条索引记录 `pending / building / built / verified`
- 验证**不只检查名字存在**，还要核对 `sqlite_schema.sql` 或 `PRAGMA index_xinfo` 与预期列、方向逐一相符
- 每条索引可独立恢复重建
- **全部 verified 后才允许 002**
- 查询计划守卫必须**先断言索引定义完整，再信查询计划**——否则计划守卫会在一个定义错误的索引上给出假绿

#### 5.7.3 cutover 与重叠旧 writer

接管顺序是**先 `notifyReady()`/开始监听，再 `signalPredecessorHandoff`**（`packages/cli/src/start.ts:578-582`，本 spec 作者核实），且 systemd/pm2 路径跳过 manual pidfile 协议（`restart/takeover.ts:18-25`）。所以 takeover 期间新旧进程并存。

危险不在锁冲突（那会报错、看得见），而在：**新进程完成 cutover 后，旧进程仍能成功写 `v3_operations`，但它不认识物化表**——无 SQL 错误、永久少计、重启不自愈（Umzug 已记 002 完成）。

**「写门」若只是新代码里的 version check，对已经在跑的旧 binary 完全无效**（旧 binary 不会执行新代码）。而 DB 层的 capability gate **会造成比静默少计更严重的后果**：

`publishModelOperationTerminal`（`terminal-bus.ts:20-39`，本 spec 作者核实）**不延迟代理响应**，terminal record 经异步 subscriber 落盘，且 rejection 被 `.catch(() => undefined)` 吞掉；writer drain 失败只计入 `failedOperations`，不会把请求交回客户端重试（`store.ts:830-929`）。因此 cutover 后若 trigger 拒绝旧 binary 的 INSERT：请求已交付客户端 → terminal record 写入被拒 → 静默吞掉 → 旧进程退出 → **该 operation 永久消失**。少计可以从 canonical operations 重建，丢失**没有重建源**。

**因此协议是：排他 quiesce 为主，capability gate 仅为最后防线。**

- **排他 quiesce（主协议）**：旧进程停止 accept → drain 全部在飞请求、terminal subscribers 与 V3 writer → 确认无旧 writer → 执行最终 backfill 与 002 cutover → 新进程才开始接流量。**需要重排当前的 zero-downtime 接管顺序**，且必须覆盖 manual / systemd / pm2 三种部署（`restart/takeover.ts:18-25` 显示后两者跳过 pidfile 协议），不能只依赖 pidfile predecessor。
- **DB capability gate（最后防线）**：防止未被编排覆盖的旧进程静默写坏，但**不作为主迁移协议**。必须用旧 binary fixture 实测。
- 若将来确实要在不停写的前提下 cutover，前置条件是**跨进程 durable outbox**——被拒的旧 terminal record 能交给新进程重放。没有它就不满足 richest-data-flow。

另需防止旧 `ensureV3Schema` 把 `schema_version` 写回旧值（`store.ts:277-299` 的 `INSERT OR REPLACE`）。

#### 5.7.4 迁移 gate：`NOT NULL` 不足以保证投影完整

gate 必须是全集，逐条实测通过后才允许移除 canonical fallback：

- `json_extract($.id) = operation_id`
- `json_extract($.startedAt) = created_at`
- `json_extract($.operationKind) = kind`
- `endpoint` / `state` ∈ 有效枚举
- `usage` / `pid` / `durationMs` 的 JSON 类型正确
- 承重字段（`startedAt`）非 NULL

**前置修复：`EndpointType` 必须先补齐 `openai-embeddings`。** `EndpointType`（`types.ts:32-34`）当前不含该值，而 embeddings producer 确实写它（`routes/embeddings/route.ts:47-52`）——若不先补，上面的「`endpoint` ∈ 有效枚举」这条 gate 会把**合法的 embeddings record 判为 poison**，或逼迫实现隐式使用一个未定义的枚举值。这是 canonical producer 的事实校正，不依赖 Spec B 的任何语义裁决，因此归属本 spec（评审 round 4 指出它原先被错置在 Spec B）。

评审在生产库上跑过 cross-column 一致性探针，当前结果为 0 不一致——**这是数据现状，不能替代迁移不变量**。

注：SQLite 3.53 的 `ALTER TABLE ... SET NOT NULL` 在存在 NULL 时整条失败，所以 gate 必须在 DDL 之前。

#### 5.7.5 poison isolation

`summary_json` 为 NULL 或字段缺失时 generated column 得到 NULL（两方独立实测），会导致 `WHERE session_id=?` **静默丢行**。而 `startV3SummaryBackfill`（`store.ts:1023`）补齐失败时会把行写进 `v3_summary_backlog`，此后查询用 `NOT IN (...)` **永久跳过它**——即 `summary_json` 可以永久为 NULL。

「保留旧的慢但正确路径」不成立：canonical manifest/CAS 真损坏时旧路径也会在 `hydrateManifest` 抛错（`store.ts:1149-1240` 对 unsupported format、缺 object、sequence 不完整均 fail-loud），`exportHistory` 同样 hydrate 全库、可能被同一 poison row 卡死。

正确形状（参考 search sidecar 已有设计，`search/daemon.ts:70-87`）：

- diagnostics 持久记录 `operation_id` 与错误原因
- 健康行继续可读，**不因个别坏行整体不可用**
- 产品面返回**显式 partial 标记 + 受影响 ID 列表**，不是静默少数据
- 提供**不 hydrate 的 raw manifest/CAS forensic export** 通道
- 不把会抛错的旧读取器称作可用 fallback

修复完成后 `startV3SummaryBackfill` / `stopV3SummaryBackfill` / `drainV3SummaryBackfill` / `v3_summary_backlog` 由 repair worker 取代并退役。

### 5.8 读路径改造

| 函数 | 改造 |
|---|---|
| `getSessionSummaries` | 查 `v3_sessions` |
| `getSessionEntries` | session 索引 + keyset；**保持升序返回契约**，见下 |
| `persistedSummaryCandidates` | 下推**语义已一致的**维（`sessionId`/`state`/`endpoint`/`pid`/`agentId`/`from`/`to`）+ keyset；`model`/`search`/`success` 留待 Spec B |
| `visitV3Summaries` | SELECT 去掉 `manifest_gz` |
| `getStats` | persisted 部分读 `v3_stat_*`；**保留三源合并去重**（`stats.ts:41-81`） |
| `/api/status` 的 total | 读 `v3_stat_counters` + 内存两源增量（§5.4） |
| `exportHistory` | 保持 O(N)，改流式，内存与总量解耦 |

**`getSessionEntries` 的升序契约是承重的。** 现状返回**升序**（`sessions.ts:140`），`rebuildConversationMessages` 按该顺序 flatten 成对话消息（`conversation-rebuild.ts:54-89`）——顺序反了会让重建的对话时序错乱。改 DESC keyset 后必须：**SQL 按 DESC 取最新 N 条（利用索引），返回前反转为升序**。UI 游标分页与 replay 的「取最新 N、升序返回」是两套契约，不能共用同一函数的原始输出。

**过滤维的下推清单必须在 plan 阶段固化**——每种公开组合走哪条索引、允许什么 access path，逐条列表。不做「所有维都索引可解」这种笼统承诺。

`mainAgentOnly` 译成 `agent_id IS NULL`（NULL 是语义值，不是缺失）。

#### 5.8.1 A/B 接缝：Spec B 落地前的混合查询算法

API 允许 A 维（`sessionId`/`state`/`endpoint`/`pid`/`agentId`/`from`/`to`）与 B 维（`model`/`search`/`success`）**混合使用**，而文档拆分不能让代码在接缝处没有完整算法。

**错误做法（必须避免）**：SQL 按 A 维取一页 `LIMIT n`，再在 JS 里按 B 维过滤。后果是页面不足、cursor 错位、`total` 错误，且后续本应匹配的行已被前一页的 SQL limit 截断。

**在 Spec B 落地前，只要请求含任一 B 维，必须走下列之一**（plan 阶段择一并固化）：

- **保守路线**：继续用旧的完整候选遍历语义，只摘掉 R-1（BLOB 白读）与 R-3（OFFSET）。性能改善有限但语义零风险。
- **分批路线**：SQL 按 A 维做 keyset **分批**扫描，在 JS 侧应用 B 维谓词，**持续拉取直到填满一页或候选耗尽**；`total` 需遍历全部候选后得出。

`search` 在 B 落地前保持当前真实行为（persisted 不过滤，见 Spec B §1.1），或按用户裁决明确破坏契约——**不得默默改变**。

### 5.9 分页语义与 cursor wire

- **会话列表**：一次拿完（物化后 0.365 ms，100 行无压力）。
- **会话内请求列表**：keyset 游标 `(started_at DESC, operation_id DESC)`，ui-v4 改 `useInfiniteQuery`。

keyset 在静态数据下 tie-break 确定：`operation_id` 是随机 UUID 与时间无关，但只要 ORDER BY 与游标谓词完全一致，既有并列行不会丢或重。这与 search sidecar 的永久漏行**不同型**——那里是 append-tail 游标跨轮后同毫秒到达更小 UUID（`search/daemon.ts:9-60`），有限列表分页没有跨轮结构。

**并发插入语义写进契约**：评审实测确认，第一页之后插入、排序上位于游标之前的新行，在后续「更旧」页中永不出现，只有刷新才能看到。这是 keyset 固有行为、可接受，但要显式声明并让 UI 知晓。相应地「同 `started_at` 连跑多次」这类静态测试**抓不到** live mutation。

**cursor wire**：现有客户端传 entry ID（`ui/src/api/http.ts:69-84`、`ui-v4/.../useHistoryInfinite.ts:63-70`）。维持传 ID（服务端按 ID 反查 cursor tuple，一次点查），避免 UI 契约变更；须定义 invalid / 已删除 cursor 的行为。`ui/` 的双向游标（`direction=newer/older`）两个方向都必须可用。

### 5.10 UI

**定位（用户 2026-07-28 明确）：这一轮读路径性能投入的目标读者是 ui-v4 及其后续增强，不是 `ui/`。** `ui/` 正在退役，本 spec 对它的义务仅限于「不改坏它依赖的契约」，不为它做额外适配或性能投入。

- **ui-v4**：`useSessions` 形状不变；`useSessionEntries` 改 keyset `useInfiniteQuery`；全局请求列表页退役（端点保留为 API）。本 spec 建立的派生列 / 索引 / 物化基础设施同时是 ui-v4 后续增强（弱筛选、跨会话检索、统计视图）的地基——见 [待办 C](../todo/history-filtered-exact-total.md)。
- **`ui/`（Vue，退役中）**：不改动其代码，但**必须保持它消费的端点契约可用**——它在用 `/history/api/entries`（含 `total` + 双向游标）与 `/history/api/stats`（`ui/src/api/http.ts:67-104`、`useHistoryData.ts:119-163`）。允许它失效指的是不为它做新适配，不等于可以把它依赖的契约改坏。注意 §10-3 的 `activeSessions` 语义变更与 §10-4 的 `recentActivity` 移除**会对它可见**，这是已裁决的、可接受的变化。

## 6. 验收判据

| 路径 | 判据 |
|---|---|
| `GET /history/api/sessions` | p50 < 50 ms（当前 67.5 s） |
| `GET /api/status` | p50 < 50 ms（当前 36.3 s） |
| `GET /api/logs?limit=N` | p50 < 50 ms（当前 4.5 s） |
| `GET /history/api/stats` | p50 < 50 ms |
| `GET /history/api/entries?sessionId=X` | p50 < 50 ms |
| Responses 会话重建 | 与总量解耦 |
| `GET /history/api/entries` 带**高选择性**过滤 | p50 < 100 ms |
| 带**低选择性**过滤的 exact total | O(匹配行数)，**不承诺与总量解耦**（§4 非目标） |
| `exportHistory` | 保持 O(N)；**内存**与总量解耦 |
| 任一**交互**请求进行中 | `/health` < 50 ms |
| 迁移期间 | 见 §5.7.2 双连接写探针；不要求 `/health < 50 ms` |

**查询计划判据按查询逐条给出允许的 access path，不做全局禁词：**

- `v3_operations` 列表/过滤查询：`SEARCH ... USING INDEX`；禁 `USE TEMP B-TREE`；禁读 `manifest_gz`
- `v3_operations` exact count：**允许** `SCAN ... USING COVERING INDEX`（实测这是正确计划）
- `v3_sessions` 会话列表：**允许** `SCAN v3_sessions USING INDEX idx_v3_sessions_last_started`；禁 temp B-tree、禁扫 `v3_operations`

> 早期草案两次写成一刀切「无 SCAN」，两次都与正确计划自相矛盾（物化表、exact count）。判据必须 per-query。

正确性判据：

1. 全部物化表每行每字段与从 canonical operations 重算的结果逐字段相等。
2. 同一 operation 重复 replay 不改变任何物化计数。
3. 迁移 gate（§5.7.4）全部通过；存在不可修复行时进入 §5.7.5 的 partial 状态。
4. SQL 分桶与 `requestBucket` 逐分支等价，且四桶之和 ≤ total 恒成立。
5. `v3_stat_counters` 恒有且仅有一行。

## 7. 测试策略

- **查询计划守卫**（unit）：按 §6 per-query 断言。**必须配正样本对照**——先用故意错的索引证明守卫会红。
- **聚合正确性**（it）：**ground truth 用构造的 canonical `ModelOperationRecord`/manifest 独立声明**，不能用现有 JS 聚合或 contribution producer 当 oracle（同源自证）。覆盖每个字段、NULL/缺字段、`responses_ws`/`embeddings` kind。
- **分桶等价**（it）：SQL 分桶 vs `requestBucket`，覆盖 state × responseSuccess 全组合，含 `state=failed && responseSuccess=true`（上游 200 但代理判失败）。
- **contribution 单一性**（it）：增量维护与全量重建产出相同物化状态。
- **exactly-once + 回滚**（it）：重复提交不改计数；任一物化 upsert 失败时整体回滚。
- **singleton 约束**（it）：counters 表恒一行；0 行时 update 必须报错而非静默 no-op。
- **keyset 分页**（it）：并列 `started_at`、**页间插入新行**、两个 `direction`、刷新语义、同毫秒 UUID 两侧、invalid/已删除 cursor。
- **Responses replay 顺序**（it）：断言返回最新 N 条且**升序**。
- **迁移状态机**（it）：001 幂等（`table_xinfo` 探测）；**未 ready 时 002 不执行、不记账、不阻止启动**；repair 第 k 批后退出 → 从 cursor 续跑；`blocked` 修复后进入 `ready`；002 中途失败可重试；**predecessor 在 cutover 边界完成旧格式写入**（§5.7.3）。
- **迁移并发**（it）：双连接持续写探针，实测每条索引的锁持有窗口。
- **`clearV3Store` 一并清空全部物化表**（it）。

## 8. 未采纳方案及理由

**L1：把 history 读路径移出主进程。** 用户先裁决「跟着消掉」，其依据被 round 2 评审推翻后**重新裁决为「物化到底」**。残留限制见 §9。

**generated column + SQL `GROUP BY` 直接算会话列表（不建物化表）。** 实测可行且与独立 JS oracle 完全一致（101 个 session），但中位 1,303 ms，且结构上无法消除 `ORDER BY max(started_at)` 的 temp B-tree。

**真实列 + 写入时双写。** 多出双写不一致与一次性 backfill，换不来任何查询能力。

**引用计数维护 distinct 聚合。** 只解决 distinct set，解决不了首尾行与跨库 crash consistency。

**砍 `ORDER BY` 末项消除 temp B-tree。** 静默丢行/重复。

**把 schema 变更塞进 `ensureV3Schema`，或塞进单个 Umzug `up()`。** 前者是每次读写都调用的函数；后者在两态 ledger 上无法同时满足三个要求（§5.7.1）。

**「影子索引 + 一次原子 rename cutover」。** SQLite 无 `ALTER INDEX RENAME`（实测语法错误），机制不存在。

**JS 侧 k 路归并处理 `kind IN (...)`。** 把已下推的排序语义拽回 JS；SQL `UNION ALL` 已实证可生成无 temp B-tree 的 `MERGE`。

## 9. 风险

- **PoC 保真度边界**：合成库只复制 `v3_operations`（含真实 BLOB 长度分布与 overflow-page 布局，2.07 GB），未复制其它 V3 表，不等价于完整 8.3 GB 生产文件的页缓存竞争。数字用于路线裁决；落地后须在生产库复测验收判据。
- **写路径代价需复测**：0.08–0.18 ms 未含完整写链与 `v3_stat_*`。
- **cutover 与重叠旧 writer**：§5.7.3 需要部署契约配合，可能要求重排接管顺序，不是纯代码问题。
- **物化到底的残留**：`exportHistory` 仍是 O(N) 同步 hydrate，导出期间事件循环仍会被占用。这是「不做 L1」的已知代价，明确接受并记录。
- **低选择性 filtered count 仍线性于匹配行数**：见 §4 非目标与待办 C。
- **8.3 GB 库体积本身**：不在本 spec 范围。R-1 修复后白读的 2.0 GB 消失，冷读放大自然缓解；缩容见 skill `shrinking-a-live-sqlite-db`。

## 10. 裁决记录

以下四项均已由用户于 2026-07-28 裁决，**本 spec 据此冻结**。

**10-1 cutover 与重叠旧 writer**（§5.7.3）：**排他 quiesce 为主协议，接受迁移那一次重启的短暂写入停顿**；DB capability gate 仅作最后防线。

> 早期草案推荐反了（把 capability gate 当主协议）。round 4 评审证伪：terminal record 经异步 subscriber 落盘且 rejection 被吞（`terminal-bus.ts:20-39`，本 spec 作者核实），gate 拒绝旧 binary 的 INSERT 会让**已交付客户端的 operation 永久消失**——少计可从 canonical 重建，丢失没有重建源。它不是 fail-loud，是 silent loss。用户裁决：宁可接受秒级写入停顿，也不接受任何 canonical History 丢失。

**10-2 `v3_sessions` 的 session eligibility**：**纳入 `responses_ws`**。它同样是带 sessionId 的真实对话轮次，排除它会让会话统计与请求列表对不上（全局列表的 `operationKind=generation` 本就包含它）。须加带 sessionId 的 `responses_ws` canonical 正样本测试。

**10-3 `activeSessions` 的定义**（§5.4）：**重新定义为「会话列表所示的会话数」**，即 `COUNT(v3_sessions)`。这与用户实际看到的会话列表一致；旧语义（三源全部 kinds 的 distinct sessionId）维护的是一个界面上看不到的口径。**这是对外可见的语义变化**：数字将不再包含 `count_tokens` / `embeddings` 等非对话操作的 session，文档与 UI 命名须同步。

**10-4 `recentActivity` 死字段**（§5.4）：**本次一并移除**。它初始化为 `[]` 后从未被写入（`stats.ts:90`），保留只会让消费者误以为有数据。移除须同步 `HistoryStats` 类型与两个 UI 的类型引用。
