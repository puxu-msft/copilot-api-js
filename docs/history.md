# History 系统

## 概述

History 系统记录所有 API 请求的完整对话历史，提供 REST API 查询和 WebSocket 实时推送，以及 Web UI 查看界面。

存储方式：基于 SQLite + gzip 压缩的磁盘持久化，跨重启可见。采用**增量持久化**——请求一进来即落 head 行，各阶段数据增量写入独立 stage 子行；进程崩溃时未完成请求仍留有可发现记录（标为 `interrupted`）。进行中请求同时保留在内存 in-flight 映射，用于 WebSocket 实时推送。

## 数据模型

### Session

客户端通过 HTTP header（`x-session-id`、`x-conversation-id` 等）或 Responses API 的 `previous_response_id` 标识会话。同一 sessionId 的请求归入同一 Session。

```typescript
interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: string[]
  endpoints: EndpointType[]
  toolsUsed?: string[]
}
```

Session header 候选（按优先级）：`x-session-id` → `x-conversation-id` → `x-chat-session-id` → `x-thread-id` → `x-interaction-id`。

### HistoryEntry

每个请求对应一个 entry，记录请求 payload、响应、时间线事件等。关键时间字段：

- `startedAt: number` — 请求开始时间戳（ms），必填，用于排序和时间范围过滤
- `endedAt?: number` — 请求结束时间戳
- `durationMs?: number` — `endedAt - startedAt`
- `_index.derived.failureReason?: string` — 非成功终态（failed/aborted/interrupted）的**失败原因投影**，recompute-only（从 `attempts.at(-1).upstreamResponse.error ?? 末尝试 error` 重算；P4c-3 已删除旧的顶层 `failureReason` 标量，下沉到 `_index.derived`）。`EntrySummary.responseError` 回填同源，故列表视图恒显原因；reaper/重启恢复对 SQL-only 的 interrupted 行另用 `error_message` COALESCE 兜底

**数据模型：client/upstream 双腿 + 逐 attempt 上游轨**（2026-07-07 重构，见 [RFC](rfc/2026-07-07-history-data-model-restructure.md)）。两条**正交轴**互相独立、不再混用一套 inbound/outbound 命名：**attempt 成败**（`upstreamResponse.success`）vs **entry 客户端结局**（`state`）。

**entry 级两腿**（proxy ↔ client，per-entry）：

- `clientRequest` — client → proxy：客户端原始入站请求。`body` 是入站 payload 本尊（SoT）；`{model, messages, system, max_tokens, temperature, tools, thinking}` 是 `body` 的**非权威**结构化投影（供消费端免解析读取，禁独立漂移）；另带 `method`/`path`/`format`/`headers`/`stream`
- `clientResponse` — proxy → client：实际转发给客户端的响应，**一等公民**（非 `attempts[final]` 投影）。非报错的上游响应不一定等于客户端所见（rewrite / 截断 / abort / buffered-retry 丢弃 / reaper 取消），故独立建模。`{ status?, headers, body?, sseEvents? }`——非流式存改写后 body，流式存转发帧序列。**客户端结局看 `entry.state`，不看这条腿**

**model 归拢键**：`model: { requested, resolved, multiplier? }`——`requested`=入站客户端名（pre-alias），`resolved`=路由/sanitize 解析后规范名。保住遥测「成功=规范名/失败=别名」拆分。

**per-attempt 上游轨**（proxy ↔ upstream，`attempts[]` 逐次保留——~13 重试策略各产生独立上游往返，常见长度 =1）：

