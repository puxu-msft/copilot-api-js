# Spec：请求首包/时序埋点（request timing instrumentation）

- 状态：**草案（待用户 review → writing-plans）**
- 日期：2026-07-14
- 归属：`docs/spec/`；相关 ADR 见文末「决策记录」；活的架构现状落 `docs/DESIGN.md`
- 评审：已过 3 轮异模型对抗 subagent review（GPT + Claude 交叉）。R1/R2 修 4 个 HIGH（per-attempt 存储 / 首包谓词 / 不回填 / 列式接线 / live 通道）；R3 针对本文档，修 attempt 原点矛盾、per-attempt 接线缺口、遥测 3 点接线、aborted 覆盖面、`/metrics` 副作用、7 刻冻结、命名。本稿为 R3 采纳后版本

## 1. 动机（What & Why）

### 1.1 问题

排查两条 15 分钟超时请求（`req_1783967876376_569` / `req_1783967868640_568`）时，扩大到全库 >=60s 请求分析发现：

- **当前无任何首包/TTFB 埋点**。`attempts[].firstByteMs` / `ttfbMs` 类字段不存在。首包时刻只能解 4MB blob 反推。
- **反推不可靠**。客户端 forwarded 轨真实内容帧的 `offsetMs` 在缓冲模式下**全部折叠成 flush 一个值**（实测 req_771：464 帧共享同一 offset）；上游 raw 轨 offset 约半数亦折叠；`offsetMs` 原点是 `streamStartMs`（≈commit 时刻）而非 `started_at`，两套原点混淆。
- **两个「首包」严重分离**。实证 60 样本：上游 TTFT p50≈6s / p90≈24s；客户端可见首包 p50≈79s / p90≈229s / max≈356s。差异源于**所有长请求走缓冲**（客户端全程收 keepalive 空 delta、真实内容末尾一次性刷出）。实测该部署缓冲来自 `protect_streaming_generation = tool_use_only`（非 L2 buffered-retry，后者默认 OFF）。

### 1.2 目标

在**各事件真实发生点**捕获权威时刻（而非 finalize 时从不可靠帧 offset 反推），使以下问题可被一条查询/一个面板回答：

- 上游真实 TTFT 分布（按 model / endpoint 维度的 p50/p95/p99）
- commit → 客户端可见首包的「keepalive 空窗」时长
- 缓冲扣留时长（客户端可见首包比上游 TTFT 晚多少）
- 单请求级：每个 attempt 的上游时序（含失败 attempt）

### 1.3 非目标

- **不改缓冲行为**。「所有长请求缓冲、客户端可见首包 ≈ 全程时长」是真实 UX 问题，但改缓冲/透传是另一个大 spec，本 spec 纯观测。→ 记 `docs/todo/deferred-backlog.md`。
- **不回填存量**。见 §5.4。

## 2. 范围决策（用户已拍板）

| # | 决策 | 值 |
|---|---|---|
| 1 | 时序指标基数 | **7 刻冻结**：4 upstream（per-attempt/epoch）+ 3 client（entry 列/offset），见 §3.2 |
| 2 | 端点覆盖 | 全流式端点（Anthropic messages / OpenAI chat / Responses / Gemini / WS） |
| 3 | 存量回填 | **不回填**，老行 NULL（对齐本仓 additive 列一贯范式） |
| 4 | 消费端 | client 3 刻 entry 列 + upstream 4 刻 attempts[] blob + REST + ui-v4 详情面板 + live（entry_updated→REST 重取）+ **遥测 DDSketch 分布度量（fleet 分位）** |

## 3. 指标模型

### 3.1 捕获架构：per-attempt 存储（upstream）+ entry 列（client）

**否决**「finalize 时从帧 offset 反推」（重蹈折叠/原点混淆坑）。**否决**「单一 ctx.timing ledger + onAttemptReset 清空」——实测 `onAttemptReset` 仅在 L2 buffered-retry 触发（`driver.ts:790`），L1 error-driven 重试（beta-strip / truncation / 429，主流腿）走 `runExchange` **从不调它**，会造成 `upstream_headers_ms`（钉 attempt 1）与 `upstream_first_token_ms`（committed attempt）**跨 attempt 原点错配**。

两类时刻**分开存储、分开原点**（R3 修正——消除 attempt-origin 数学矛盾）：

