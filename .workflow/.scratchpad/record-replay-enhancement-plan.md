# Record/Replay 机制全面增强 + 进程身份元数据

## 背景：本次 thinking bug 的实测根因（驱动本设计）

经穷尽实测（6+ history.db 探针 + 离线 shim 复刻 + 进程/端口核查）裁决：

- **机制层**：部分 Copilot 上游对 thinking 块发非标准帧 `content_block_start{thinking:"", signature:<非空>}` 紧跟 stop、**无 signature_delta**。标准客户端忽略 start 上的 signature，丢签名 → 回传 `{thinking:"", signature:""}` 双空块 → 上游拒绝 → sanitizer 兜底删除（即 `corrupt thinking` 日志）→ 每轮对话累积。
- **shim 已正确**：`applyThinkingSignatureCompat` 离线喂真实帧能正确输出 `空start + signature_delta`，接入点 [handler.ts:658](../../src/routes/messages/handler.ts) 结构正确，运行时配置 `signature_delta`。
- **但运行时不生效**：实测重启后 `req_..._2`（16:53:37）转发流逐帧等于上游、无合成 signature_delta、TEMP-DIAG 日志未出现。
- **归因瓶颈**：`ss -ltnp` 显示端口 4141 被 **16:53 启动的进程 2544056 独占**，16:59/17:00 启动的新进程 **EADDRINUSE 已退出**（`ps` 确认）。**无法可靠区分"哪条 history 记录由哪个进程产生"** —— 这正是本次诊断耗时的根本障碍。

→ **结论：history 必须记录 pid + 进程启动身份，否则跨重启的归因永远靠时间戳推断（不可靠）。** 这是本增强的第一性需求。

## 目标（用户确认的四层 + 专用列）

1. **进程身份元数据**：每条记录带 pid + 进程启动时间 + 代码版本（git sha + dirty）。
2. **上游响应录制重放**：离线把存档响应重新喂转发管线（processOneStreamEvent/shim/sanitize），复现客户端实收帧。
3. **请求重放到上游**：用存档 outboundRequest 重新打真实上游，复现整条生命周期（e2e，需 token）。
4. **诊断查询/对比 API**：按 pid/session/model 过滤，diff 上游帧 vs 转发帧，统计 corrupt thinking 等异常。

存储策略：**pid 等高频过滤字段提升为 entries_v2 专用列（可 SQL 过滤/索引），其余进 blob。**

## 现状盘点（已读代码）

- Schema：[schema.ts](../../src/lib/history/sqlite/schema.ts) `entries_v2`，列 = id/session/时间/model/endpoint/transport/status/tokens/preview。blob_gz 存其余。
- 序列化：[serialize.ts](../../src/lib/history/sqlite/serialize.ts) `META_KEYS` 决定哪些字段进列、其余进 blob。`deserializeEntry` 合并列 + blob。
- 列迁移：[connection.ts](../../src/lib/history/sqlite/connection.ts) `migrateEntriesSummaryColumns` 已有 PRAGMA table_info + ALTER 的幂等加列模式 —— **直接复用**。
- 记录构造：[consumers.ts](../../src/lib/context/consumers.ts) `handleHistoryEvent` 从 RequestContext 构造 HistoryEntry。
- 类型：[types.ts](../../src/lib/history/types.ts) `HistoryEntry` 已含 inboundRequest/outboundRequest/outboundResponse/inboundResponse/sseEvents/httpHeaders —— **录制数据已基本齐全**。
- 重放雏形：[debug/route.ts](../../src/routes/debug/route.ts) `/api/debug/dry-run-truncate` 已能按 entryId 回放 truncate 函数。**重放骨架已存在，扩展即可。**
- 进程身份源：`process.pid`、`process.argv`、boot 时 `Date.now()`、`git rev-parse --short HEAD` + `git status --porcelain`、package.json version `0.8.4-beta.6`。

## 第一轮 subagent review 修正（已亲手复核数据流裁决）

经两个独立 subagent full review + 主线亲手核对 entries.ts/in-flight.ts/server-tool-filter.ts 数据流，确认以下修正：