- `effectiveSource` — 本轮 pipeline 工作载荷：`body` = `env.body` 本尊（SoT，逐字保留、不归一 IR）；`{ format, model, messageCount, messages, system }` 是 `body` 的非权威投影；`pipeline` 载本轮 truncation/sanitization/messageMapping。**注**：`env.body` 未必等于客户端端点格式——Gemini 在 route/parse 就 Gemini→CC，故其 `effectiveSource.format='cc'`、原始 Gemini 体只在 `clientRequest.body`
- `upstreamRequest` — proxy → upstream：发往上游的最终 wire 请求，`{ format, model, messages, system, headers, body }`（**带 messages 投影**——`rewrites-req` 搜索 facet 读这条腿的 `messages`，丢投影会静默断搜索）
- `upstreamResponse` — upstream → proxy：**每个已 settled 的 attempt 恒载一条**（成功=真实响应；失败=合成裁决，`fail()`/`abort()` 与 `complete()` 对称写入）。`success` = 上游返回完整 2xx 且协议正常终止；`{ success, status?, headers, trailers?, body?, rawBody?, sseEvents?, usage?, stopReason?, model?, responseId?, copilotAnnotations?, toolSearchRequests? }`。成功流上游帧统一进 `upstreamResponse.sseEvents`；失败（非最终）attempt 的帧在 `attempts[].sseEvents`（L2 buffered-retry D1，仅失败 attempt 落 per-attempt 行）
- `responseHeaders` — 逐 attempt 上游响应头（driver 每 attempt 写）

**派生投影层** `_index`：

- `_index.derived`（recompute-only，从 `attempts` 重算、三处同步不变量）：`{ responseSuccess, currentStrategy, failureReason, attemptCount }`——旧顶层标量 `attemptCount`/`currentStrategy`/`failureReason` 已下沉至此（P4c-3 删顶层）
- `_index.aux`（自由投影）：`{ requestBytes, responseBytes, previewText, warningMessages }`。**注**：Group-B 标量（`requestBytes`/`responseBytes`/`multiplier`/`warningMessages`）暂仍作 `HistoryEntry` 顶层列支撑/扁平字段，迁入 `_index.aux`/`model.multiplier` 列入 [deferred-backlog](todo/deferred-backlog.md) 独立跟进

**一次性预处理** `preprocessing?`：入站变换（非逐轮），从 `pipelineInfo` 提到 entry 级。

**运行时 vs 持久化命名分层**：**live `RequestContext` 仍保留旧名、未重构**——`response`/`forwardedResponse` getter、`Attempt.{effectiveRequest, wireRequest, response}`、`_httpHeaders` 捕获袋的 `inboundRequest`/`outboundResponse`/`inboundResponse`/`outboundResponseTrailers`；仅 `HistoryEntry` 持久化数据模型采用上述 client/upstream 命名（sink/`toHistoryEntry` 投影时映射进新腿）。

**读时适配（向后兼容旧库行）**：旧 DB 行的 legacy stage（`inbound_request`/`effective_request`/`outbound_request`/`outbound_response`/`inbound_response`）经 serialize.ts 的 `adaptLegacyLegsInPlace` 读时适配为新的 client/upstream 腿，`_index.derived` 由旧顶层标量重算——故新旧行对消费者呈现同一 shape，零数据迁移。完整类型定义见 `src/lib/history/types.ts`。

### EntrySummary

HistoryEntry 的轻量摘要版本，用于列表展示和 WebSocket 推送。字段与 HistoryEntry 对齐，使用 `startedAt` 作为时间字段。

## 容量管理 (Reaper)

`src/lib/history/sqlite/reaper.ts` 定期清理 `entries_v2`，按**状态分桶**独立维持上限——成功历史与失败历史互不挤占。

每个 reaper tick 由 `runReaperTick` 编排，顺序为：**drain 延后的 finalize**（`tickHook` → `retryPendingFinalizations`，让 transient 失败保留的 entry 重试落盘，先于淘汰以便本 tick 计入）→ stale 活跃行回收 → 按状态分桶淘汰 → `incremental_vacuum` 还空间给 OS → `wal_checkpoint(PASSIVE)` 收回 WAL（控 `-wal` 体积、缩短锁窗口、降低 `SQLITE_BUSY`）。`runReaperTick` 单独导出便于测试，无需等定时器。

- `history.success_limit` — 成功（`completed`）条目上限（默认 50，0 = 无限制）
- `history.failure_limit` — 失败诊断条目上限（默认 200，0 = 无限制）。`failed`/`aborted`/`interrupted` 三种终态进入此桶
- `history.reaper_interval` — 定期清理秒数（默认 600 = 10 分钟，0 = 禁用）
- 旧 `history.limit` 仍作兼容键：缺省 success/failure 时回退到它