- **上游侧（`upstream_*`，4 个含第 7 刻）= per-attempt，存到 `Attempt` 记录**。Attempt 已有 `startTime`/`durationMs`/`waitMs`，是 per-attempt 计时天然宿主，与既有 D1 不变量「失败 attempt 的 sseEvents/responseHeaders 快照进 attempts[]」一致。存**绝对 epoch instant**（`Date.now()`），**不**在 attempt 侧做 offset——避免 attempt 值相对 entry `started_at` 时、retry 后含前序 attempt + backoff 而超出该 attempt 自身 `durationMs` 的矛盾（R3 GPT HIGH-3）。committed attempt 的上游时刻**不落 entry 列**，供 detail（读 attempts[]）+ telemetry input 投影用（§6.1）。
- **下游侧（`client_*`，3 个）= entry 级**（每请求只发生一次，无 attempt 归属），存**相对 `started_at` 的 offset ms**，天然 ∈ [0, durationMs]、无多-attempt 原点问题。落 entry 列（§5.1）。

**取数纪律**：telemetry / detail 消费「committed attempt 上游时刻」时，从 committed attempt 读绝对 epoch、减 `entry.started_at` 得 offset（换算只在 attempt→消费边界发生一次）。

### 3.2 时刻定义（冻结为 7 刻：4 upstream per-attempt + 3 client entry）

R3 冻结：不再「6 或 7」摇摆——`upstream_message_start_ms` 纳入，共 **7 刻**。upstream 4 刻存 attempt（epoch instant）、client 3 刻存 entry（offset from started_at）。

**上游侧（`Attempt` 记录，绝对 epoch instant，camelCase）**

| 字段 | 语义 | 捕获点 | 写策略 |
|---|---|---|---|
| `upstreamHeadersAt` | 上游 fetch resolve（HTTP 响应头到达） | `runExchange` 内 `transport.send` resolve（`driver.ts:322`） | once |
| `upstreamMessageStartAt` | 上游 `message_start` 帧到达（区分「已受理无内容」vs「慢在建连」） | driver loop-top raw 帧采样（`driver.ts:457-469`） | once |
| `upstreamFirstTokenAt` | 上游首个「承诺产出内容」信号 | 同上采样点，`env.targetEndpoint` 谓词 | once |
| `upstreamLastTokenAt` | 上游末个内容帧 | 同上采样点 | **latest**（每帧更新） |

**下游侧（entry 列，offset ms 相对 `started_at`，snake_case 列 / camelCase 类型）**

| 列 / 字段 | 语义 | 捕获点 | 写策略 |
|---|---|---|---|
| `client_stream_open_ms` / `clientStreamOpenMs` | **应用层不可逆选择 200 SSE response 的时刻**（非客户端 socket 收到 headers——服务端无法观测 client ACK） | 各端点 `streamSSE` callback 入口（4+ 站点） | once |
| `client_first_real_ms` / `clientFirstRealMs` | client-sink 首个非-synthetic **内容**帧被 write 前采样（非 client ACK） | `client-sink.ts` `onForwarded`，`clientFormat` 谓词 | once |
| `buffer_hold_start_ms` / `bufferHoldStartMs` | 首帧被扣留进 buffer 的时刻（透传=NULL） | `runResponseBufferedSink` 首次 `buffer.push` 前（`driver.ts:790-817`，protect 与 L2 共用单点） | once |

**派生量**（不落库、消费端算）：上游生成 span = `upstreamLastTokenAt − upstreamFirstTokenAt`；keepalive 空窗 = `clientFirstRealMs − clientStreamOpenMs`；缓冲扣留 = `clientFirstRealMs − bufferHoldStartMs`；上游承接延迟 = `upstreamMessageStartAt − upstreamHeadersAt`。

### 3.3 命名口径（R3 修正）

- **upstream 4 刻用 `*At`**（绝对 epoch instant，存 attempt）；**client 3 刻用 `*Ms`**（offset 相对 `started_at`，存 entry 列）。避免 `_ms` 暗示「既是 instant 又是 duration」的口径混淆（R3 GPT 建议：instant/offset/duration 分型）。
- `client_stream_open_ms` **不叫 `client_commit_ms`**——它是服务端应用层「决定发 200」的时刻，非可证明的 client-visible commit（R3 GPT MED）。
- client 3 刻列名 snake_case `_ms`（与 `duration_ms` 一致）；类型层嵌套 `timing` camelCase。

