# History 系统

## 概述

History 系统记录所有 API 请求的完整对话历史，提供 REST API 查询和 WebSocket 实时推送，以及 Web UI 查看界面。

存储方式：**History V3**——独立的内容寻址 SQLite canonical store（`history-v3.db`）。每个已终结的请求经**单写者终端总线**落一条不可变的 `ModelOperationRecord`：semantic object CAS、operation manifest、有序 tracks、timeline chunks、自包含 journal 与可重建搜索投影。进行中请求同时保留在内存 in-flight 映射，用于 WebSocket 实时推送。

> **History V2 已整体移除（2026-07-18）**：旧的 `entries_v2` head + `entry_stages` 逐 attempt 拆表存储、reaper 分桶淘汰、内置三层降温归档、以及全部可恢复 backfill 均已删除，无 V3 等价物（V3 是设计收敛——只落终态、无需分桶淘汰或事后回填）。旧 `history.db`/`archive.db` 在线服务**绝不**打开、读取、迁移、回填或删除；需要时用 `sqlite3` 直接开旧文件取证。历史设计记录见 [docs/archive/2607-history-v2-removal/](archive/2607-history-v2-removal/)。

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

每个请求对应一个 `HistoryEntry`——V3 canonical record（`ModelOperationRecord`）的**投影** shape（`src/lib/history/v3/projection.ts::recordToHistoryEntry`）。它是本项目最复杂的 SSOT 类型，**权威定义 = `src/lib/history/types.ts`**、总览见 [DESIGN.md](DESIGN.md)「类型架构·History 数据模型」。核心形状——两条**正交轴**（attempt 成败 vs entry 客户端结局）、client/upstream 双腿 + 逐 attempt 上游轨：

关键时间字段：

- `startedAt: number` — 请求开始时间戳（ms），必填，用于排序和时间范围过滤
- `endedAt?: number` — 请求结束时间戳
- `durationMs?: number` — `endedAt - startedAt`
- `_index.derived.failureReason?: string` — 非成功终态（failed/aborted/interrupted）的**失败原因投影**，recompute-only（从 `attempts.at(-1).upstreamResponse.error ?? 末尝试 error` 重算）。`EntrySummary.responseError` 回填同源，故列表视图恒显原因

**entry 级两腿**（proxy ↔ client，per-entry）：

- `clientRequest` — client → proxy：客户端原始入站请求。`body` 是入站 payload 本尊（SoT）；`{model, messages, system, max_tokens, temperature, tools, thinking}` 是 `body` 的**非权威**结构化投影（供消费端免解析读取，禁独立漂移）；另带 `method`/`path`/`format`/`headers`/`stream`
- `clientResponse` — proxy → client：实际转发给客户端的响应，**一等公民**（非 `attempts[final]` 投影）。非报错的上游响应不一定等于客户端所见（rewrite / 截断 / abort / buffered-retry 丢弃），故独立建模。`{ status?, headers, body?, sseEvents? }`——非流式存改写后 body，流式存转发帧序列。**客户端结局看 `entry.state`，不看这条腿**

**model 归拢键**：`model: { requested, resolved, multiplier? }`——`requested`=入站客户端名（pre-alias），`resolved`=路由/sanitize 解析后规范名。保住遥测「成功=规范名/失败=别名」拆分。

**per-attempt 上游轨**（proxy ↔ upstream，`attempts[]` 逐次保留——~13 重试策略各产生独立上游往返，常见长度 =1）：

- `effectiveSource` — 本轮 pipeline 工作载荷：`body` = `env.body` 本尊（SoT，逐字保留、不归一 IR）；`{ format, model, messageCount, messages, system }` 是 `body` 的非权威投影；`pipeline` 载本轮 truncation/sanitization/messageMapping。**注**：`env.body` 未必等于客户端端点格式——Gemini 在 route/parse 就 Gemini→CC，故其 `effectiveSource.format='cc'`、原始 Gemini 体只在 `clientRequest.body`
- `upstreamRequest` — proxy → upstream：发往上游的最终 wire 请求，`{ format, synthetic?, model, messages, system, headers, body }`（带 messages 投影，供详情／debug replay 忠实还原）。`synthetic` 是合成上游请求的 provenance，只在 continuation 等合成腿出现；真实 wire body 字节不含该字段
- `upstreamResponse` — upstream → proxy：**每个已 settled 的 attempt 恒载一条**（成功=真实响应；失败=合成裁决，`fail()`/`abort()` 与 `complete()` 对称写入）。`success` = 上游返回完整 2xx 且协议正常终止；`{ success, status?, headers, trailers?, body?, rawBody?, sseEvents?, usage?, stopReason?, model?, responseId?, copilotAnnotations?, toolSearchRequests? }`。成功流上游帧统一进 `upstreamResponse.sseEvents`；失败（非最终）attempt 的帧在 `attempts[].sseEvents`（L2 buffered-retry D1，仅失败 attempt 落 per-attempt 行）
- `responseHeaders` — 逐 attempt 上游响应头（driver 每 attempt 写）