每桶按 `started_at ASC, id ASC` 删除最旧条目，保留最新的对应 `limit` 条。**活跃态（`pending`/`executing`/`streaming`）落在两桶之外**——reaper 既不计数也不淘汰进行中请求的 head 行；它们的回收由下文的孤儿/stale 回收负责。删除 head 行时，其 `entry_stages` 子行经 `ON DELETE CASCADE` 一并删除。

> **History V3（2026-07-16 起）**：在线服务只打开独立 `history-v3.db`，不打开、读取、迁移、回填或删除旧 `history.db` / `archive.db` / seal。终态 `ModelOperationRecord` 经单写者落 `v3_*` 表：semantic object CAS、operation manifest、ordered tracks、timeline chunks、自包含 journal 与可重建搜索投影。在线无 count retention、无自动删除、无内置冷归档。

完整表／列／主键／FK／索引、编码、journal 恢复协议及可选 raw sidecar schema 见 [History V3 SQLite schema](history-v3-schema.md)。该文档也明确解释了旧称“history.db + archive.db”与当前 `history-v3.db + raw.db` 的对应及差异。

### Canonical store 与 raw capture

- semantic V3 默认启用，完整记录 generation、Responses WS、count tokens、embeddings 与 Azure 元数据。
- `history.raw_capture.enabled=false` 默认关闭。开启后 exact bytes 写独立 `raw.db` CAS；热重载只切新 operation，旧在途 operation 继续写冻结 store generation 后 drain 关闭。
- raw capture 失败不阻断代理或 semantic V3；status 暴露 generation、gap 与 last error。
- 搜索只索引 unique semantic payload object，operation membership 独立保存；权威 operation 不依赖搜索成功。


### Debug-pin（豁免淘汰）

`entries_v2.pinned`（`INTEGER NOT NULL DEFAULT 0`）是 debug 用的钉住标志。调试时常需保留某条 entry 的完整原始数据（请求/响应/sseEvents/per-attempt），但默认 reaper 会按桶超额淘汰把关键样本挤掉。**pinned 行与活跃态行一样落在两桶之外**——reaper 的 `SUCCESS_WHERE`/`FAILURE_WHERE` 各带 `AND pinned = 0`，而 `evictBucket` 的 COUNT 与 DELETE 子查询共用此谓词，故 pinned 行**既不被淘汰、也不计入 success/failure 名额**（pin 满 limit 条不会把正常历史挤空）。

实现要点：

- **专列独占写**：`pinned` 列**故意不进** `INSERT_ENTRY_SQL` 的列清单与 `ON CONFLICT DO UPDATE SET`——首次插入取 `DEFAULT 0`，后续所有 eager 状态 upsert（pending→streaming→completed）都不会重置它。唯一写者是 `setEntryPinned(id, pinned)`（`write.ts`）的专用 `UPDATE`。
- **非 blob**：`pinned` 是 DB-only 标志（blob 在 finalize 时一次写定，pin 发生在之后），故进 `META_KEYS`、永不序列化进 blob，读时一律由列派生。
- **存在性判定不读 `.run().changes`**：任何 AFTER-write 触发器/级联都可能把额外写入计入 bun:sqlite 的 `changes`，故 `setEntryPinned` 用 `SELECT 1` 判断行是否存在（防御性——旧 `entries_fts` 触发器即此类，P3 已移除但模式保留）。
- **in-flight 同步**：`setPinned`（`entries.ts`）切换列后调 `updateInFlight(id, { pinned })` 同步内存副本——因 `getEntry` 是 in-flight 优先，eager-persisted 但未 finalize 的 entry 否则会读到旧 `pinned`（HTTP 响应与广播都会失真）；`toEntrySummary` 也带 `pinned`，避免 producer 丢字段。
- **广播**：同步后 `publishEntryUpdated`，已连接的 WS 客户端实时反映 `pinned`（不改 stats——pinning 不影响 completed/failed 计数）。
- **pin = 永驻 HOT、永不降温**（三层归档 2026-07-14 起）：pin 既豁免 reaper 自动淘汰、也豁免时间/数量搬迁与手动「立即归档」（时间搬迁 + 数量安全阀 + `archiveNow` 谓词均含 `pinned = 0`）——pinned 行永远留在 HOT 快库、随手可读。产品面删除已移除（无 `DELETE` 端点），故 pinned 行不存在被显式删除的路径。