### 3.4 承重语义约束

- **跨端点/路径 instant 非全局单调**。Anthropic 延迟提交路径先发 200（`clientStreamOpenMs`）再 await exchange，故 `clientStreamOpenMs`（entry-offset）对应的墙钟可**早于** committed attempt 的 `upstreamHeadersAt`。消费端/校验**不得假设跨 upstream/client 顺序**。合法断言只在同一时间基内：① 同 attempt 内 `upstreamFirstTokenAt ≤ upstreamLastTokenAt`；② client 3 刻 ∈ [0, durationMs]（entry-offset，天然成立）。**不对 upstream attempt 值断言 `∈ [0, durationMs]`**——upstream 存绝对 epoch，且 retry 后 committed attempt 的 epoch 换算成 entry-offset 会含前序 attempt + backoff，可 > 单个 attempt 的 `durationMs`（R3 GPT HIGH-3 修正）。
- **`recordTiming` 分两写策略**：`once`（首写为准，6 个）与 `latest`（`upstreamLastTokenAt`，末写为准）。API 显式区分，不笼统「首写为准」。
- **两套原点显式声明**：client 3 刻 offset 相对 `started_at`；upstream 4 刻绝对 epoch（消费时减 `started_at`）；既有 `sseEvents.offsetMs` 相对 `streamStartMs`。ui-v4 详情面板混排须换算或分轴标注（§6.3）。

### 3.5 首包谓词（格式特定，重定义）

「首个真实内容」= **上游首次承诺产出内容的最早无歧义信号**（不只文本 delta，须含 tool-first / reasoning-first）：

- Anthropic：首个 `content_block_start`（任意块类型，含 tool_use/thinking）
- OpenAI chat：首个 `choices[].delta.content` 非空 **或** `tool_calls`
- Responses：首个 `response.output_item.added` **或** `response.output_text.delta`
- Gemini：首个含 `text` **或** `functionCall` 的 part

**谓词轴纪律**：`upstream*At` 用 `env.targetEndpoint`（上游/翻译后格式）谓词；`clientFirstRealMs` 用 `clientFormat`（下游客户端格式）谓词。翻译腿（如 anthropic→cc）上游帧是 CC 格式，用错谓词会全漏。上游 raw 轨须跳过 keepalive/ping 帧；client 侧 message_start（含 fabricated envelope，带 synthetic 标记）不算内容。

## 4. 捕获点接线（实现约束）

| 捕获点 | 文件:锚点 | 注意 |
|---|---|---|
| `upstreamHeadersAt` | `driver.ts:322`（transport.send resolve） | 每 attempt 写自己的（attempts[]），非跨 attempt 首写 |
| `upstreamMessageStartAt` / `upstreamFirst/LastTokenAt` | `driver.ts:457-469`（runResponse loop-top，raw 帧无条件流经） | **单点采样**，非各 pump——Responses direct 不 wire onUpstreamFrame，放 pump 会漏腿 |
| `clientStreamOpenMs` | 各端点 streamSSE 入口（4+ 站点） | 逐端点接线清单：messages/responses/chat-completions/gemini/ws |
| `clientFirstRealMs` | `client-sink.ts` onForwarded | 给 sink 传 clientFormat 谓词回调，或逐 handler 实现 |
| `bufferHoldStartMs` | `runResponseBufferedSink` 首次 `buffer.push` 前（`driver.ts:790-817`） | **单点**——protect_streaming_generation 与 L2 共用 `runResponseBufferedSink`（R3 澄清，非两个采样点）；entry-level first hold，跨失败 retry |

## 5. 存储

### 5.1 client 3 刻 → entry 列（per-request 明细）

`entries_v2` 加 **3** 个 nullable INTEGER 列（`client_stream_open_ms` / `client_first_real_ms` / `buffer_hold_start_ms`）。**走 `migrateEntriesColumns.wanted`**（`connection.ts:277`，`PRAGMA table_info` 幂等，覆盖 fresh+既有）+ 同步 `SCHEMA_SQL`。**不用 Umzug**（`MIGRATIONS=[]` 留给首个真正 schema change；全部 additive 列历来走 `wanted`）。upstream 4 刻**不加列**（存 attempts[] blob，§5.3）。