**派生投影层** `_index`：

- `_index.derived`（recompute-only，从 `attempts` 重算）：`{ responseSuccess, currentStrategy, failureReason, attemptCount }`
- `_index.aux`（自由投影）：`{ requestBytes, responseBytes, previewText, warningMessages }`

**一次性预处理** `preprocessing?`：入站变换（非逐轮），从 `pipelineInfo` 提到 entry 级。

**运行时 vs 持久化命名分层**：**live `RequestContext` 仍保留旧名**——`response`/`forwardedResponse` getter、`Attempt.{effectiveRequest, wireRequest, response}`、`_httpHeaders` 捕获袋的 `inboundRequest`/`outboundResponse` 等；仅 `HistoryEntry` 持久化数据模型采用上述 client/upstream 命名（V3 projection 时映射进新腿）。完整类型定义见 `src/lib/history/types.ts`。

### EntrySummary

HistoryEntry 的轻量摘要版本，用于列表展示和 WebSocket 推送。字段与 HistoryEntry 对齐，使用 `startedAt` 作为时间字段。

## V3 存储（`history-v3.db`）

内容寻址 canonical store，DDL 单一源 = `src/lib/history/v3/store.ts` 的 `V3_SCHEMA_SQL`；表结构与直接查库方法权威见 skill `history-sqlite-schema`。核心表：

- `v3_objects` — semantic object CAS：`hash` PK + zstd 压缩 canonical JSON，跨 operation 去重共享 payload/frame 对象。
- `v3_operations` — 每个已提交 operation 恰一行：`operation_id` PK、`revision`/`digest`（幂等/冲突判据）、`kind`、zstd manifest、`pinned`、`committed_at`。**只落终态**——无 V2 那种 pending/executing/streaming 中间态行，故无「误杀在途行」的并发风险维度。
- `v3_operation_summaries` — forward migration 001 建立的窄型产品读投影；ready marker 后 list 页／列表 total／sessions／stats 和 session 页选 ID 均走 typed SQL，不读取 `manifest_gz`。`/api/status` 总数则直接对 canonical `v3_operations` 做专用 `COUNT(*)`，同样不读 manifest，也不依赖 marker。001 兼容 trigger 与 bounded backfill 保证历史／旧写路径同步；pending／poisoned 通过 `/api/status.memory` 可见。停服 002 单源收敛尚未实现，故宽表旧列和兼容 fallback 当前仍保留。
- ordered tracks / timeline chunks / 自包含 journal / 可重建 search 投影 —— 详见 skill。

**写路径**：`v3/store.ts::commitPreparedOperation`/`enqueueModelOperation` + `runDrain`。写者由 `state.ts::initHistory` 订阅 `subscribeModelOperationTerminals` 单例驱动（生产不挂任何 sink——V3 终端持久化是 `initHistory` 内建）。

**内容寻址**：`canonicalize` + `digestBytes` 把语义等价的 payload/frame 归一后按内容哈希去重；搜索只索引 unique semantic object，operation membership 独立保存，权威 operation 不依赖搜索成功。

**可选 raw capture**：`history.raw_capture.enabled=false` 默认关闭。开启后 exact bytes 写独立 `raw.db` CAS；热重载只切新 operation、旧在途 operation 继续写冻结的 store generation 后 drain 关闭；raw capture 失败不阻断代理或 semantic V3。

## 数据库位置

默认路径：`$XDG_DATA_HOME/copilot-api/history-v3.db`（`PATHS.HISTORY_V3_DB`）；可选 raw store 默认为同目录 `raw.db`。旧 `history.db`/`archive.db` 保持原样，在线服务不会触碰。

## 持久化韧性（写失败不静默丢数据）

每一次 V3 SQLite 写都经 `src/lib/history/persist-guard.ts` 的 `runHistoryWrite`/`runHistoryWriteAsync` 守卫（History V2 removal 时从旧 V2 写链采纳进 V3 写路径），取代盲 `try/catch → warn → 继续` 模式。守卫做三件事：把错误分类为 **transient**（`SQLITE_BUSY`/`LOCKED`/`IOERR`）vs **permanent**（约束/`TOOBIG`/序列化）；以 **ERROR**（非 warn）日志暴露（经 file sink / console / `system.log` 总线可见）；按 `stage:class` 计数（`getHistoryPersistErrorStats()`，`v3-commit`/`v3-drain` stage 前缀）。

