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

**代理管线四段命名**（与 `httpHeaders` 的 inbound/outbound 术语对齐）：

- `inboundRequest` — client → proxy：客户端原始入站请求
- `effectiveRequest?` — sanitize/truncate 后的逻辑载荷（不在物理传输轴上，保留原名）
- `outboundRequest?` — proxy → upstream：发往上游的最终 wire 请求（含 payload）
- `outboundResponse?` — upstream → proxy：上游原始响应
- `inboundResponse?` — proxy → client：实际转发给客户端的响应（经 server-tool 过滤 / tool-name 还原 / tool-input decode 改写后）。`{ content?, sseEvents? }`——非流式存改写后 content，流式存转发帧序列。与 `sseEvents`（上游原始流）并存，构成"上游发了什么 vs 客户端收到什么"对照视图

`sseEvents: Array<SseEventRecord>` 记录上游原始 SSE 流，`SseEventRecord = { offsetMs, type, raw }`——`raw` 为上游 `data:` 原始字节串（含 keepalive，无 parse 往返丢失），`type` 供索引。

运行时表示（`RequestContext` 的 `response`/`forwardedResponse` getter、`Attempt.wireRequest`、`HeadersCapture`）保留旧名，仅持久化 schema 采用上述命名。完整类型定义见 `src/lib/history/types.ts`。

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

### 崩溃回收（pending → interrupted）

由于请求一进来即落盘（见下文增量持久化），进程崩溃会在 SQLite 留下停在非终态的 head 行。两条回收路径把它们标为 `interrupted`（失败桶终态，可被淘汰）：

- **启动期**（`connection.ts::reclaimOrphanedActiveRows`）：`openDatabase` 时把所有**非本进程**（pid/boot_time 不匹配）的 `pending`/`executing`/`streaming` 行标为 `interrupted`——上一个已死进程的孤儿。
- **运行期**（`reaper.ts::reclaimStaleActiveRows`）：reaper 周期内把**本进程**中 `started_at` 超过 `timeouts.stale_request_max_age` 的活跃行标为 `interrupted`——防御同进程内未正常 settle 的 head 行无限堆积。

## 数据库位置

默认路径：`$XDG_DATA_HOME/copilot-api/history.db`，未设置 `XDG_DATA_HOME` 时回退到 `~/.local/share/copilot-api/history.db`。

可通过 `config.yaml` 中的 `history.db_path` 覆盖。

## 进行中 vs 持久化（增量持久化）

- **进行中请求** —— 存在于内存 in-flight 映射（`src/lib/history/in-flight.ts`），通过 WebSocket 推送 `entry_added` / `entry_updated` 给前端。**in-flight 是前端实时视图的权威源**。
- **持久化（增量）** —— 不再只在终态一次性写盘。请求生命周期的各阶段**增量**写入 SQLite：
  - 请求进入（`originalRequest`）→ eager 写 head 行（`status=pending`）+ `inbound_request` stage（同一事务，FK 安全）
  - 每次状态转换（`state_changed`）→ 更新 head 行 status
  - 每次 attempt 更新 → 增量写该 attempt 已具备的 stage（`outbound_request` 在**发请求前**写，崩溃也留下"发了什么"）
  - 终态（`completed`/`failed`/`aborted`）→ 写齐所有 stage + 终态 head，单事务（`insertCompletedEntry`）
- 这样进程被 SIGKILL/OOM/崩溃时，未达终态的请求**仍在 SQLite 留有可发现的记录**（不再零落盘）。

**双源一致性契约**：active 请求同时有 in-flight 内存对象与 SQLite 的 head + 部分 stage 行。读取优先 in-flight（`getEntry = getInFlight(id) ?? getEntryById(id)`），故 active 请求恒读内存全量、不读半截 SQLite。SQLite 仅作持久化、WS 仅作实时，二者 schema 不同、互不校验。崩溃后 in-flight 消失，SQLite 半截行经回收为 `interrupted` 才被读取。

REST 查询透明合并两源（in-flight 在前，SQLite 在后，按 `startedAt` DESC 排序，按 id 去重）。

## 持久化韧性（写失败不静默丢数据）