REST 用法见下文 `POST /history/api/entries/:id/pin|unpin`。

### 崩溃回收（pending → interrupted）

由于请求一进来即落盘（见下文增量持久化），进程崩溃会在 SQLite 留下停在非终态的 head 行。两条回收路径把它们标为 `interrupted`（失败桶终态，可被淘汰）：

- **启动期**（`connection.ts::reclaimOrphanedActiveRows`）：`openDatabase` 时把所有**非本进程**（pid/boot_time 不匹配）的 `pending`/`executing`/`streaming` 行标为 `interrupted`——上一个已死进程的孤儿。
- **运行期**（`reaper.ts::reclaimStaleActiveRows`）：reaper 周期内把**本进程**中 `started_at` 超过 `timeouts.stale_request_max_age` 的活跃行标为 `interrupted`——防御同进程内未正常 settle 的 head 行无限堆积。

## 数据库位置

默认路径：`$XDG_DATA_HOME/copilot-api/history-v3.db`；可选 raw store 默认为同目录 `raw.db`。旧 `history.db` 保持原样，在线服务不会触碰。

## 进行中 vs 持久化（增量持久化）

- **进行中请求** —— 存在于内存 in-flight 映射（`src/lib/history/in-flight.ts`），通过 WebSocket 推送 `entry_added` / `entry_updated` 给前端。**in-flight 是前端实时视图的权威源**。
- **持久化（增量）** —— 不再只在终态一次性写盘。请求生命周期的各阶段**增量**写入 SQLite：
  - 请求进入（`originalRequest`）→ eager 写 head 行（`status=pending`）+ `client_request` stage（同一事务，FK 安全）
  - 每次状态转换（`state_changed`）→ 更新 head 行 status
  - 每次 attempt 更新 → 增量写该 attempt 已具备的 stage（`upstream_request` 在**发请求前**写，崩溃也留下"发了什么"）
  - 终态（`completed`/`failed`/`aborted`）→ 写齐所有 stage + 终态 head，单事务（`insertCompletedEntry`）
- 这样进程被 SIGKILL/OOM/崩溃时，未达终态的请求**仍在 SQLite 留有可发现的记录**（不再零落盘）。

**双源一致性契约**：active 请求同时有 in-flight 内存对象与 SQLite 的 head + 部分 stage 行。读取优先 in-flight（`getEntry = getInFlight(id) ?? getEntryById(id)`），故 active 请求恒读内存全量、不读半截 SQLite。SQLite 仅作持久化、WS 仅作实时，二者 schema 不同、互不校验。崩溃后 in-flight 消失，SQLite 半截行经回收为 `interrupted` 才被读取。

REST 查询透明合并两源（in-flight 在前，SQLite 在后，按 `startedAt` DESC 排序，按 id 去重）。**例外**：`GET /history/api/entries?terminalOnly=true` 按 state 剔除 active 在飞行（pending/executing/streaming，含 eager-persisted 的 streaming head 行），只返回终态条目——给有独立 Live 泳道的消费者（ui-v4）用，使 streaming 请求不会同时出现在 History 列表里。过滤作用于 merge 后结果，故 `total`/游标分页保持正确。

## 持久化韧性（写失败不静默丢数据）

每一次 history SQLite 写都经 `src/lib/history/persist-guard.ts` 的 `runHistoryWrite` 守卫，取代历史上"裸 `try/catch` → `consola.warn` → 继续"的盲吞模式（那种模式让真实且反复发生的写失败——`FOREIGN KEY constraint failed`、WAL 争用下的 `SQLITE_BUSY`、序列化 bug、磁盘满——全部降级成一句 warn 且无人知晓）。守卫做三件事：把错误分类为 **transient**（`SQLITE_BUSY`/`LOCKED`/`IOERR`，稍后重试可成）vs **permanent**（约束/`TOOBIG`/序列化）；以 **ERROR**（非 warn）日志暴露，进而经 file sink / console / `system.log` 总线可见；按 `stage:class` 计数（`getHistoryPersistErrorStats()`，可查可告警）。