### 5.2 两条完整接线清单（列式 client 3 + per-attempt upstream 4）

**（A）client 3 刻列式接线（≥7 处，非「三处」）**。「三处」（toHistoryEntry / onTerminal / updateEntry allowlist）只是 blob 路径。列式必改点：

1. `schema.ts` `SCHEMA_SQL`（fresh DB）
2. `connection.ts` `migrateEntriesColumns.wanted`（既有 DB）
3. `EntryRow` 类型
4. `serialize.ts` `buildHeadRow`（对象→行）
5. `serialize.ts` `META_KEYS`（把 3 列排除出 blob，避免列/blob 双写——对齐 requestBytes 范式）
6. `write.ts` `INSERT_ENTRY_SQL`（列清单 + 占位符 + `ON CONFLICT DO UPDATE`）+ `runHeadInsert` bind 顺序
7. `serialize.ts` `deserializeEntry`（列→嵌套 `timing.client` 对象重组）
8. `EntrySummary` + `toEntrySummary` + 摘要 SELECT（**若 live 推送带 timing 则强制**，见 §6.3）

**（B）upstream 4 刻 per-attempt 接线（R3 Claude 新 HIGH——HIGH-1 承重的另一半，别漏）**。attempt 时序落 `attempts[]` blob（非新列/新 stage），须穿过：

1. **3 份并行 Attempt 类型**：producer `Attempt`（`context/types.ts:118-145`）+ `HistoryEntryData.attempts[]`（`context/types.ts:307-328`）+ owner `HistoryEntry.attempts[]`（`history/types.ts:497-526`）各加 4 个 `upstream*At` 字段。
2. **`toHistoryAttempts` 的显式字段 allowlist**（`history.ts:336-357`）——新 attempt 字段不在其中即被**静默 drop**（与 [[settle-freezes-history-entry-record]]「explicit-projection sink 忘 copy 即丢」同类 bug，发生在 attempt 子对象）。
3. 测试：失败 attempt 的 `upstream*At` 经 `toHistoryAttempts` round-trip 不丢。

### 5.3 类型层

`HistoryEntry` 加嵌套 `timing?: { client: { streamOpenMs?, firstRealMs?, bufferHoldStartMs? } }`（entry 级，camelCase）。upstream 4 刻加到 3 份 `Attempt` 类型（`{ upstreamHeadersAt?, upstreamMessageStartAt?, upstreamFirstTokenAt?, upstreamLastTokenAt? }`，绝对 epoch）。SSOT-types：类型后端定义，ui-v4 经 `~backend/*` re-export。

### 5.4 不回填

老 blob 帧 offset 相对 `streamStartMs`（从不落盘），无法可靠换算到 `started_at` 原点（差值 = queue + commit 窗口 = p50 79s 的大头）；缓冲行 offset 已折叠。回填会混两套原点、等价 oracle 循环自证。故**不回填**，老行 client 3 列 NULL + attempts[] 无 upstream 时刻（对齐 request_bytes/multiplier 等既有 additive 范式）。

## 6. 消费端

### 6.1 遥测 registry 分布度量（fleet 分位）——battle-tested，非手搓 SQL

fleet 级「首包大概花多久」的百分位聚合**走遥测 registry**（`telemetry.db`，2026-07-14 落地的三层 rollup + DDSketch），**不手搓 `/history/api/stats` SQL 聚合**。R3 核实：DDSketch 能力、γ 建库冻结、watermark 同事务幂等**均已 landed 且引用正确**；per-request 列与 sketch **正交不重复**（列=行级明细 SoT、sketch=有损聚合索引）。但接线描述须修正为**准确的 3 点**：