**冲突不降级**：`commitPreparedOperation` 遇同 `operationId` 不同 revision/digest 抛 `V3OperationConflictError`——这是编程错误信号、**不**经 persist-guard，原样穿透到 `status.conflicts` 计数（`getHistoryPersistErrorStats()` 与 `status.conflicts` 是互不越界的两套计数器）。

**drain-before-close**：终端总线单写者 + `drainV3Writer` 承担 drain-before-close 语义——`shutdownHistory` 在关库前排空未决写，不丢 drain 期间 settle 的请求（承接原 V2 async finalize 的 I4 语义，见 skill `persistence-async-invariants`）。

## DB 维护（周期 tick）

`src/lib/history/v3/maintenance.ts` 的 `startV3Maintenance`/`stopV3Maintenance`（挂 `state.ts::initHistory`/`shutdownHistory`，默认 300s）跑三件套：`incrementalVacuum`（还空间给 OS）+ `checkpointWal`（收回 WAL、缩短锁窗口、降 `SQLITE_BUSY`）+ `runOptimize`（`PRAGMA optimize` 刷新统计）。一次性启动动作在 `connection.ts::openDatabase` 尾部无条件跑：`maybeVacuumOnStartup`（freelist ratio≥25% 且 ≥64MB 可回收才触发 full VACUUM）+ `seedAnalyzeIfNeeded`（`sqlite_stat1` 不存在才首次 `ANALYZE`）。

> **裁决记录**：V3 维护 tick **只保留 DB 维护半职责**，不采纳 V2 reaper 的「reclaim 存活行」半职责（V3 只落终态、无中间态行需回收），也不采纳 `hasLiveForeignOwner` 的「存活共享库跳过 VACUUM」门槛（V3 无并发写者风险维度——`v3_operations` 无「另一进程正在写自己的行」这个并发面）。详见 skill `history-sqlite-schema` DB-health 节。

## schema 迁移（Umzug forward-runner，hybrid）

两层。① **地板（conceptual 000）**= `openDatabase` 的 inline 幂等 reconcile（`V3_SCHEMA_SQL`），每次开库跑、**不进账本**；② **前向 001+** = `sqlite/migrations/` 的 Umzug forward-runner（`applyForwardMigrations`，`state.ts::initHistory` 在 `V3_SCHEMA_SQL` exec 与 `recoverV3Journal` 之间跑一次），已应用迁移名记进 `history_meta(schema_migrations)` 账本。当前 `MIGRATIONS` 登记 `001-operation-summary-projection`：事务内创建窄型 `v3_operation_summaries`、索引与 insert／summary-update／pin-update 三条兼容 trigger。**失败硬阻断**：迁移抛 → `process.exit(1)`（半迁移 schema 比不启动危险，与数据层 never-throw 相反）。迁移使用 `sqlMigration(name, body)` 包 driver `transaction()`，使多语句 DDL all-or-nothing、防 partial-DDL wedge。002 停服收敛命令尚未实现；当前仍是保留宽表旧列和 trigger bridge 的兼容态。框架设计见 [spec/migration-framework-umzug.md](spec/migration-framework-umzug.md)，本轮实施边界见 [plan/2026-08-06-history-read-path-and-h2-diagnostics.md](plan/2026-08-06-history-read-path-and-h2-diagnostics.md)。

## REST API

History 产品读面经 V3 canonical store facade：列表、详情、session 聚合、stats、export、search 都经 V3；不回读任何 V2 表。生产面不导出 `deleteSession`/`deleteEntries`，`clearHistory` 与删除函数仅供隔离测试临时库。旧库不迁移、不归档。

| 端点 | 说明 |
|------|------|
| `GET /history/api/entries` | V3 operation summary 列表与过滤；默认 generation，`operationKind=all` 可包含 bypass operation。支持 `direction=older|newer` 双向 keyset cursor；ready marker 后持久行走窄表，in-flight／recent terminal 同过滤 overlay。recent 未持久时可带 `durability`。带 `search` 时，持久行经独立 Tantivy sidecar 的 `list-search` 模式执行全文＋结构过滤、稳定双向 keyset 与精确 total；sidecar 不可达、协议不兼容、freshness attestation 未覆盖请求冻结目标或目标内存在 poison 时返回 503，绝不把不完整结果冒充空命中。 |
| `GET /history/api/entries/:id` | V3 canonical record 的 `HistoryEntry` 投影。 |
| `POST /history/api/entries/:id/pin` | 设置 `v3_operations.pinned=1`，详情与 summary 立即反映。 |
| `POST /history/api/entries/:id/unpin` | 设置 `v3_operations.pinned=0`。 |
| `GET /history/api/sessions` | V3 generation records 的 per-session 聚合摘要。 |
| `GET /history/api/stats` | V3 persisted + in-flight 去重合并视图统计。 |
| `GET /history/api/entries/:id/export` | V3 entry 投影的 `.json.zst` 下载。 |
| `GET /history/api/export` | V3 全量 JSON / CSV 导出。 |
| `GET /history/api/search` | 经 UDS 查询独立 history-search sidecar 的 `source=inbound` Tantivy 投影；其余 legacy facet 或 sidecar 不可达时返回 `partial:true` 空结果，不回退主 SQLite。 |
| `GET /history/api/search/contains` | 兼容端点；sidecar 无反查索引，当前固定返回空 `reqIds`。 |