**增量写（eager head / head-status / stage）** 是尽力而为的优化（finalize 才是权威写），失败时仅记 ERROR + 计数，不重试——但 `persistEntryStages` 现为 **head-first 原子写**（同事务内先 upsert head 再写 stages），从根上消除了"stage 写时 head 不存在"的 FK 失败类。

**finalize 无损**：in-flight 内存副本是 entry 的最后存活源，故**仅在确认写成功后才 `removeInFlight`**。终态写失败时：

- **transient** → 保留 in-flight 不动，由 reaper tick 的 `retryPendingFinalizations`（经 `setReaperTickHook` 注册）在 WAL 争用消退后重试，上限 `MAX_FINALIZE_RETRIES`（5）次；
- **permanent / 重试耗尽** → 降级写一行 **head-only tombstone**（`upsertHeadRow`，保住失败事实：status/model/error/timing/token；只丢体积大的 stage blob），再丢内存副本以 bound memory。

这条链直接修复了一类隐性数据丢失：旧 `finalizeEntry` 把 `insertCompletedEntry` 的抛错吞成 warn 后**无条件 `removeInFlight`**——终态写一旦失败，entry 既没上盘又从内存唯一副本删除 = 彻底蒸发，而越大的 entry（在 WAL 争用下）越易触发。失败请求连同其 `sseEvents` 可靠落盘，是事后从 history 诊断上游怪象（如 `NGHTTP2_CANCEL` 流中断）的前提。

> 注：tombstone 计数 `getHistoryPersistErrorStats()` 暂未接入 `/api/status`（避免投机性表面）；需要时由 status 路由读该 getter 即可。

**tombstone 的已知退化**（写不进全量时的可接受降级，非缺陷）：

- tombstone 只写 head + `client_request` + `upstream_response` 两个小 stage（保住请求内容 + 失败原因），**跳过** `sse_events`/逐 attempt 请求体等大块——它们正是最可能撑爆全量写的部分，故诊断上游流细节（如逐帧 `sseEvents`）在 tombstone 行不可得。
- tombstone 走 `upsertHeadRow`，**不重算 session 聚合**（仅 `insertCompletedEntry` 重算）。若该 tombstone 是其 session 最后一个 entry，session 的 request_count/token 统计不含它；若该 session 后续有别的 entry 正常 finalize，`recomputeSession` 会把已是 failed 终态的 tombstone 行纳入、自愈。
- transient 重试期间崩溃：entry 仍以 eager 写的 `pending` 状态留在库里（finalize 不更新 head status），下次启动 `reclaimOrphanedActiveRows` 标为 `interrupted`——即一个实际 failed 的请求可能最终记为 `interrupted`（失败桶终态，事实不丢但状态语义降级）。
- 读侧地板：head-only 行（连 tombstone 的 stage 都没写进）经 `deserializeEntry` + 读适配器兜底——旧行缺失的 `inboundRequest` 经 `adaptClientRequest` 降级为最小 `clientRequest`（至少带 `format`），保证 `getEntry`/详情/导出消费者不因请求腿为 undefined 崩溃。
- 无周期维护时（`history.reaper_interval: 0`）transient 失败立即降级 tombstone：deferred-finalize 重试只能由 reaper tick 驱动，`reaper_interval=0` 关掉整个周期 timer（连带 WAL checkpoint / incremental_vacuum），故 `finalizeEntry` 经 `isReaperRunning()` 门控直接 tombstone（不滞留泄漏）。注：**仅 `reaper_interval=0` 触发**——`success_limit`/`failure_limit=0`（无限保留）下 timer 仍跑（淘汰自 no-op），drain 不受影响。

## 表结构（Head 表 + Stage 子表）

SQLite schema 定义在 `src/lib/history/sqlite/schema.ts`（权威 DDL）。重数据从单表单 blob 拆为 **head 表 + stage 子表**的 1:N 模型，使 reaper 分桶 / stats 聚合 / 游标分页 / session 重算继续只作用于 head 表 `entries_v2`（每请求恰一行）。