- **[C1 注入点] pid 注入在 `consumers.ts:57` 的 entry 字面量**（`field==="originalRequest"` 分支），不碰 `entries.ts:insertEntry`，不进 `updateEntry` 的 `Pick<>` 白名单（白名单不含 process，加了会 TS 编译失败）。亲手验证数据流：`putInFlight` 写内存 → 后续 `updateInFlight` 的 `{...existing,...patch}` spread 天然保留 process → `finalizeEntry` 读 merged 对象落库。pid 只 insert 注入一次即可。
- **[FIX-1.1 fallback 污染] `initProcessIdentity` 必须在 server 监听前调用**（server 未监听时无请求进来，杜绝竞态）。fallback（bootTime:0）走 `consola.warn` 一次或标 `synthetic:true`，让"未初始化即写入"在数据里可见，不静默（原则8）。
- **[FIX-1.3 索引迁移陷阱] `CREATE INDEX idx_entries_v2_pid` 必须放在 migrate 函数内、ALTER 之后**，不能塞进 SCHEMA_SQL——因为 `openDatabase` 先 `exec(SCHEMA_SQL)`(:48) 再 migrate(:49)，旧库执行 SCHEMA_SQL 时 pid 列还没 ALTER，索引引用不存在列会崩。
- **[H3 命名] `migrateEntriesSummaryColumns` 泛化重命名为 `migrateEntriesColumns`**（原则8 命名反映职责），`wanted` 数组作唯一权威加列清单。
- **[FIX-9.1 类型权威] `types.ts` 用 `import type { ProcessIdentity }` 引用，不内联展开**（原则9）。前端通过 `HistoryEntry["process"]` 结构性获得，无需单独 `~backend` re-export（YAGNI）。
- **[H2 双写契约] `serialize.ts` 加注释钉死**："列是 blob 的只读镜像，仅供 SQL 过滤；还原一律走 blob"。process 不进 META_KEYS → 自动完整进 blob（含 version/gitDirty）；列侧 serializeEntry 显式从 `entry.process` 取 pid/boot_time/git_sha。deserialize 零改动（`...restored` 自带 process）。
- **[Phase 2 证据力边界——关键认知修正] 离线重放只反映"磁盘当前代码对存档上游帧的转发结果"，不反映"历史运行时进程做了什么"。** 真正裁决 shim 谜题的关键路径是 **Phase 1 的 `git_sha` 列 + 已存档的 `forwardedSseEvents`**（坏数据记录的 sha 是否含 shim commit），而非 Phase 2 重放。Phase 2 重新定位为"shim 修复后的离线回归 + 通用 forwarding 复现器"。
- **[Phase 2 纯函数破裂] `replayAnthropicForwarding` 不是纯函数**——`serverToolFilter`(闭包持 filteredIndices/clientIndexMap/nextClientIndex)、`toolInputDecoder`(buffering Map)、`streamState` 都跨帧累积状态（已读 server-tool-filter.ts:103-113 实证）。必须"每次重放新建一组实例 + 严格按存档顺序喂帧"。且 `forwardToClient`(handler.ts:716) 耦合 `stream.writeSSE`，需解耦"产出转发帧"与"写 stream"（原则8 根因重构）。
- **[范围收敛] Phase 3 砍掉**（与裁决谜题无关，重打上游引入非确定性反降诊断可重复性，YAGNI）→ 降级为 backlog 文档。**Phase 4 仅保留"按 git_sha/pid 分组 + corrupt thinking 计数"一条 SQL** 前置到 Phase 1 收尾（直接回答"哪个 sha 在产坏数据"），其余异常扫描推迟。需扩 `QueryOptions.pid?` + `applyWhere` 的 `pid=?` 分支。
- **[测试归属] `process-identity` 测试归 `tests/infra/`**（被测在 `src/lib/` 根，非 history 域）；`replay-forwarding` 按是否起 runtime 拆 `.unit`(纯 fixture 帧) / `.it`(读 history entry)。

## 第二轮 subagent review 修正（已亲手核对 write.ts INSERT SQL 等每条）