每一次 history SQLite 写都经 `src/lib/history/persist-guard.ts` 的 `runHistoryWrite` 守卫，取代历史上"裸 `try/catch` → `consola.warn` → 继续"的盲吞模式（那种模式让真实且反复发生的写失败——`FOREIGN KEY constraint failed`、WAL 争用下的 `SQLITE_BUSY`、序列化 bug、磁盘满——全部降级成一句 warn 且无人知晓）。守卫做三件事：把错误分类为 **transient**（`SQLITE_BUSY`/`LOCKED`/`IOERR`，稍后重试可成）vs **permanent**（约束/`TOOBIG`/序列化）；以 **ERROR**（非 warn）日志暴露，进而经 file sink / console / `system.log` 总线可见；按 `stage:class` 计数（`getHistoryPersistErrorStats()`，可查可告警）。

**增量写（eager head / head-status / stage）** 是尽力而为的优化（finalize 才是权威写），失败时仅记 ERROR + 计数，不重试——但 `persistEntryStages` 现为 **head-first 原子写**（同事务内先 upsert head 再写 stages），从根上消除了"stage 写时 head 不存在"的 FK 失败类。

**finalize 无损**：in-flight 内存副本是 entry 的最后存活源，故**仅在确认写成功后才 `removeInFlight`**。终态写失败时：

- **transient** → 保留 in-flight 不动，由 reaper tick 的 `retryPendingFinalizations`（经 `setReaperTickHook` 注册）在 WAL 争用消退后重试，上限 `MAX_FINALIZE_RETRIES`（5）次；
- **permanent / 重试耗尽** → 降级写一行 **head-only tombstone**（`upsertHeadRow`，保住失败事实：status/model/error/timing/token；只丢体积大的 stage blob），再丢内存副本以 bound memory。

这条链直接修复了一类隐性数据丢失：旧 `finalizeEntry` 把 `insertCompletedEntry` 的抛错吞成 warn 后**无条件 `removeInFlight`**——终态写一旦失败，entry 既没上盘又从内存唯一副本删除 = 彻底蒸发，而越大的 entry（在 WAL 争用下）越易触发。失败请求连同其 `sseEvents` 可靠落盘，是事后从 history 诊断上游怪象（如 `NGHTTP2_CANCEL` 流中断）的前提。

> 注：tombstone 计数 `getHistoryPersistErrorStats()` 暂未接入 `/api/status`（避免投机性表面）；需要时由 status 路由读该 getter 即可。

**tombstone 的已知退化**（写不进全量时的可接受降级，非缺陷）：

- tombstone 只写 head + `inbound_request` + `outbound_response` 两个小 stage（保住请求内容 + 失败原因），**跳过** `sse_events`/逐 attempt 请求体等大块——它们正是最可能撑爆全量写的部分，故诊断上游流细节（如逐帧 `sseEvents`）在 tombstone 行不可得。
- tombstone 走 `upsertHeadRow`，**不重算 session 聚合**（仅 `insertCompletedEntry` 重算）。若该 tombstone 是其 session 最后一个 entry，session 的 request_count/token 统计不含它；若该 session 后续有别的 entry 正常 finalize，`recomputeSession` 会把已是 failed 终态的 tombstone 行纳入、自愈。
- transient 重试期间崩溃：entry 仍以 eager 写的 `pending` 状态留在库里（finalize 不更新 head status），下次启动 `reclaimOrphanedActiveRows` 标为 `interrupted`——即一个实际 failed 的请求可能最终记为 `interrupted`（失败桶终态，事实不丢但状态语义降级）。
- 读侧地板：head-only 行（连 tombstone 的 stage 都没写进）经 `deserializeEntry` 把缺失的 `inboundRequest` 兜底为 `{ model }`，保证 `getEntry`/详情/导出消费者不因 `inboundRequest` 为 undefined 崩溃。
- 无周期维护时（`history.reaper_interval: 0`）transient 失败立即降级 tombstone：deferred-finalize 重试只能由 reaper tick 驱动，`reaper_interval=0` 关掉整个周期 timer（连带 WAL checkpoint / incremental_vacuum），故 `finalizeEntry` 经 `isReaperRunning()` 门控直接 tombstone（不滞留泄漏）。注：**仅 `reaper_interval=0` 触发**——`success_limit`/`failure_limit=0`（无限保留）下 timer 仍跑（淘汰自 no-op），drain 不受影响。

## 表结构（Head 表 + Stage 子表）

SQLite schema 定义在 `src/lib/history/sqlite/schema.ts`（权威 DDL）。重数据从单表单 blob 拆为 **head 表 + stage 子表**的 1:N 模型，使 reaper 分桶 / stats 聚合 / 游标分页 / session 重算继续只作用于 head 表 `entries_v2`（每请求恰一行）。

**`entries_v2`（HEAD，每请求一行）** 主要列：