**schema 演进（hybrid 迁移框架）**：两层。① **地板（conceptual 000）**= `openDatabase` 的 inline 幂等 reconcile（`SCHEMA_SQL` + `connection.ts::migrateEntriesColumns` 按 `wanted` 补列 + bespoke drop），每次开库跑、**不进账本**；② **前向 001+** = `sqlite/migrations/` 的 Umzug forward-runner（`applyForwardMigrations` 在 `start.ts` 的 `initHistory(true)` 后、`startServer` 前跑一次），已应用迁移名记进 `history_meta(schema_migrations)` 账本（与 backfill 标志同表、统一账本）。`MIGRATIONS` 初始空（地板=当前 schema）。**失败硬阻断**：迁移抛 → `process.exit(1)`（半迁移 schema 比不启动危险，与数据-backfill 的 never-throw 相反）。首条真实迁移优先用 `sqlMigration(name, body)`——包 driver `transaction()` 使多语句 DDL all-or-nothing、防 partial-DDL wedge（Umzug 不包事务 + SQLite DDL 自动 commit → 中途抛会留半截未记账、重启卡死）；非事务型迁移须逐语句 re-entrant。设计见 [spec/migration-framework-umzug.md](spec/migration-framework-umzug.md)。

**`entries_v2`（HEAD，每请求一行）** 主要列：

- `id TEXT PRIMARY KEY`、`session_id TEXT`、`started_at`/`ended_at INTEGER`
- `model`/`endpoint`/`status TEXT` — 基础元数据（`status` 即 `RequestLifecycleState`）
- token 计数、`duration_ms`、`pid`/`boot_time`/`git_sha`（进程身份镜像列，供 SQL 过滤）
- `preview_text` — 列表 preview 快筛用（denormalized；`search_text` 列已于 search_index P3 DROP）
- `prev_req_id TEXT` — best-effort 对话血缘（组内时间最近一条、无 FK、与搜索解耦、待线程化）
- `blob_gz BLOB NOT NULL` — zstd 的 **head-meta** JSON（`process`/`pipelineInfo`/`_index`/`warningMessages`/`model`/`attempts` 摘要 等；各腿 `headers`/`body` 随腿进 stage 行，**不含**被拆到 stage 行的重字段）

**`entry_stages`（1:N 子表）** —— 重 blob 按腿/按 attempt 分行：

- 主键 `(entry_id, stage, attempt_index)`；`FOREIGN KEY(entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE`
- `stage`（**新写路径**）∈ `client_request` | `client_response` | `effective_source` | `upstream_request` | `upstream_response` | `sse_events`；finalize 时把冗余请求体折进合并帧容器 `request_group`。**legacy 只读**：旧库行仍带 `inbound_request` | `effective_request` | `outbound_request` | `outbound_response` | `inbound_response`——读时经 `adaptLegacyLegsInPlace` 适配为新腿；`STAGE` 常量（`serialize.ts`）双列新旧名共存
- `attempt_index` — 腿无关阶段（`client_request`/`client_response`/顶层 `sse_events`）为 `-1`；per-attempt 阶段（`effective_source`/`upstream_request`/`upstream_response`/失败-attempt `sse_events`）为 `0..N`
- `blob_gz` — 该阶段的重数据（每次重试的真实 wire payload + 上游响应各占一行 → 保全重试全过程）

**读取**：`assembleFullEntry(headRow, stageRows[])` 把 head-meta 与各 stage blob 层叠重组成完整 `HistoryEntry`——`client_request`/`client_response` 填 entry 级 `clientRequest`/`clientResponse`，per-attempt 行填 `attempts[i].{effectiveSource, upstreamRequest, upstreamResponse}`（含 sseEvents）；legacy stage 行经 `adaptLegacyLegsInPlace` 适配为同一新腿。**向后兼容**：旧的单 blob 行无 stage 行 → 整 blob 即完整 entry、经读适配器补新腿，零数据迁移。

**写入**：head 行用 `ON CONFLICT(id) DO UPDATE`（**不是** `INSERT OR REPLACE`——后者 DELETE+INSERT 会触发 CASCADE 清掉 stage 子行）。

索引：`started_at DESC`、`session_id`、`status`、`pid` 等；`entry_stages(entry_id)`。