- **注册是 3 点接线，非「一个 `(entry)` extractor」**（R3 两家一致）。已 landed 的分布 registry 是 `request-telemetry.ts:154` 的 `HISTOGRAMS`，`StatHistogram.extract` 签名 `(opts: SettledTelemetryInput, durationMs) => number | undefined`（**接 `opts` 非 `entry`、返回 `undefined`（非 null）表 skip**）。为时序度量注册须：① `SettledTelemetryInput`（`request-telemetry.ts:300`）加 `firstTokenMs?`/`clientFirstRealMs?` 等字段；② `sinks/telemetry.ts` 的 settle 投影从 `entry.timing` / committed attempt 穿线进 `opts`；③ `HISTOGRAMS` 各加一条 `extract: (opts) => opts.firstTokenMs`。`buildSketchObservations`（`request-telemetry.ts:513`）泛型迭代 HISTOGRAMS 自动建 sketch。
- **「零 DDL / 零版本 bump」成立但归因修正**：因为分布度量打进 name-addressed 自描述 `hist_blob`（`sketch-blob.ts`），无新 SQLite 列——**非**笼统「支柱 2（additive counters bag）」，那是另一根柱。**不新增精确 scalar measure**（那才需要 `SettledMeasures` 列 DDL）。
- **`/metrics` 副作用须裁定**（R3 GPT HIGH-2）：`TELEMETRY_HISTOGRAMS`（`request-telemetry.ts:184`）从同一 `HISTOGRAMS` 派生，注册即**同时新增一个进程内 fixed-bucket `/metrics` Prometheus histogram family**。本 spec 裁定：**接受该 family 暴露**（运维价值），并为时序度量**指定 fixed-bucket boundaries 延伸到 ≥360000ms**（TTFT max 实测 356s，别复用 `duration_ms` 的 300000ms 顶、否则尾部全落 +Inf）。若后续需洁化，再把一体 `HISTOGRAMS` 拆 Prometheus-fixed / persistent-DDSketch 两 registry（记 backlog，不阻塞本 spec）。
- **样本总体 = completed + failed，排除 aborted**（R3 两家）。遥测 sink（`sinks/telemetry.ts:40`）只订阅 `request.completed`/`failed`、显式排除 aborted。**故 fleet TTFT 分位不含 client-abort 尾部**。本 spec 动机的两条 15 分钟请求实测终态是 **`failed`（非 aborted）→ 会被纳入**；但一般 client-abort 的最坏尾部依赖 **per-request 列 + `/api/stats` 或 History 直查 `state=aborted`**（§6.2）。此盲区在 §9 显式记录。
- **近期窗口无 sketch 分位**（R3 两家）：`/api/stats` 的 DDSketch `distributions` 只在 SQLite-tiered 窗口（`30d`/`90d`/`lifetime`）返回；`sinceStart`/`7d` 走内存 fixed-bucket、**无 sketch**（`routes/stats/route.ts:98`）。故排查「今天这批」的近期分位走 fixed-bucket 直方图（`/metrics` 或 `/api/stats?window=7d`），sketch 分位服务 30d+ 趋势。
- **承重不变量（遵 telemetry-architecture skill）**：DDSketch 从**原始 ms 观测值**喂（非内存有损桶）；γ 建库冻结、不读 live config；rollup watermark 幂等同事务。度量单位 ms（INTEGER），非成本无需 scaled-int micro。

### 6.2 REST

`/history/api/entries/:id` 已返回整行，client `timing` 经列（deserializeEntry 重组）、upstream 时刻经 attempts[] blob 自动带出。无需新端点（fleet 分位走遥测既有 `/api/stats`）。client-abort 尾部经 `state=aborted` 过滤直查。

### 6.3 live 推送

**走 `history.entry_updated`（SQLite 写后广播 `EntrySummary`）**——**非** `context_updated`（实测 `ws.ts:150` / `terminal-ui.ts:476` no-op 显式忽略、HistorySink-only）。R3 澄清 notification-vs-payload 二选一（本 spec 定 **(a)**）：

- **(a) 详情面板收到 `entry_updated` 通知后经 REST `/entries/:id` 重取全行**（§6.2）——`EntrySummary` **无需**带 timing，§5.2(A) item 8 保持条件项。**本 spec 采用 (a)**（timing 是 detail 关切、非列表列）。
- (b) 若要 WS 直推 timing 免二次取，则 timing 进 `EntrySummary` payload，§5.2(A) item 8 **升为强制**。
- live 进行中面板（请求未 settle 就显示 TTFT/commit 空窗）：留 §9 待定；若要则加 `active_request_changed`（`active-request-wire.ts`）时序字段。

### 6.4 ui-v4