第二轮 full review 验证第一轮 8 条修正全部 VERIFIED，并发现**第一轮遗漏的阻塞项**（已亲手读 write.ts:10-103 证实）：

- **[CRITICAL-1 write.ts INSERT 遗漏——阻塞项] `INSERT_ENTRY_SQL`(write.ts:10-19) 硬编码 20 列 + 20 个 `?`，`insertCompletedEntry`(:82-103) 按位置手传 20 参数。** 若只改 serialize 不改这里 → `serializeEntry` 填了 `row.pid` 但 INSERT 不写它 → **pid 列永远 NULL → `WHERE pid=?` 永远命中 0 行 → 进程身份归因功能静默失效且无报错**。必须同步：INSERT 列清单加 `pid, boot_time, git_sha`（20→23 列+占位符），`.run()` 加 3 个 `row.pid/row.boot_time/row.git_sha` 参数。**测试必须断言 `SELECT pid FROM entries_v2` 非 NULL**——唯一能机械捕获此遗漏的测试。
- **[MEDIUM-1 migrate 当前无建索引逻辑] `migrateEntriesSummaryColumns`(connection.ts:59-74) 只 ALTER COLUMN，没有任何 CREATE INDEX。** FIX-1.3 说了"索引放 migrate 内"，但要明确：migrate 函数**末尾要新增** `database.exec("CREATE INDEX IF NOT EXISTS idx_entries_v2_pid ON entries_v2(pid, started_at DESC)")`，放在 ALTER 循环之后，`IF NOT EXISTS` 保证幂等。这是新增逻辑，非现有模式复用。
- **[HIGH-1 fallback 仍静默] `getProcessIdentity()` fallback(process-identity.ts:74-76) 当前静默返回 bootTime:0**，与 FIX-1.1 文字要求不符。需加 `synthetic:true` 标记（进 blob 可查）或首次 fallback `consola.warn` 一次。

## Phase 1 权威文件改动清单（11 项，补齐所有遗漏）

| # | 文件 | 改动 | 必须 |
|---|------|------|------|
| 1 | `src/lib/process-identity.ts` | 已存在。补 HIGH-1：fallback 加 `synthetic` 标记或 warn | 必须 |
| 2 | `src/start.ts` | import `initProcessIdentity`；在 server 监听前调用 `initProcessIdentity(packageJson.version)`（line 228 已有 version）+ `consola.info` 打印 pid/sha/dirty | 必须 |
| 3 | `src/lib/history/types.ts` | `import type { ProcessIdentity }`；`HistoryEntry` 加 `process?: ProcessIdentity`；`QueryOptions` 加 `pid?: number` | 必须 |
| 4 | `src/lib/context/consumers.ts` | line 57 entry 字面量加 `process: getProcessIdentity()` + import。**不碰 entries.ts/updateEntry 白名单** | 必须 |
| 5 | `src/lib/history/sqlite/schema.ts` | SCHEMA_SQL 的 entries_v2 加 `pid INTEGER, boot_time INTEGER, git_sha TEXT`。**索引不放 SCHEMA_SQL** | 必须 |
| 6 | `src/lib/history/sqlite/connection.ts` | `migrateEntriesSummaryColumns`→`migrateEntriesColumns`；`wanted` 加三列；**末尾新增 CREATE INDEX**(MEDIUM-1)；更新 JSDoc | 必须 |
| 7 | `src/lib/history/sqlite/serialize.ts` | `EntryRow` 加 `pid/boot_time/git_sha`；`serializeEntry` row 填 `entry.process?.pid ?? null` 等；双写契约注释；META_KEYS 不变；deserialize 零改 | 必须 |
| 8 | **`src/lib/history/sqlite/write.ts`** | **INSERT_ENTRY_SQL 加 3 列+3 占位符；`.run()` 加 3 参数**(CRITICAL-1) | 必须（阻塞） |
| 9 | `src/lib/history/sqlite/read.ts` | `applyWhere` 加 `pid=?` 分支（Phase 4 那条归因 SQL 依赖） | 必须 |
| 10 | `tests/infra/process-identity.unit.test.ts` | 单例捕获、缺 git graceful、reset 重入、fallback 标记 | 必须 |
| 11 | `tests/history/sqlite/pid-column.it.test.ts` | 迁移幂等、**INSERT 后 SELECT pid 非 NULL**(验 CRITICAL-1)、`WHERE pid=?` 命中、旧库 ALTER 后可查 | 必须 |