字段级端点契约（含参数）见 [API.md](API.md)「History REST」。

以下 `msg_blob`／`req_msg` 子系统只描述保留的 V2 `history.db` schema 与 characterization code，**当前在线服务不打开它，产品搜索也不读取它**。旧 artifact 按“不迁移、不修改”约束保留；当前搜索架构（Tantivy 移出主进程为独立、单独启停的 sidecar 服务）见 [out-of-process search plan](plan/2026-07-21-history-search-out-of-process.md) 与 [DESIGN.md「活的架构现状」](DESIGN.md)；已退役的 in-process v1 见 [archive/2607-history-search-out-of-process/](archive/2607-history-search-out-of-process/history-search-tantivy-v1-retired.md)。旧设计见 [spec/search-index-content-addressed.md](spec/search-index-content-addressed.md)。

- **进行中请求** —— 存在于内存 in-flight 映射（`src/lib/history/in-flight.ts` + `entries.ts` in-flight facade），通过 WebSocket 推送 `entry_added`/`entry_updated` 给前端。**in-flight 是前端实时视图的权威源**。
- **持久化** —— V3 只在请求**终结**时经终端总线落一条不可变 operation record。读取透明合并两源：REST 查询在前拼 in-flight、在后拼 V3 持久，按 `startedAt` DESC 排序、按 id 去重；`getEntry` 优先 in-flight，故 active 请求恒读内存全量。
- `GET /history/api/entries?terminalOnly=true` 按 state 剔除 active 在飞行（pending/executing/streaming），只返回终态条目——给有独立 Live 泳道的消费者（ui-v4）用。过滤作用于 merge 后结果，故 `total`/游标分页保持正确。

> **已知产品缺口（backlog）**：V3 终端总线只在 terminal 触发、无 ingress 阶段写入，故生产 History list 只显示已终结请求（进行中仅经 WS 实时可见、不落 V3）；这与 V2 的「请求一进来即 eager 落 pending head 行、崩溃留 `interrupted` 可发现记录」不同。取舍与「若做需改什么」见 [deferred-backlog.md](todo/deferred-backlog.md)（D-2 in-flight 可见性）。

## Debug-pin（豁免语义）

`v3_operations.pinned`（`INTEGER NOT NULL DEFAULT 0`）是 debug 用的钉住标志。V3 无 reaper 自动淘汰，pin 的语义收敛为「详情/summary 标记 + 未来保留策略的豁免锚点」。唯一写者是 pin/unpin 端点；`pinned` 列独占写、不进 operation manifest 的常规 upsert。REST 用法见 `POST /history/api/entries/:id/pin|unpin`。

## WebSocket 实时推送

`/ws` 提供实时事件流，支持主题订阅（`history`、`requests`、`status`）：

- `entry_added` — 新请求开始
- `entry_updated` — 请求状态更新（流式内容、完成、失败等）
- `stats_updated` — 聚合统计变更
- `history_cleared` — 历史清空
- `session_deleted` — 会话删除

## Web UI

History Web UI 是 ui-v4（React）应用，前端类型统一从后端 re-export（`~backend/*`），不重复定义。相关代码：`src/lib/history/`、`src/routes/history/`、`ui-v4/`。

## 已知暂缓项

历史系统相关的边界项（非缺陷，记录以备后续决策）统一收敛到 [deferred-backlog.md](todo/deferred-backlog.md)，含：

- **D-2 in-flight 可见性**——V3 终端总线只在 terminal 写入，进行中请求不落库、崩溃不留可发现记录（见上文「进行中 vs 持久化」）。
- **V3 projection 非承重字段缺口**——`requestBytes`/`responseBytes`/`max_tokens`/`temperature`/`thinking`/`effectiveSource.pipeline`/上游首包时序等字段已在 `HistoryEntry` 类型声明但 projection 尚未产出。

> 客户端断连记 `aborted` 已统一覆盖**所有**流式 endpoint：Anthropic Messages 经 `processAnthropicStream`，其余（Chat Completions / Responses / Responses-WS / Gemini）经通用 `guardSseIterable`——两者均 shutdown 优先、client-abort 抛 `StreamClientAbortError`，handler 据此记 `aborted` 并跳过向已关闭流写错误帧。此机制在 stream/handler 层、与 history 存储无关，V3 下不变。