详情面板加「时序/首包」小节（经 `~backend/*` re-export `timing` 类型）：上游 TTFT / keepalive 空窗 / 客户端首包 / 缓冲扣留 / 缓冲标记。与 `sseEvents.offsetMs`（相对 streamStartMs）混排须换算原点或分轴。TUI live 面板可选。

## 7. 测试

- **格式检测器单测**（每端点）：tool-first / reasoning-first / thinking-only / 空 delta / role 帧 / keepalive-ping 边界正确分类；正样本证「首个真实信号」命中；targetEndpoint vs clientFormat 谓词不串。
- **per-attempt 归属 + round-trip**：L1 error-driven 重试（beta-strip）后，attempt 1 与 committed attempt 各自的 `upstream*At` 独立正确；失败 attempt 的 `upstream*At` 经 **`toHistoryAttempts` allowlist round-trip 不丢**（R3 新 HIGH 的证伪测试）。
- **attempt 原点反例**（R3 GPT）：attempt 1 + backoff + attempt 2，证 committed attempt 的 `upstreamHeadersAt` 换算 entry-offset 后**可 > 单 attempt durationMs**、断言不误用 `[0,durationMs]`。
- **缓冲 vs 透传两臂**：`bufferHoldStartMs` 有/无 + `clientFirstRealMs − bufferHoldStartMs` = 扣留时长；透传 NULL。含 L2 failed-buffer retry（attempt 1 入队后丢弃、attempt 2 committed）+ block-level 多段 buffer（首次 flush 后再入队，证 entry-level `once` 不被错误重写）。
- **迁移幂等**：`migrateEntriesColumns` 重复 open 不重复 ALTER；fresh DB 有 client 3 列。
- **遥测度量**：DDSketch 从原始 ms 喂、分位对独立 oracle（从原始数组算 exact quantile 验相对误差界，非同 sketch 路径互比）；**API-level `GET /api/stats?dimension=model&window=30d` 证时序 distribution 出现在承诺窗口**；γ 热重载反例（建库后改 config，新观测仍用库冻结 γ）。
- **aborted 样本总体**：有 TTFT 后 abort / TTFT 前 abort，各自是否进 distribution（证排除 aborted 的边界）。
- **列式接线完整性**：write→read round-trip client 3 列不丢；META_KEYS 排除后 blob 不双写。
- **非单调性**：断言不假设跨 upstream/client 顺序（Anthropic 延迟提交 `clientStreamOpenMs` 墙钟早于 `upstreamHeadersAt` 合法）。

## 8. 决策记录（拟入 ADR / DESIGN）

- **D1** upstream 4 刻 per-attempt（attempts[] blob，绝对 epoch）+ client 3 刻 entry 列（offset）；否决单 ledger+reset（onAttemptReset 只覆盖 L2）+ 否决 upstream 列（消 attempt-origin 矛盾、fleet 分位已由 sketch 服务）。
- **D2** fleet 分位走遥测 DDSketch registry（3 点接线：SettledTelemetryInput + sink 投影 + HISTOGRAMS），非手搓 SQL（battle-tested-over-hand-rolled）；接受 `/metrics` fixed-bucket family 同步暴露。
- **D3** 不回填，老行 NULL。
- **D4** additive client 列走 migrateEntriesColumns.wanted，非 Umzug。
- **D5** 谓词轴：upstream 用 targetEndpoint、client 用 clientFormat。
- **D6** `client_stream_open_ms` 命名 = 应用层决定发 200 的时刻，非 client-visible ACK。

## 9. 风险 / 待确认（留 user review）

- **fleet TTFT 分位排除 aborted**（sink 硬约束）——client-abort 最坏尾部只在 per-request 层（`state=aborted` 直查），fleet 分位偏乐观。是否需为 timing 单开一个纳入 aborted 的 distribution sink（与 verdict counter 分离）留待定；本稿默认接受盲区 + 文档化。
- **近期窗口（sinceStart/7d）无 sketch 分位**——是否扩展 `/api/stats` 让 `7d` 也从 `tel_raw` 读 DDSketch 留待定；本稿默认近期走 fixed-bucket。
- **live 进行中面板**（请求未 settle 显示 TTFT）是否需要（§6.3）留待定。
- **`/metrics` 拆 registry**（Prometheus-fixed / persistent-DDSketch 分离）记 backlog，不阻塞本 spec。