可选：`docs/DESIGN.md` history 段 + `docs/record-replay.md`（仅文档，非阻塞）。

## Phase 2 解耦具体方案（forwardToClient 拆 IO）

根因重构（原则8）：把"产出转发帧"与"写 stream"拆两层，线上与重放共用单帧处理逻辑，消除两份顺序逻辑漂移。

1. **抽 `computeForwardedFrames(ev, knownParsed, serverToolFilter, offsetMs)`**：跑 `serverToolFilter.rewriteEvent` 算转发帧 + 构造 SseEventRecord，**不写 stream**。返回 `[{record, ev}]`（0/1/多）。
2. **`forwardToClient` 变薄**：调 `computeForwardedFrames` → push `forwardedSseEvents` + `stream.writeSSE`。线上字节级不变（record 与写出 data 同源），回归靠现有 SSE 测试。
3. **抽 `processUpstreamFrameForForwarding(parsed, rawEvent, {filter, decoder, shimMode}, sink)`**：复刻 handler.ts:658-675 的 **shim→decoder→filter 顺序**（状态累积顺序，错位会致 index 重映射不一致）。线上 `processOneStreamEvent` 和重放都调它，彻底消除两份顺序逻辑。
4. **`replayAnthropicForwarding(upstreamSseEvents, cfg)`**（新增，纯离线）：**每次新建一组 filter/decoder 实例**（对应纯函数破裂修正）+ 严格按存档顺序喂帧，调 `processUpstreamFrameForForwarding`。offsetMs 用存档 `rec.offsetMs` 或置 0（diff 时只比 type+raw，忽略 offset）。
5. **`POST /api/debug/replay-forwarding`**：`{entryId}` → `getEntry` 取 `entry.sseEvents`(上游原始) → `replayAnthropicForwarding` → 与 `entry.inboundResponse.sseEvents`(存档转发) diff。复用现有 dry-run 的 entryId 解析骨架。

## 实施阶段

### Phase 1：进程身份元数据（最小、最高确定性，先落地）

**1.1 进程身份单例** `src/lib/process-identity.ts`（新建）
- 启动期一次性捕获：`{ pid, bootTime, version, gitSha?, gitDirty? }`。
- git 信息：启动期 `execSync("git rev-parse --short HEAD")` + `git status --porcelain`，失败则 undefined（不阻塞启动）。打包发布场景无 git → 回退 version。
- 导出 `getProcessIdentity()` 纯读单例。
- 在 [start.ts](../../src/start.ts) 启动期调用 `initProcessIdentity()`，并 `consola.info` 打印 `pid=... sha=... dirty=...`（启动横幅就能看到，肉眼即可归因）。

**1.2 类型扩展** [types.ts](../../src/lib/history/types.ts)
- `HistoryEntry` 加可选 `process?: { pid: number; bootTime: number; version: string; gitSha?: string; gitDirty?: boolean }`。

**1.3 写入** [consumers.ts](../../src/lib/context/consumers.ts)
- `insertEntry` 构造 entry 时注入 `process: getProcessIdentity()`。

**1.4 专用列** [schema.ts](../../src/lib/history/sqlite/schema.ts) + [serialize.ts](../../src/lib/history/sqlite/serialize.ts) + [connection.ts](../../src/lib/history/sqlite/connection.ts)
- entries_v2 加列 `pid INTEGER`、`boot_time INTEGER`、`git_sha TEXT`。
- `migrateEntriesSummaryColumns` 的 `wanted` 数组追加这三列（幂等加列，旧库自动迁移，向后兼容）。
- `serializeEntry`：row 填 pid/boot_time/git_sha；`META_KEYS` 不变（process 整体仍进 blob 保留完整 version/dirty，列只为过滤）。
  - **决策点**：pid 等既进列又进 blob（列供 SQL 过滤，blob 供完整还原）。轻微冗余换查询能力，符合原则7（数据以最丰富形式流动）。