## REST API

History 产品读面已切到 V3 canonical store：列表、详情、session 聚合、stats、export、logs、debug replay 与 hook replay 都经 V3 facade；不会回读 `entries_v2`。生产面不导出 `deleteSession` / `deleteEntries`，`clearHistory` 与旧 SQLite 删除函数仅供隔离测试临时库。旧库不迁移、不归档。

| 端点 | 说明 |
|------|------|
| `GET /history/api/entries` | V3 operation 列表与过滤；默认 generation，`operationKind=all` 可包含 bypass operation。 |
| `GET /history/api/entries/:id` | V3 canonical record 的 `HistoryEntry` 投影。 |
| `POST /history/api/entries/:id/pin` | 设置 `v3_operations.pinned=1`，详情与 summary 立即反映。 |
| `POST /history/api/entries/:id/unpin` | 设置 `v3_operations.pinned=0`。 |
| `GET /history/api/sessions` | V3 generation records 的 per-session 聚合摘要。 |
| `GET /history/api/stats` | V3 persisted + in-flight 去重合并视图统计。 |
| `GET /history/api/entries/:id/export` | V3 entry 投影的 `.json.zst` 下载。 |
| `GET /history/api/export` | V3 全量 JSON / CSV 导出。 |
| `GET /history/api/search`、`GET /history/api/search/contains` | V3 unique semantic object 搜索与 object→operation companion；绝不读 V2 搜索表。 |

## 内容寻址搜索 (search_index)

请求历史的全文搜索由内容寻址 `search_index` 子系统提供（取代旧 trigram FTS5 + `search_text` 列，P3 已 DROP）。设计见 [spec/search-index-content-addressed.md](spec/search-index-content-addressed.md)。

**表**（`schema.ts`）：

- `msg_blob(hash PK, text)` — 每条 **distinct 归一化消息**按内容哈希只存一次（git-blob 式）。跨请求/跨轮去重，实测 ~42× 压缩。无 FK，靠孤儿 GC 回收。
- `req_msg(req_id, pos, hash, PK(req_id,pos), FK→entries_v2 CASCADE)` — 请求引用哪些消息（按位置）。索引 `idx_req_msg_hash` 服务 hash→请求查找 + GC 探测。
- `req_aux(req_id, source, text, PK(req_id,source), FK CASCADE)` — 4 个 flat per-request 源：`rewrites-req`/`rewrites-resp`/`req-headers`/`resp-headers`。
- `history_meta(key PK, value)` — 统一 KV 账本：backfill 完成标志（`search_index_version`）+ 续跑游标 + dedup-ratio tripwire stat + **schema 迁移账本（`schema_migrations`，Umzug 已应用迁移名 JSON `string[]`）**。DDL 经 `schema.ts` 的 `HISTORY_META_DDL` 单一源（地板与 `HistoryMetaStorage` 的 bare-DB guard 共用，不漂移）。

**归一化**（`normalize-message.ts`，单一 owner）：`normalizeMessageForIndex(msg, format)` 同时是哈希输入 AND 存储搜索文本，**config-无关、确定、稳定**。递归剥 `cache_control`（Claude Code 每轮前移 ephemeral 断点的唯一易变源，实测剥后同消息跨轮哈希相等）+ own-line `<system-reminder>`/`<ide_*>` 注入块（边界锚定、保留 inline 字面提及）+ sorted-key canonical JSON。绝不复用 config 驱动的 `removeSystemReminderTags`。

**写入**（异步两相，见 [spec/history-finalize-async-offload.md](spec/history-finalize-async-offload.md)）：`insertCompletedEntry` 是 async——phase1 事务**外**算 `buildSearchIndexChunked`（normalize+hash inbound 消息逐批协作让出、jsdiff `alignMessages` 算 rewrites 改动文本、拼 headers；整体 try/catch 降级——build 抛则该 entry 索引置空、绝不阻断 finalize）+ `compressAsync` 经 libuv 线程池并发压缩所有 blob（移出事件循环，消除 ~164ms/请求阻塞），phase2 才开**严格同步**事务 `persistSearchIndex` + 插已压缩 buffer（I7：bun:sqlite 跨 await 不回滚，绝不在 tx 回调内 await）。同步 `buildSearchIndexForEntry` 仍服务 backfill。