- `id TEXT PRIMARY KEY`、`session_id TEXT`、`started_at`/`ended_at INTEGER`
- `model`/`endpoint`/`status TEXT` — 基础元数据（`status` 即 `RequestLifecycleState`）
- token 计数、`duration_ms`、`pid`/`boot_time`/`git_sha`（进程身份镜像列，供 SQL 过滤）
- `preview_text`/`search_text` — 列表/搜索用
- `blob_gz BLOB NOT NULL` — gzip 的 **head-meta** JSON（`process`/`pipelineInfo`/`warningMessages`/`attempts` 摘要/`httpHeaders` 等；**不含**被拆到 stage 行的重字段）

**`entry_stages`（1:N 子表）** —— 重 blob 按腿/按 attempt 分行：

- 主键 `(entry_id, stage, attempt_index)`；`FOREIGN KEY(entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE`
- `stage` ∈ `inbound_request` | `effective_request` | `outbound_request` | `outbound_response` | `inbound_response` | `sse_events`
- `attempt_index` — 腿无关阶段（inbound/forwarded/sse）为 `-1`；per-attempt 阶段为 `0..N`
- `blob_gz` — 该阶段的重数据（每次重试的真实 wire payload + 上游响应各占一行 → 保全重试全过程）

**读取**：`assembleFullEntry(headRow, stageRows[])` 把 head-meta 与各 stage blob 层叠重组成完整 `HistoryEntry`；per-attempt 行还原 `attempts[i].wireRequest/response`，顶层 outbound/effective 镜像最终 attempt。**向后兼容**：旧的单 blob 行无 stage 行 → 整 blob 即完整 entry，零数据迁移。

**写入**：head 行用 `ON CONFLICT(id) DO UPDATE`（**不是** `INSERT OR REPLACE`——后者 DELETE+INSERT 会触发 CASCADE 清掉 stage 子行）。

索引：`started_at DESC`、`session_id`、`status`、`pid` 等；`entry_stages(entry_id)`。

## REST API

| 端点 | 说明 |
|------|------|
| `GET /history/api/entries` | 分页查询 entries（支持 model、endpoint、from/to 等过滤） |
| `GET /history/api/entries/:id` | 获取单个 entry |
| `GET /history/api/sessions` | 列出所有 sessions |
| `GET /history/api/sessions/:id` | 获取 session 详情 |
| `GET /history/api/sessions/:id/entries` | 获取 session 的所有 entries |
| `DELETE /history/api/sessions/:id` | 删除 session |
| `GET /history/api/stats` | 聚合统计数据 |
| `GET /history/api/export` | 导出历史（JSON/CSV） |

## WebSocket 实时推送

`/ws` 提供实时事件流，支持主题订阅（`history`、`requests`、`status`）：

- `entry_added` — 新请求开始
- `entry_updated` — 请求状态更新（流式内容、完成、失败等）
- `stats_updated` — 聚合统计变更
- `history_cleared` — 历史清空
- `session_deleted` — 会话删除

## Web UI

| 版本 | 技术栈 | 路径 |
|------|--------|------|
| v1 | 原生 HTML/JS | `/history/v1/` |
| v3 | Vue 3 + Vite | `/ui/` |

前端类型统一从后端 re-export（`~backend/lib/history/store`），不重复定义。

相关代码：`src/lib/history/`、`src/routes/history/`、`ui/`

## 已知暂缓项

增量持久化 + 分阶段重构刻意留下的边界（非缺陷，记录以备后续决策）：

- **流中途崩溃丢部分 SSE 帧**：`sse_events` 在流结束前快照一次（非节流增量 append），故 SIGKILL-mid-stream 会丢失断点前已流出的帧。但 head 行 `status=streaming` 仍使该请求可发现（降级而非静默丢失）。若需零丢帧，可在 `processOneStreamEvent` 加节流 append 落盘。
- **中间失败 attempt 的上游响应体**：重试中失败的非最终 attempt 只在 `attempts[].error`（message）保留，完整 `responseText`/`status` 未逐 attempt 持久化（最终失败的响应体经 `outboundResponse.rawBody` 完整保留）。`outbound_request`（每次重试的 wire payload）已逐 attempt 保全。

> Bug 2（客户端断连记 `aborted`）已统一覆盖**所有**流式 endpoint：Anthropic Messages 经 `processAnthropicStream`，其余（Chat Completions / Responses / Responses-WS / Gemini）经通用 `guardSseIterable`——两者均 shutdown 优先、client-abort 抛 `StreamClientAbortError`，handler 据此记 `aborted` 并跳过向已关闭流写错误帧。