- 加索引 `idx_entries_v2_pid ON entries_v2(pid, started_at DESC)`。
- `EntryRow` 接口加 `pid/boot_time/git_sha` 字段；`deserializeEntry` 从 blob 还原 process（列只是镜像）。

**1.5 测试** `tests/history/process-identity.unit.test.ts` + `tests/history/sqlite/pid-column.it.test.ts`
- 单例捕获正确、缺 git 时 graceful、迁移幂等、按 pid SQL 过滤命中。

### Phase 2：上游响应录制重放（离线，无 token，直接服务本次 shim 调试）

**2.1 提取可重放的转发管线**
- 现状：[handler.ts](../../src/routes/messages/handler.ts) `processOneStreamEvent` 把"上游帧→（shim+filter+decoder）→转发帧"耦合在流式 handler 里。
- 重构：抽出纯函数 `replayAnthropicForwarding(upstreamSseEvents, config): forwardedSseEvents`，喂存档 `sseEvents` 复现 `inboundResponse.sseEvents`。
  - 复用真实 `applyThinkingSignatureCompat` / `createServerToolBlockFilter` / `createToolInputStreamDecoder`，确保与线上同源（原则8）。
- **本阶段直接价值**：离线对任意历史 entry 跑重放，对比"重放转发帧 vs 存档转发帧 vs 期望帧"，一眼定位 shim 是否生效——本次 bug 用这个工具 30 秒可裁决，不必反复重启。

**2.2 重放 API** [debug/route.ts](../../src/routes/debug/route.ts) 加 `POST /api/debug/replay-forwarding`
- 入参 `{ entryId }` 或 `{ sseEvents, config? }`。
- 返回 `{ upstreamFrames, replayedForwardFrames, archivedForwardFrames, diff }`，diff 标注每帧 reshape 与否、signature_delta 有无、corrupt thinking 计数。

**2.3 测试** `tests/anthropic/replay-forwarding.unit.test.ts`
- 用 fixture（嵌签名帧）验证重放产出 signature_delta；用本次真实 entry 验证 diff 正确。

### Phase 3：请求重放到上游（e2e，需 token，门控）

**3.1 重放 API** `POST /api/debug/replay-upstream`（或 CLI 子命令 `replay <entryId>`）
- 用存档 `outboundRequest.payload` 重新走 [anthropic/client.ts](../../src/lib/anthropic/client.ts)，复现整条生命周期。
- `dry_run` 选项：只构造请求不发送（看最终 wire payload）。
- 门控：`getE2EMode()`，不进 offline 全集（对齐测试纪律）。

**3.2 测试** `tests/e2e/replay-upstream.e2e.test.ts`（需 token，单列）

### Phase 4：诊断查询/对比 API

**4.1 查询端点** `GET /api/debug/anomalies`
- 按 pid/session/model/时间过滤（pid 走 SQL 列，快）。
- 扫 entries 统计：corrupt thinking 计数、上游嵌签名帧未 reshape 的记录、orphan tool 等已知异常模式。
- 返回归因表：`{ pid, gitSha, count, pattern }` —— 直接回答"哪个进程版本在产生坏数据"。

**4.2 复用 Phase 2 重放**对每条疑似记录做 reshape 判定。

**4.3 测试** `tests/history/anomalies-query.it.test.ts`

## 跨阶段约束

- **向后兼容**：旧 history 库无新列 → 迁移加列（值 NULL）；无 process 字段的旧 entry → 读出 undefined，UI/查询容忍。
- **测试隔离**：fs I/O 用注入临时目录，绝不碰真实 `$HOME`/真实 history.db（原则 + memory）。DI/fetch-mock，不用 mock.module。
- **文档**：完成后更新 [DESIGN.md](../../docs/DESIGN.md) history 段 + 新增 `docs/record-replay.md`。
- **不启服务器**：仅 typecheck/test，重启由用户手动（原则3）。

## 落地顺序建议

Phase 1（pid）→ Phase 2（响应重放，立即服务当前 bug）优先。Phase 3/4 后续。
每 Phase 独立可提交、独立 review。