**孤儿 GC**：`msg_blob` 无 FK，删请求时 `req_msg`/`req_aux` 经 CASCADE 自动清，但 blob 须显式 GC `DELETE FROM msg_blob WHERE NOT EXISTS(SELECT 1 FROM req_msg WHERE hash=…)`——接 reaper（门控 `deleted>0`）/`deleteSession`/`clearAllEntries` **三删除点**（漏一处则清空后 msg_blob 永久死空间）。

**backfill**（`search-index-backfill.ts`）：历史行建索引 + 重算 preview，**可恢复后台**。`history_meta(search_index_version)` 守卫（非 `user_version`）、compound `(started_at,id)` keyset 续跑、协作式 `stopSearchIndexBackfill()`（`shutdownHistory` 在 `closeDatabase` 前调）、完成才置标志、dedup-ratio tripwire（远低于 ~40× 即 WARN）。`start.ts` 监听后 fire-and-forget、批间让出 event loop、绝不进 `openDatabase` 同步路径。

**`prev_req_id`**：entries_v2 上的 best-effort 对话血缘列（组内时间最近一条、无 FK、**与搜索完全解耦**），待将来对话线程化消费。

> **破坏性删除必高声记录（test-only 原语）**：产品面删除已移除（无 HTTP `DELETE` 端点，spec §3.6）；`clearHistory`/`deleteEntries`/`deleteSession` 仅保留为 **test-only 内部原语**（`resetTestRuntime` 隔离重置依赖）。它们仍 `consola.warn` 打印删除条目数 + 触发来源——一次不可逆全量销毁绝不静默（历史教训：曾因 `clearHistory` 无日志，一条已落盘的失败记录"消失"耗费长时间盲查才定位是 dev UI 误触发删除；现产品面已无此路径）。

## WebSocket 实时推送

`/ws` 提供实时事件流，支持主题订阅（`history`、`requests`、`status`）：

- `entry_added` — 新请求开始
- `entry_updated` — 请求状态更新（流式内容、完成、失败等）
- `stats_updated` — 聚合统计变更
- `history_cleared` — 历史清空
- `session_deleted` — 会话删除

## Web UI

当前 UI 是 Vue 3 + Vite 应用，服务于 `/ui/`（`GET /history` 302 重定向到 `/ui#/v/activity`）。早期的 v1 原生 HTML/JS UI（`/history/v1/`）已移除——代码中唯一 UI 是 `/ui` 的 Vue 应用。

前端类型统一从后端 re-export（`~backend/lib/history/store`），不重复定义。

相关代码：`src/lib/history/`、`src/routes/history/`、`ui/`

## 已知暂缓项

增量持久化 + 分阶段重构刻意留下的边界（非缺陷，记录以备后续决策）：

- **流中途崩溃丢部分 SSE 帧**：`sse_events` 在流结束前快照一次（非节流增量 append），故 SIGKILL-mid-stream 会丢失断点前已流出的帧。但 head 行 `status=streaming` 仍使该请求可发现（降级而非静默丢失）。若需零丢帧，可在 `processOneStreamEvent` 加节流 append 落盘。
- **中间失败 attempt 的上游响应体**：**已解决**（P4c 生产者对齐）——每个已 settled 的 attempt（含重试中失败的非最终 attempt）现恒载 `upstreamResponse`（失败 attempt 经合成裁决），逐 attempt 落 `upstream_response` stage（含 `rawBody`）；`upstream_request`（每次重试的 wire payload）亦逐 attempt 保全。仅**未 settled**（in-flight/interrupted）attempt 可缺 `upstreamResponse`。

> Bug 2（客户端断连记 `aborted`）已统一覆盖**所有**流式 endpoint：Anthropic Messages 经 `processAnthropicStream`，其余（Chat Completions / Responses / Responses-WS / Gemini）经通用 `guardSseIterable`——两者均 shutdown 优先、client-abort 抛 `StreamClientAbortError`，handler 据此记 `aborted` 并跳过向已关闭流写错误帧。
