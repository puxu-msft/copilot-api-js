# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## B2 ready-state recovery 的 buffered 路径旁路（2026-07-28）

- **根因 / 现状**：B2 在 buffered 路径的挂载点是 `runResponseBufferedSink` 的 `degradeOutcome = committedAny ? committedDegrade : "exhausted"` 分支；`committedAny === false` 表示“ready 但无真实内容交付”。direct Anthropic live B2 已在 pre-ready、ready transport close 与 ready clean EOF 三个入口接线，但 buffered loop 没有接入 owner batch publication。实现基线为 `dd79edb3`；交付状态以本文件所在 commit 与 [tracked implementation report](../plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md) 为准。
- **当前行为**：buffered 路径耗尽透明重试预算后直接以 `"exhausted"` 降级，不发起 B2 fresh dispatch。
- **理想架构 / 若做需改什么**：在 `!committedAny` 分支耗尽预算、即将走向 `degradeOutcome = "exhausted"` 前，组合 semantic-content gate 与 server-tool gate，并外挂恰好一次 recovery。fresh attempt 必须重入 buffered 循环，不可挪用 direct-live evaluator/owner batch；失败 attempt 的原始帧、duration、dispatch/candidate settlement 须在切换前提交并重置。
- **已裁决语义**：用户已拍板尊重 `max_retries=0`；buffered B2 旁路必须额外检查 `resolveBufferedCaps(vendor).maxRetries > 0` 才能生效。用户明确表达“不要任何重试”时，连 B2 这一次也不得发起。
- **为何暂缓**：direct-live 的 C9 publication 已提供可对照的生命周期合同，但 buffered re-entry、retry budget 与历史逐 attempt 簿记仍是独立结构设计，不能用 live 成功路径假装等价。
- **触发条件**：为 buffered Anthropic 路径请求 B2 行为，或需要在 `max_retries>0` 耗尽后给尚未交付语义内容的 stream 再尝试一次。**发现方**：Task 4.0 review（reviewer，2026-07-28）；2026-08-08 更新为 live 已完成后的真实 deferred 边界。

> **⚠️ 全局更正（2026-08-02）**：下方若干条目的「为何暂缓」把「**buffered 默认 OFF，缺省无差异**」当作论据。该前提**已不成立**——`responsesBufferedRetry` 与 `chatCompletionsBufferedRetry` 已于 **2026-07-14 翻转为默认 `true`**（仅 Anthropic 的 `protectStreamingGeneration` 仍默认 `false`；权威 = `packages/foundation/src/state-defaults.ts`）。这些条目的**判断日期与理由原文保留不改写**（它们在写下时是对的），但**重新评估任何一条时必须先用当前默认值重算 blast radius**——「默认 OFF 所以缺省无差异」这句话今天对 Responses/CC 是错的。
>
> **⚠️ 后续目标裁决（2026-08-06，已确认、未实施）**：真实内容的 block-level delivery 已被确立为不可配置的项目公理，见 [block-level buffered retry ADR 的后续裁决](../decisions/2026-07-11-block-level-buffered-retry.md) 与 [mandatory delivery 规格](../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)。下文保留的 live／retreat／默认 OFF 叙述仍是当前或历史代码事实，但不得再作为未来方案；实施完成前的活代码状态仍以 [DESIGN.md](../DESIGN.md) 为准。

## translated Anthropic B2 recovery publication（2026-08-08）

- **根因 / 现状**：direct Anthropic B2 依赖 Anthropic frame evaluator、three-mode anchor reconciliation 和 `publishRecoveryBatch` 的 owner wire contract；翻译腿的 R 虽可经 evaluator/disposition 识别和 discard，但没有等价的 translated client-wire publication path。实现基线为 `dd79edb3`；交付状态以本文件所在 commit 与 [tracked implementation report](../plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md) 为准。
- **当前行为**：当 `/v1/messages` 请求实际路由到非 Anthropic target 时，R 不会作为 direct Anthropic recovery 写入；无法被安全完成/处置时保持 fail-closed，绝不把不完整或错误格式的 R 拼进 client stream。
- **理想架构 / 若做需改什么**：按 client format × target endpoint 建立 cell-aware recovery publication contract，复用 generation lifecycle/disposition，但由对应 renderer 生成目标 client wire；明确每种格式的 complete predicate、synthetic terminal、History terminal attribution 与 anchor/keepalive 规则。必须补真实客户端或独立 parser oracle，不能复用 Anthropic wire 断言冒充覆盖。
- **为何暂缓**：这是跨协议 public wire/terminal 契约扩展，不是把 direct helper 接到 translate branch 的局部改动；目前 direct Anthropic 的 B2 已能正确服务目标事故路径，错误地复用其 frame/anchor 规则会制造协议损坏。
- **触发条件**：需要 Anthropic 客户端通过 `@responses`/`@cc` 等翻译 target 获得同等 B2 能力，或为其他客户端格式实现 post-commit pre-content recovery。改动面至少包括 `cell-assembly`、相关 codec renderer、`driver`、各 handler terminal/History projection 与对应 client e2e。

## reverse `@messages` 非流式跨协议 refusal 抑制（2026-07-28，合并态复审后拆出）

## reverse `@messages` **非流式**三格没跑 whole-response 改写链（2026-07-28 实测重定范围）

- **实测订正（原条目范围是错的）**：这条 backlog 原本写成「六格 wire 抑制都没做」。2026-07-28 实测推翻——**流式三格已经在抑制**，客户端拿到的是正常轮（CC `finish_reason:"stop"` + end_turn 正文 + `[DONE]`；Gemini `finishReason:"STOP"` + 文本 part；Responses `response.completed`）。原因是 per-frame 改写链的门是 `targetEndpoint === /v1/messages`，reverse 腿正好命中，Anthropic 帧在 reverse 翻译器看到之前就被改写了。oracle 与逐格字节见 `tests/routes/reverse-refusal-default-wire.it.test.ts`。
- **根因（比原描述小得多，也宽得多）**：不是「三套协议呈现逻辑没写」，而是**少调了一次**。whole-response 改写链在 `driver.runResponseWhole`（`src/lib/pipeline/driver.ts:1562`），它是 `transformWhole` 的**唯一**驱动点，而它在生产代码里**只有一个调用点**——直连 Anthropic handler（`src/routes/messages/handler-v4.ts:894`）。三条 reverse 非流式路径只调 `driver.runResponseNonStreaming`（`codec.renderResponseNonStreaming`，纯 render）。
- **因此波及面不止 refusal**：`recover-tool-call` / `tool-input-decode` / `server-tool-filter` / `recover-refusal` 四个 `transformWhole` 钩子在 reverse 非流式腿上**全部落空**（`appliesTo` 都命中，只是链没被驱动）。refusal 只是被观测到的那一个；另外三个尚无 oracle，**做这条时应一并建**。
- **当前行为**：六格裁决口径已统一（`ctx.fail(refusalSummary(...), ..., {upstreamSucceeded:true})` + `refusal-passthrough`，上游腿 `success:true`）。wire 上非流式三格仍是 CC `finish_reason:"content_filter"`+`content:null` / Responses `status:"incomplete"`+`incomplete_details.reason:"refusal"` / Gemini `finishReason:"SAFETY"`+空 parts。
- **若做需改什么**：① reverse 非流式路径在翻译成目标协议**之前**，先对 Anthropic body 跑 `driver.runResponseWhole`（流式腿等价于已经这么做了，所以这是**对齐**而非新机制）；② 确认 `renderReverseNonStreamingV4` 的 settle 判据仍读**链前** upstream-original（`isRefusal` 读 `response` 而非 `finalResponse` 是抑制后 settlement 正确的原因，别改反）；③ feature 从写死的 `refusal-passthrough` 改成实际 mode；④ 把 `tests/routes/reverse-refusal-default-wire.it.test.ts` 的三条非流式期望翻成与流式一致（它们就是本任务的落地信号），并补另三个 whole 钩子的 oracle；⑤ 补至少一条同 session 后续轮可继续的真实客户端测试。
- **为何暂缓**：改动会改变三种公开协议的客户端 wire，需要逐协议裁定合成文本位置、完成原因、error 模式、usage 与 response id 的保持方式。不阻塞任何已交付行为。

## 两条顺序不变量只有注释守着（2026-07-28，来自顺序不变量审计 #3 / #5）

来源：`docs/plan/2026-07-27-keepalive-and-separator/research-order-invariant-audit.md` 的发现 3 与发现 5。**这两条不是「已经错了」，是「今天对、但没有东西拦住明天改错」**——同一份审计里的 #1/#2（已发生的漂移）与 #4/#6（CRITICAL/假守卫）优先级更高，故这两条降为 backlog；**记在这里是为了不被静默丢掉**。

- **#3（HIGH）delayed-commit SSE 的 abort listener 必须先于首个 ping。** 不变量原文在 `src/routes/messages/handler-v4.ts` 的 `stream.onAbort(...) // register BEFORE the first ping`。谁能破坏：把 `onAbort` 移到 `await sink.writeKeepalive(...)` 之后，或在两者间插入任何可 await 的写/初始化。后果：commit 瞬间断开会漏掉 disconnect，上游请求在无人消费后继续持有连接/accumulator/buffer——**表现是资源滞留而非即时报错**。建议守卫：抽成 `attachAbortThenEmitInitialKeepalive` 原子 helper，用可控 stream 在第一次 write 同步触发 abort，断言 `clientAbort.signal.aborted === true`。
- **#5（MED）`createFullTestApp` 宣称镜像生产 server，但装配面没有 parity 守卫。** 生产 `src/server.ts` 与 `tests/helpers/test-app.ts` 是两份手写装配；后者仍缺 config/token middleware、unknownEndpointFinalizer、CORS、trimTrailingSlash。谁能破坏：在生产加/重排全局 middleware 而不手改 test app，大量 `.http.test.ts` 继续给假绿。**本轮已部分缓解**（给 `createFullTestApp` 加了生产同位的 `preMiddleware` 槽），但没有 parity 守卫。建议：抽共享 `configureBaseApp(app, deps)` 让两边只注入依赖差异；暂不抽则加结构守卫对两者的基础 route + middleware 注册序列做声明式对账 + 显式 allowlist。

## History 详情页 SSE 帧的绝对时间：upstream 轨的原点未证（2026-07-28）

- **根因**：`clientResponse.sseEvents[].offsetMs` 是 **commit 相对**的（`client-sink.ts:216` 用 `Date.now() - streamStartMs`），而 UI 的 `FrameList` 两条轨原本都传 `entry.startedAt` 当原点（`ui-v4/src/components/detail/segments/SseEventsSegment.tsx`）。
- **已修（2026-07-28）**：forwarded 轨改用 `entry.startedAt + (entry.timing?.client?.streamOpenMs ?? 0)`。这条有证据——生产者在 commit 时刻写 `setClientTimingEpoch("streamOpen", commitInstant)`，与 sink 的 `streamStartMs` 同源。延迟-commit 窗口默认从 20s 抬到 180s 后，这个误差被放大到约 3 分钟，所以先修它。
- **原点已追到（2026-07-28 订正，此前写「没追出来」）**：upstream 轨的 offset 锚在**每个 attempt 自己的 collector epoch** 上——`src/lib/upstream-stream-diagnostics.ts` 明写「the SAME base every `sseEvents[i].offsetMs` is relative to」，且 **buffered retry 会重新绑定一个新 collector**。它既不是 `entry.startedAt` 也不是 commit。**关键：这个 epoch 没有被持久化进 history 类型**，所以 UI 拿不到它——因此该轨现在显示的绝对钟点确实是错的，且**无法靠现有持久化数据修正**。
- **若做需改什么**（原点已知后，路线变成二选一）：**要么**把 collector 的 anchor epoch **持久化**进 history（per-attempt 一个，注意 buffered retry 会重绑），UI 再按轨渲染绝对时间；**要么**承认拿不到、该轨**只显示 elapsed 或显式「绝对时间不可用」**，`offsetSource === "unavailable"` 已有先例可复用。**别再继续伪造绝对钟点。** 无论走哪条，补一条 UI 回归测试：构造 `streamOpenMs=180000, offsetMs=20000`，断言两轨各自渲染的钟点不同且各自正确。
- **为何暂缓**：产生侧未定位，属独立调查单元；且 upstream 轨的误差不随本次默认值改动放大，不阻塞交付。
## delayed-commit 窗口是全局的，但它的安全上限只对两个 Node 客户端实测过（2026-07-28）

- **根因**：`stream_commit_after_sec` 对所有流式 `/v1/messages` 请求一视同仁（`handler-v4.ts` 只按 `clientRaw.stream` 分支，不识别客户端）。但窗口的安全上限来自**客户端的** pre-header 容忍度，而我们只实测过两个样本：真 Claude Code 2.1.220（其内置 Node v26.3.0）与 `@anthropic-ai/sdk` 0.106.0 on Node——两者都是 ~300s，因为都落在 undici 默认 `headersTimeout` 上（`exp/silence-recovery-gates/FINDINGS.md`）。
- **当前行为**：默认 180s。窗口内我方**一个字节都不发**，所以任何 pre-header 容忍度落在 `(20s, 180s)` 的 Anthropic 客户端，**旧默认下能在 20s 拿到 200+keepalive 而活、新默认下会在收到任何字节前超时**。Python / Go / Java / Ruby 官方 SDK、第三方工具、中间反向代理、以及用户自设的短 timeout 都未测。
- **理想架构**：commit policy 应当**客户端感知**而非全局一刀切——对可识别的客户端（`x-app: cli` + `user-agent: claude-cli/*`，或已知 Node SDK 的 `x-stainless-runtime`）用实测背书的窗口，对未知客户端用保守窗口（或单独的 `unknown_client_commit_after_sec`）。判据轴是「不为了兼容而放弃正确默认，但也不用两个样本替所有客户端做决定」。
- **为何暂缓**：本项目实际只服务 Claude Code（用户 2026-07-28 明确按 CC 定 180s）。客户端分类是一个新契约，需要先定「怎样算可识别」并对官方多语言 SDK 补探针，属独立工作单元。
- **若做需改什么**：① 补官方 SDK 多语言 pre-header 探针（复用 `exp/silence-recovery-gates/run-q1-firstfail.sh`，它已是多臂结构）；② 定客户端识别契约（架构决策，需 ADR）；③ `handler-v4.ts` 的窗口取值改为按分类查表；④ config 增加未知客户端键并同步 schema/TSDoc/DESIGN。

## Anthropic 块级 buffered 首块后的 >300s keepalive carrier（2026-07-27，块级默认翻转硬门）

> 2026-07-27 P6 已先修相邻的 heartbeat 生命周期缺陷：普通 boundary commit 的 `freezeHeartbeat()` 不再永久关闭 delivery timer，Responses HTTP / Anthropic 的首个 boundary 之后会继续发 ping。**本条仍活**，因为它解决的是不同问题——ping 不重置 Claude Code 300s content watchdog，仍需方案 A 的合法 gap anchor carrier。

- **根因**：块级 buffered 在 `content_block_stop` 前不向客户端写 start/delta；首块提交后的长生成在客户端轨没有 open block。ping 不重置 Claude Code 300s event-idle；固定 anchor@0 又不能在真实 block@0 已完成后复用，否则真实 SDK 会静默重排 content。
- **当前行为**：commit `faaa37e7` 的按需升级已收窄为 **pre-content-only**：客户端尚未完成任何真实块时，200s 可开单 anchor@0；首块完成后的无-open窗口只ping。历史 live腿若客户端真有open block，原-index空delta分支仍可达，但**块级 buffered终态不可达**。
- **理想架构**：采用 [inter-block carrier 方案 A](../spec/2026-07-27-inter-block-keepalive-carrier.md)：generation-scoped `createAnchorIndexAllocator` 统一 synthetic anchor、真实块和continuation的单调wire frontier；任一时刻至多一个block open。
- **为何暂缓**：当前分支先消除已知重复index协议损坏，让吞帧修复和pre-content保活可合并。方案A需原子接线delivery serializer、driver buffered flush、retreat、live-reconcile和continuation frontier；局部补丁会把错误从显式断流变成静默内容重排。
- **若做需改什么**：复用姊妹plan Task 1.1–1.3；增加`anchorsOpened===0`结构性短路；作废Q5的`anchorShift + continuationOffset`公式；补heartbeat-vs-flush并发、续写上游index重启、多轮真CC历史回传、producer全序/SDK累积/短请求SHA三层oracle。
- **解除条件（硬门）**：**Anthropic `protect_streaming_generation` 块级默认翻转之前必须完成方案A**。翻默认计划与本条必须互相引用；pre-content-only不能被描述成G2全面闭合。

## history-search sidecar：其余 4 个 source facet 未接入（2026-07-21，history-search-out-of-process plan Phase 4 收窄）

- **根因 / 现状**：REST `SearchSource` 有 5 facet（`inbound`/`rewrites-req`/`rewrites-resp`/`req-headers`/`resp-headers`，[types.ts:729](../../src/lib/history/types.ts#L729)），但独立 sidecar 的 Tantivy 投影（`projectSearchableText`，[v3/projection.ts](../../src/lib/history/v3/projection.ts)）**只索引客户端可见的对话 + 响应**（对应 `inbound`）——native schema（[lib.rs](../../native/history-search/src/lib.rs)）本身只有 `operation_id`/`operation_kind`/`content`/`created_at` 四个字段，没有 facet 维度，`rewrites-*`/`*-headers` 在退役前的嵌入式引擎里是**扁平的逐请求 SQL 列**（`req_aux` 表），从未进入 sidecar 的 schema。
- **当前行为**：`GET /history/api/search?source=<非 inbound>` 一律返回 `{rows:[], nextCursor:null, partial:true}`——`partial` 在这里表示「该维度尚不支持」，不是「无匹配」也不是「sidecar 不可达」。
- **理想架构 / 若做需改什么**：① 扩 Rust `schema()`（[lib.rs:103](../../native/history-search/src/lib.rs#L103)）新增至少一个额外 `TEXT` 字段承载扁平文本、或按 facet 建独立 Tantivy field 并在 `search_blocking` 加 facet 过滤子句；② sidecar 的 tail 投影（`daemon.ts`）需读取对应轨（`v3_tracks` 的 `effective-request`/`upstream-request`/`upstream-response` 等，见 [v3/store.ts:397](../../src/lib/history/v3/store.ts#L397) `collectTracks`）而非只读 `ingress`/`egress`；③ 客户端 wire `HistorySearchWireRequest`（[protocol.ts](../../src/lib/history/search/protocol.ts)）需带 `source`/facet 参数；④ 需要 bump Tantivy index 的 `FORMAT_MARKER`（[lib.rs:20](../../native/history-search/src/lib.rs#L20)）触发全量重建（schema 变更）。
- **为何暂缓**：用户在 plan 制定阶段已明确签核「按既定‘只查对话和响应’收窄」（plan 文档「待用户签核的点」第 5 条），Phase 4 落地时只服务 `inbound`。**触发条件（值得做）**：出现「需要按 rewrites/headers 精确全文检索」的真实运维需求。发现方：history-search-out-of-process plan Phase 4 REST cutover（2026-07-21）。

## history-search sidecar：/history/api/search 无分页（`nextCursor` 恒 `null`，2026-07-21，同上 plan Phase 4）

- **根因 / 现状**：退役前的嵌入式搜索引擎用 `(started_at DESC, ownerKey ASC)` keyset 做稳定分页；独立 sidecar 的搜索是 Tantivy 的单次 `TopDocs::with_limit(limit).order_by_score()`（[lib.rs:231](../../native/history-search/src/lib.rs#L231)）——按 BM25 相关性打分排序，**没有可稳定翻页的游标**（分数不是单调递增的持久化键，两次调用间索引内容还可能变化）。
- **当前行为**：`/history/api/search` 的响应恒 `nextCursor: null`——单页 top-N，`?limit=` 之外无法翻到「下一页」，只能调大 `limit` 重新查一次。
- **理想架构 / 若做需改什么**：Tantivy 支持 `search_after`（游标式深分页，基于上一页最后一条的 `(score, doc_address)` 元组续查）——需要：① Rust 侧 `search_blocking` 增加一个可选的 `after` 参数并改用 `TopDocs::with_limit(limit).and_offset(...)` 或 `search_after` API；② wire 协议新增 cursor 字段的编解码；③ handler 侧把 `SearchResult.nextCursor` 编码这个 `(score, doc_address)` 元组（而非旧的 `(started_at, id)` 语义，两者不兼容，不能直接复用旧 cursor 编解码）。
- **为何暂缓**：Phase 4 的验收标准只要求「单页 top-N 结果正确」，分页不是 gating 需求；相关性排序场景下，用户通常只关心排名前几的结果，深分页价值有限。**触发条件（值得做）**：出现「需要翻到搜索结果第 2/3 页」的真实使用场景。发现方：history-search-out-of-process plan Phase 4 REST cutover（2026-07-21）。

## history-search sidecar：`searchContains`（hash→操作 id 反查）恒返回空（2026-07-21，同上 plan Phase 4）

- **根因 / 现状**：`GET /history/api/search/contains?hash=` 是退役前嵌入式搜索的「懒加载 companion」——对 `v3_tracks.refs_json` 做 `LIKE '%hash%'` 反向扫描（提交 `8a67333b` 引入的 `containingV3OperationIds`，已随 sidecar 拆分退役），sidecar 的 Tantivy schema 完全没有携带这个反查所需的引用图数据。
- **当前行为**：`searchContains()` 恒返回 `[]`，`/history/api/search/contains` 端点 200 但永远空数组。
- **理想架构 / 若做需改什么**：若要恢复，需要 sidecar 侧单独维护一张 hash→operation_id 的反查索引（例如 SQLite 辅助表，随 tail 同步写入），或让主进程直接查 `v3_tracks` 表（该表在主进程侧仍可读，不需要经 sidecar——这条本质上不属于「全文搜索」范畴，更接近一个直接的 SQL 反查，可能不需要出 sidecar 就能做）。
- **为何暂缓**：非 Phase 4 验收范围（plan 只要求 `handleSearch`/`handleSearchContains` 保持契约、`contains` 本就标注为 "compatibility surface"）；实现方式待定（sidecar vs 主进程直接查询）需要先决定架构方向。**触发条件（值得做）**：出现「需要反查某条消息内容被哪些请求引用」的真实使用场景。发现方：history-search-out-of-process plan Phase 4 REST cutover（2026-07-21）。
## Responses 输出侧 function_call `id` 用非-`fc` 工具 id（2026-07-21，随请求侧 400 修复一并定位）

- **反向桥输出侧 function_call `id` = tool id（非 `fc_`），echo 回来的 400 已被 wire backstop 兜住，仅剩 cosmetic**：**现状**：请求输入侧的 400（`Invalid 'input[N].id' … Expected an ID that begins with 'fc'`）已根因修复——`anthropic-to-responses-request.ts` / `cc-to-responses.ts` 合成 `function_call` **输入**项时不再伪造 item `id`（仅留 `call_id`）；**并新增无条件 wire backstop** `stripNonFcFunctionCallItemIds`（`responses-conversion.ts`，在 `prepareResponsesRequest` 这个所有 Responses wire 的唯一咽喉调用），把任何非-`fc_` 的 `function_call`/`function_call_output` 输入项 `id` 一律剥掉（覆盖 `toolu_` 等 `normalizeCallIds` 的 `call_`-only gated 改写漏掉的前缀，永不碰 `call_id`）。**输出侧**（`anthropic-to-responses.ts:159` 非流 + `anthropic-to-responses-stream.ts:262/449` 流）仍把 Responses `function_call` **输出**项的 `id` 与 `call_id` 都设为同一个 Anthropic tool_use id（反向桥里常是 `toolu_…`，真 OpenAI 输出应是 `id: fc_…` ≠ `call_id: call_…` 两个不同值）。**风险已降级**：客户端把 `id: toolu_…` echo 回下一轮请求的 `input` 时，该请求经 wire backstop 会把非-`fc` `id` 剥掉 → **不再 400**。故本条从「echo 回来 400」降为**纯 cosmetic**：客户端在流里看到的输出项 `id` 是 `toolu_…` 而非真 OpenAI 风格的 `fc_…`（两者理应是不同值），对宽容客户端（@ai-sdk/Codex）无功能影响。**暂缓原因**：① 已无功能性 400 风险（backstop 兜底）；② 要做「输出侧发地道 `fc_` id」须合成确定性 `fc_` id 且**流式 added/done/终态三处用同一个**，跨「流 + 非流」协同 + `stream-id-sync.ts` added↔done 一致性契约，纯为观感、ROI 低。**若做需改什么**：给输出侧三处（+ 任何其他输出侧 function_call 合成点）引入统一 `fc_`-id 合成原语（`call_id` 保持工具 id 原值）；`stream-id-sync.ts` 一致性契约与 golden http/stream 断言随之更新。
## reactive retry 策略声明式 registry 跟进项（2026-07-21 registry 落地后，Task 6 triage）

registry（`docs/rfc/2026-07-21-retry-strategy-registry.md`）6 commit 全 landed。以下三项在 Task 6 收尾时评估后判定「重、非当场做」，记录待将来决策（`SHARED_RETRY_STRATEGY_CONFIG_KEYS` parity 测试因低成本、无取舍已当场补做，详见 `tests/config/retry-strategies.it.test.ts`，不再列入本 backlog）：

- **13 处 `as unknown as PayloadRetryStrategy<unknown>` cast → 按 entry 分组的可辨识 deps 类型（RFC §3.1 备选）**。**现状**：`retry-registry.ts` 的 16 个 `RETRY_STRATEGY_REGISTRY` entry 里，13 个 anthropic-only（400-class）entry 的 `create()` 返回值都要 `as unknown as PayloadRetryStrategy<unknown>` 双重 cast（因各工厂函数是 `createXxxStrategy<TPayload>()` 泛型、payload 类型各不相同——`MessagesPayload` 等，registry 层用统一的 `unknown` 擦除类型差异）。**理想架构**：RFC §3.1 备选方案是给每个 entry 按其 payload 类型分组声明一个可辨识联合（discriminated union）类型，让 TypeScript 在编译期核验每个 entry 的 `create()` 返回值与其声明的 payload 类型一致，消除 cast。**为何暂缓**：当前 13 处 cast 都指向同一擦除模式（`PayloadRetryStrategy<unknown>`），风险集中且一致，不是 13 个独立的"类型洞"；引入可辨识联合会显著提高 registry 声明的语法复杂度（每个 entry 需要一个额外的类型参数或 tag），过度设计阈值未到——RFC 本身也把这列为"备选"而非"必须"。**若做需改什么**：给 `RetryStrategyEntry` 加泛型参数 `<TPayload>`、`RETRY_STRATEGY_REGISTRY` 从单一数组改为按 payload 类型分组的多个数组（或用 mapped type 令 `create()` 的返回类型与 entry 声明的 payload 类型绑定），需要重新设计 `assembleRetryStrategies` 的 filter/sort/map 管线以保持跨类型的统一迭代。

- **attemptRef 共享回归测试（`tests/request/retry-registry.unit.test.ts`）依赖日志文案 `"Attempt N/M"` 断言，脆性**。**现状**：Task 4 补的两条 attemptRef 共享回归测试（"one assembleRetryStrategies() call shares ONE attemptRef" / "two SEPARATE calls each get their OWN fresh attemptRef"）通过 spy `consola.info` 解析各策略实际打印的日志行提取 `Attempt N/M` 数字来验证共享语义，而非直接断言 `attemptRef.value` 的数值。**为何这样做**：`attemptRef` 是 `payload-strategy-adapter.ts` 内部闭包状态，assembler/registry 层不直接暴露给测试；用日志断言是当时"行为级验证优于结构断言"的选择（间接但真实观测到了共享效果）。**暂缓原因**：日志文案是实现细节，未来若日志格式变化（如去掉"Attempt N/M"这个措辞、或改变日志级别）这两条测试会假红，需要人工判断是真回归还是措辞变化——这是脆性但非当场阻塞项。**若做需改什么**：给 `adaptPayloadStrategy` 或 `RetryContext` 加一个测试专用的可选 hook（如 `onAttemptObserved?: (n: number) => void`）让测试直接订阅 attempt 计数变化，绕开日志文案依赖；或者更简单地，直接给 `AttemptRef` 类型加一个测试断言点——在两条测试里直接构造 `attemptRef` 对象并传入 `assembleRetryStrategies`（`RetryStrategyDeps.attemptRef` 本就是调用方提供的，不需要新增 API），断言 `handle()` 调用后 `attemptRef.value` 的实际数值而非解析日志。后者改动量很小（改测试内部实现，不改生产代码），但需要确认 `attemptRef.value` 的递增时机（`adaptPayloadStrategy` 内部）与当前日志断言验证的语义完全等价，避免掉入"改测试反而降低覆盖率"的坑。

- **retry-fire counter（`copilot_api_retry_strategy_fires_total`）无维度切面（如 model/endpoint）**。**现状**：`src/lib/observability/retry-strategy-fires.ts` 的 `recordRetryStrategyFire(strategy.name)` 只按 `strategy` 单一维度累加，不区分是哪个 model / endpoint 触发的这次重试。**为何暂缓**（Task 5 reviewer 建议、Task 6 复核维持暂缓）：这是一个独立的、扁平的 process-lifetime 计数器（镜像 `tool-input-repair-stats.ts` 等既有模式），刻意不寄生进 `request-telemetry.ts` 的 `(dimension,key)` 框架（详见 `docs/rfc/2026-07-21-retry-strategy-registry.md` §3.5 的偏离说明——retry-fire 是"每次 attempt 失败重试决策提交"事件，套用 settled-request 的按维度去重累加模型会低估重复触发）。加维度切面意味着要么改变这个计数器的存储形状（引入维度基数管理，如 `request-telemetry.ts` 那套 cap/dictionary 机制），要么完全重新设计成寄生进 telemetry registry——两者都是不小的架构决策，且当前"哪个策略触发了多少次"这个粗粒度视图已经满足了 registry 治理面的诊断需求（RFC §3.5 原意）。**若做需改什么**：先明确需求场景（是要"哪个 model 更容易触发 unsupported-beta"这类交叉分析，还是只是想要更细粒度的时间序列？），若前者，评估寄生进 `request-telemetry.ts` 现有的 model 维度框架（复用其 cardinality cap + dictionary），而非在 `retry-strategy-fires.ts` 自建一套维度管理；若后者，简单加时间戳序列即可、无需维度切面。

## Pre-existing e2e 缺陷（History V2 removal 合并 review 2026-07-19 surfaced，非本合并引入）

在纯 `a387a6da`/`952c831f`（合并前 master）复现相同失败 → 确证 pre-existing、非 History V2 removal 引入。二者均 `.e2e.test.ts`、**不进 `test:backend` 默认门**（`bun test .unit.test .it.test .http.test` 显式排除 `.e2e.test.ts`），故全量 `bun test` 才暴露。

- **`tests/e2e/handover.e2e.test.ts:259`（handover run 1-5/5 全挂）**：`expect(historyRes.status).toBe(200)` 实收 **400**。**现状**：graceful-restart bare-metal takeover e2e 调 history API 得 400。**疑因**：config 默认值 / history endpoint 在 takeover 场景下的 400（待复现根因——是 history handler 拒绝、还是 config gate）。**若做**：起真实 takeover 场景抓 400 响应体定位是哪个 history 路由 + 为何 400。
- **`tests/e2e-client/anthropic-coexist-cli.e2e.test.ts:70`**：hook 模块缺具名导出（`anchor-coexist wire ... assembles as ONE complete turn` 失败）。**现状**：CLI e2e 的 hook-mock 模块导出契约不匹配。**若做**：核对 hook 模块的具名导出 vs 加载方期望（参考记忆 [[reference-cli-e2e-spawn-and-hook-load-gotchas]] 的 data-URL 丢具名导出坑）。

## 首包/时序埋点的观测→治理跟进项（2026-07-14 落地首包埋点后）

首包埋点（ADR `docs/decisions/2026-07-14-request-timing-instrumentation.md`）只**观测**、不治理。以下四项经 spec §9 明确推迟:

- **缓冲扣留 UX（承重,真问题）**:实证**所有 >=60s 长请求走缓冲**——客户端全程收 keepalive 空 delta,真实内容末尾一次性刷出,故客户端可见首包 ≈ 全程时长(p50≈79s / max≈356s),而上游其实几秒就吐字(TTFT p50≈6s)。**现状**:埋点已让此差异可量化(`buffer_hold_ms` 分布 + 详情面板「buffer hold」)。**暂缓原因**:改缓冲/透传行为是另一个大 spec(触及 protect_streaming_generation + L2 buffered-retry 的取舍)。**若做需改什么**:评估 protect_streaming_generation 是否可改为「透传直到需重试才回缓冲」,或对已确认无重试风险的请求走真透传;需重新审视 buffered-retry 的正确性依赖。
- **fleet TTFT 分位排除 aborted(盲区)**:遥测 sink(`sinks/telemetry.ts`)只订阅 `request.completed`/`failed`、显式排除 aborted。故 `/api/stats` 的 DDSketch TTFT 分位**不含 client-abort 尾部**——而超时/断连的最坏尾部恰是 aborted。**现状**:per-request 层完整(`state=aborted` 行仍有 timing 列),只是 fleet 聚合盲。**暂缓原因**:埋点本轮只做观测;分位偏乐观可接受。**若做需改什么**:为 timing 单开一个**纳入 aborted** 的 distribution sink(与 verdict counter 分离,避免把 aborted 误计入 success/failure),或 `/api/stats` 暴露 distribution `count` 让消费端对账。
- **近期窗口(sinceStart/7d)无 sketch 分位**:`/api/stats` 的 DDSketch `distributions` 只在 SQLite-tiered 窗口(30d/90d/lifetime)返回;sinceStart/7d 走内存 fixed-bucket、无 sketch。**现状**:排查「今天这批」的近期分位走 fixed-bucket 直方图(`/metrics` 或 7d)。**暂缓原因**:sketch 服务 30d+ 趋势足够,近期有 fixed-bucket。**若做需改什么**:扩展 `/api/stats` 让 7d 也从 `tel_raw` 读 DDSketch,并定义时钟窗口与 series 的对账。
- **live 进行中时序面板**:当前详情面板 timing 在请求 settle 后经 REST 重取才显示。**暂缓原因**:进行中显示 TTFT/keepalive 空窗需 `active_request_changed`(active-request-wire.ts)加时序字段——额外接线,价值待验。**若做需改什么**:`ActiveRequestWire` 加 timing 字段 + 前端 LiveDock 消费。


## 交互式 TUI（P1）打磨项（真终端 + review 暴露，2026-07-11）

- **help 切换时选中行瞬时脱窗（review F1，minor，自愈）**：`controller.ts` 的 `reduce` 处理 `help` 键（翻转 showHelp）时不重算 `scrollOffset`；而 showHelp 使可见内容行数 -1（capped 小窗放大此瞬态）。已复现：overflow 态 sel=4/off=3 按 `?` → 选中脱窗一帧，下次 nav 键 visibleRows 重算即拉回。**若做**：干净修需把 scroll-clamp 在 help 切换时用**新** showHelp 的 visibleRows 重算——但 `reduce` 纯函数只拿到单个 `ctx.visibleRows`（terminal-ui 用**旧** showHelp 算的），故要么 terminal-ui 在 `reduce` 后按新 showHelp 重算 visibleRows 再 `scrollToShow` 重夹（scroll-clamp 部分移到集成层），要么给 `UiContext` 传 `panelRows`+`activeCount` 让 reduce 自算 `panelContentRows(新showHelp)`。属架构小调整，自愈故非阻塞。
- **~~面板高度 1↔2↔3 残留 churn（review F2）~~ 已解决（commit 069c2293）**：恒高修复（内容补空行、总高恒 min(rows,3)）彻底消除所有高度变化，不止大摆幅——F2 关闭。原文备查：：空行根因修（commit `cfc4f05e`）把大摆幅 churn 消除（在途 ≥3 恒 3 行），但在途在 0↔1↔2↔3 之间变时 `panelContentRows` 仍返 1/2/3，`Region` 仍走 geometryChanged 重锚 → 理论上 1-3 并发时仍可能冒 stray blank line。**若做（彻底消除）**：panel 恒 `MAX_PANEL_ROWS` 行、不足补 dim 空行（几何全常）——代价是 1 个在途也占 3 行、浪费屏幕。用户明确要「最高 3」（动态 ≤3），故先取当前取舍；若用户实测 1-3 区间仍频繁空行再切恒高。

- **~~折叠态常驻 2 空行~~ 已过时（用户 2026-07-11 反转设计）**：原「恒定高度区、collapsed 补空行到 3 行」方案被用户否决——现 collapsed **默认 N=1**（commit e603fd91），不再有常驻空行。防吞行改由 `Region` scroll-before-grow 保证（允许切换出空行、严禁吃日志行）。此条关闭。
- **scroll-before-grow 窄缝：resize 撞视图切换同帧可能吞行（review Minor，2026-07-11）**：`Region.render` 的 scroll-before-grow 用 `rows === prev.rows` 守卫（`oldBottom` 依 `prev.rows` 推导，真 resize 后坐标过时、放宽会打错行故守卫承重）。当 SIGWINCH 与 collapsed→panel 切换**严格同帧**时守卫跳过、退化为普通重锚，可能吃一个底部行。**为何暂缓**：真终端 resize 事件与 keypress 几乎不同帧，且 resize 时终端自身已 reflow；概率极低。**若做**：在 scroll-before-grow 前先按新旧 rows 差单独补一次滚动，或把两步几何变换（resize + grow）拆成两次 render。当前有代码注释标注此已知窄缝。
- **Bun.Terminal 无法覆盖真实 PTY resize 通知传播（2026-07-18 再收窄）**：垂直重锚逻辑已由 ⑤ `resize-reanchor.pty.test.ts` 注入 mutable rows 覆盖；水平重算已由 ⑥ `horizontal-width.pty.test.ts` 注入 columns 30→7 覆盖；TerminalUi 默认 getter 链也由可变 fake stdout 的真实 bus→TerminalUi→Region 单测证明会重读 `stdout.columns`。**唯一仍无法端到端测的宿主环节**是 `Bun.Terminal.resize()` 改伪终端尺寸后，既不给子进程投递 SIGWINCH，也不刷新子进程 `process.stdout.rows/columns`。**为何暂缓**：这是 Bun.Terminal primitive 的能力缺失，生产 getter 和后续重绘均已有独立有牙覆盖。**若做需改什么**：① 等 Bun 支持 resize 时投递 SIGWINCH并刷新 stdout 尺寸（跟踪 Bun changelog）；或② 换会投递 SIGWINCH 的 PTY primitive（node-pty 在 Bun 下 spawn 语义损坏，见 PoC `exp/poc-js-pty-grid/`）。
- **error-shaping 决策遥测记录点在 `ctx.fail()` 之后（2026-07-14，随「TUI 转圈」bug 一并定位）**：**现状**：`shapePrecommitError`（`error-shaping-glue.ts:102`）/ `shapePostcommitErrorFrame`（`:176`）在 `ctx.fail()` **之后**调 `recordFeature("error-shaping-decided")`。因 `ctx.fail()` 已同步冻结 history entry，这个晚到的 feature ① 进不了冻结 entry ② 也无法出现在 TUI 的 `[FAIL]` 完成日志行里（该行在 `onTerminal` 打印、早于晚事件到达）。晚事件还曾复活 TUI 死请求（已由 `terminal-ui.ts` upsertCtx 的 `isTerminalState` guard 通用防御修复）。**为何暂缓**：转圈症状已被 TUI guard 治好（通用、覆盖所有晚事件 producer）；本条只剩「tag 不进 [FAIL] 行」这一 cosmetic 观测缺口，非承重。**若做需改什么**：把 error-shaping 决策记录移到 `ctx.fail()` **之前**（producer 侧 settle-signal 模式，契合 skill `persistence-async-invariants` 的「信号在 committed settle 点记录」/「settle 冻结快照前 record」），使决策既进冻结 snapshot、又能进完成行——牵动 handler catch（`handler-v4.ts:326`/`:514`）与 route catch（`route.ts:13`）跨层的 settle 边界职责划分，故独立处理。注意**不可**改成「recordFeature settled 后 no-op」——那会真丢 telemetry sink 对该决策的观测。
- **终端 TUI 破坏性动作（P2，用户 2026-07-11 明确推迟）**：abort 在途请求（面板内选中→`x` 键→`manager.get(id).reapInFlight()`+终态 settle，`tui/actions.ts` 独有控制写权限，见 ADR 决策 1）+ OSC52 复制 req_id（PoC `exp/tui-rawmode/osc52-copy.ts`，失败退回显示 req_id 供鼠标选）。渲染模型分层 spec §6 明确排除、属独立后续特性。**注意**：这与 Web UI 的「LiveDock 面板内直接 abort」（本文件另一条）是**两个不同界面**的同类能力，别混。**若做需改什么**：controller 加 `x`/`c` 键消费（P1 现为 no-op）、`tui/actions.ts` 新增 + ESLint 放行其 `manager` import、abort 后 detail/panel 重绘。

## per-model 上游过载背压（用户 2026-07-11 决策：spec 完成即止、作可选增强）

- **背景/动机**：GHC 对 opus-4.8 等间歇过载——单次 attempt 挂数百秒后返 502 GitHub Unicorn 页 / `NGHTTP2_REFUSED_STREAM`，`server-error-retry` 重放**同 payload** 再烧几百秒（实测 `req_300` = 71s→502→再挂满 300s→abort = 371s 白烧）。502 横跨 07-04/05/08/11 反复、单日 6+ 次。根因应对 = GHC 过载时**按模型降速退避**（背压），非盲目逐请求重放。
- **规格（已与用户敲定七项承重决策）**：见 `docs/spec/2026-07-11-per-model-overload-backpressure.md`。要点——D1 滞动窗口 N-in-M 检测；D2 事件集 = 5xx server_error + REFUSED + 上游 idle-timeout；D3 复用已存在的 TTFB/idle 超时（`response_header`/`stream_idle`）；D4 idle-timeout 熔断可重试且计入窗口；D5 复用现有 `AdaptiveRateLimiter` 状态机 + 原因 tag（429 vs upstream-overload）；D6 窗口 per-model；D7 节流 per-model（429 仍全局）。
- **暂缓原因**：用户明确「推进到 spec 完成后结束、作可选后续增强」。急性症状（请求"卡住"）已由**配置修复**消除——事故时 `response_header=0` 禁用了 TTFB 超时，改回 300 后单请求不再无界挂起（根因排查见 `exp/ttfb-timeout-queued/report.md`，已加 `response_header=0`/`stream_idle=0` 防呆告警）。故本特性从"急性修复"降为"过载浪费优化"，价值在但不紧急。
- **若做需改什么**：新增 `PerModelOverloadGovernor`（`Map<modelId, {滞动窗口 + 复用的 AdaptiveRateLimiter 实例}>`）；请求路径在全局 429 限流器后叠 per-model 层（`http-transport.ts` 的 `executeWithAdaptiveRateLimit` 包裹点）；transport 侧 attempt 失败经 `classify.ts` 的 error type 调 `reportOverloadSignal(modelId, kind)`；配置新增 `overload_backpressure.{enabled,window_sec,threshold}`；`/api/status` + WS `system.rate_limit_state` 扩 model 维度 + 原因 tag。实现分两 phase（governor+窗口纯单元 → 信号桥+接线+可观测）。开放问题：GovernorUnit 空闲回收、是否按 endpoint 再细分（默认否）。


## Console footer 宽度感知落地的跟进项（2026-07-10）

- **背景**：footer 行宽感知 + 按模型分组已落地（`docs/plan/2026-07-10-tui-footer-width-aware-grouping.md`）。以下四项经计划评审明确推迟（footer-only 瞬时损失、完成态 log line 补回，可接受），非本次范围：
  - **`renderFeatureTag` detail 富化**：`tool-input-decode-failed` / `context-edits-applied`（带 `{count,clearedInputTokens,types}`）/ `protect-streaming-retry`（带 `{outcome,retries}`）/ `tool-input-repaired` 等 8 个 recovery/repair case 当前只渲染裸标签名，未展开各自 `detail`。若做：在 `console.ts` 的 `renderFeatureTag` 对应 case 里读 detail 拼富标签（如 `context-edits:3`），加对应单测。
  - **单请求 footer 富化**：count===1 分支仍只显 method/path/model/elapsed/stream，未显已应用 tags/thinking/attempt 次数（有富数据但末端未呈现）。若做：在 count===1 分支追加 tag 摘要，仍经 `finalizeFooter` 截断。
  - **外部直写 stdout 撞 footer**：任何绕过 `printLog` 的 `console.log` 会撞坏 footer 协调。当前 republish 已收编 consola，残余风险低。若做：需一个全局 stdout 写入拦截层。
  - **`(resolving)` 桶丢 path**：未解析模型的请求在分组里归 `(resolving) ×N`，丢了各自 path（现状逐条显示会带 path）。footer-only 瞬时损失，完成态 log line 补回。若做：`(resolving)` 桶特殊化为逐条显示 method+path。

## ✅ 已解决：分组 footer 自适应显示最久的 N 个请求时间（用户 2026-07-10 要求 → 2026-07-11 落地 097404df/f1d0492a）

- **背景/动机**：现状多请求分组 footer 每组只显**单个** `maxElapsed`（最老请求）。用户要求：根据组数自适应显示每组**最久的几个**请求时间。
- **规格（已与用户敲定 + 默认补全）**：每组显示条数 = f(组数)——**1 组→最久 5 个 · 2 组→每组最久 3 个 · 3 组→每组最久 1 个 · 4+ 组→每组最久 1 个**（横向空间紧，默认，仍受 `columns-1` 宽度截断兜底）。组内「最久的 N 个」= 组内请求按 elapsed 降序取前 N 的 elapsed。段形如 `claude-opus-4-8 ×5 ↓12KB 9.1s 7.3s 5.0s 3.2s 1.1s`。
- **落地实现**：`buildModelGroupSegments`（`src/lib/tui/render/footer.ts`）改 `oldestStart: number` → `startTimes: Array<number>` 累积组内全部起始时刻；新 `timesPerGroup(groupCount)`（1→5/2→3/3+→1）；段内 `startTimes` 升序取前 N（= elapsed 降序 = 最老 N 个）拼 `formatDuration`。宽度驱动纳入循环的 `stringWidth` 兜底不变。golden-fixture 场景（2 组：gpt-5 ×2 + claude-opus-4-8 ×1）已重生为 `gpt-5 ×2 1.0s 500ms`；`console-footer.unit.test.ts` 加 1/2/3 组各自 N 的直接单测（正样本：旧单时间码会红）。

## GHC server_tool_memory 默认关 — CAPI 接受性待探针

- **现状**：`anthropic.server_tool_memory` 默认关。GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入，故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。
- **实测结论（2026-07-08，探针 `exp/server-tool-memory-probe/`）**：**CAPI（enterprise 账户）接受** `memory_20250818` server tool 声明 + `context-management-2025-06-27` beta —— 上游 2xx（`stop_reason:end_turn`）且响应体**回显 `context_management:{applied_edits:[]}`**，证明特性被主动处理而非静默忽略。wire 由生产 `rewriteMemoryTool`/`buildAnthropicBetaHeaders` 正确产出（`[{"name":"memory","type":"memory_20250818"}]`）。**边界**：① 仅 enterprise 端点确认——默认 individual base URL（`api.githubcopilot.com`）首跑请求**挂起无响应**，individual/business 接受性未确认、不可外推；② 已验 **wire 接受性**，**未**端到端触发 memory 存取（无 `server_tool_use` 块，需触发存取的 prompt 才能验实际行为）。结论详见探针 README `## 结论：接受`。
- **端到端实测（2026-07-08，enterprise，探针参数化 `PROBE_PROMPT`/`PROBE_MAX_TOKENS`）**：**memory 工具端到端被真正调用 · 确认**——诱导 prompt 让上游产出真实 `{"name":"memory","type":"tool_use","input":{"command":"view","path":"/memories"}}` 块（`stop_reason:tool_use`），结构化 tool_use 非文本敷衍。**关键**：memory 是 **client-executed** 工具（`type:"tool_use"` + `caller:{type:"direct"}`，非 `server_tool_use`）——上游只**驱动**（发 view/create 命令），实际 `/memories` 存取由**最终 client**（Claude Code）执行、多轮 tool_result 喂回。故永不会有 memory 的 `server_tool_use`/`applied_edits`。**含义：本项目侧无需自建 memory 后端，只需透传该 tool_use 不拦截**。
- **多轮透传实测（2026-07-08，enterprise，`probe-multiturn.ts`）**：**请求侧管线多轮 memory 往返透传 · 确认**——含 memory `tool_use`（assistant）+ `tool_result`（user）的续接会话经**完整生产请求侧三段**（`preprocessAnthropicMessages` → `runAnthropicPayloadRewrites` → `createAnthropicMessages`，忠实复刻 `handler-v4` 顺序）后，两块**原样保留、`tool_use_id` 配对未乱**（sanitize orphan 计数 0），上游 Hop2 **2xx 续跑到 `end_turn`** 并消费 tool_result；带签名 thinking 块亦逐字透传、未触发 thinking 400。**探针保真教训**：单跳 `probe.ts` 直调 `createAnthropicMessages` 只跑 prepare、**测不到 sanitizer**（生产里 sanitizer 在路由层更早跑），多轮探针复刻三段才真正验到 `processToolBlocks`。翻默认前的请求侧透传残留点消除。
- **决策（用户 2026-07-08）**：**保持默认关**（`server_tool_memory` 不改）。enterprise 已 wire + e2e + 多轮透传**三绿**、可放心手动开；唯一未闭合缺口 individual/business 端点**凭据阻塞、不可测**（本账户是 enterprise），故不全局翻默认。若将来拿到 individual/business 凭据复测通过，可评估 account-type 门控或全局翻默认。
- **权威现状**：skill `ghc-api-reference` + `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md`.

## server_tool proxy 实现推广（web_fetch / code_execution）+ 自愈表 web_search-centric 缺口（PoC 2026-07-12）

- **背景/动机**：反应式自愈网现在对原生 server tool 只会「一律 strip / 事后 downgrade」，即「假装它不存在」。反面问题是**让它真的存在**——由 proxy 自建服务端实现（如已退役的 web_search 双跳曾做的那样）。已做 PoC（`exp/server-tool-web-fetch-poc/`）以 **web_fetch** 为最小样本验证可行性与推广度。**注意**：web_search 双跳整套已于 2026-07-13 退役删除（服务 0 真实流量、永久 bypass 税，见 ADR `docs/decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md`）——其前向编排的参考实现只留在 **git 历史 + `exp/web-search-double-hop-live/` 探针**里，不再是活代码。若将来真要做 web_fetch/code_execution，是从零搭建而非「照抄现成旁路」。
- **实测结论（PoC 探针，2026-07-12，individual，`api.githubcopilot.com`，claude-sonnet-4.5→sonnet-5）**：GHC/CAPI **不原生支持 web_fetch**——原生声明原样到达 wire（默认不 strip），上游 **HTTP 400 `{"error":{"message":"rejected tool(s): web_fetch","code":"invalid_request_body"}}`**。故 web_fetch 要被支持**必须走双跳**（同当年 web_search），`exp/server-tool-web-fetch-poc/fetch-backend.ts` 即 execute 步骤（本地跑通、无外部依赖、tsc 干净）。
- **连带发现（已核实，独立价值）**：反应式自愈表 `src/lib/request/strategies/server-tool-rejection-retry.ts` 的 `SERVER_TOOL_REJECTION_TABLE` **只有 web_search 一条 pattern**（`/the use of the web search tool is not supported/i`）。实测 web_fetch 400 是**另一种措辞**（`rejected tool(s): web_fetch`）→ **不匹配**，故 web_fetch/code_execution 等被上游 400 时**不会被反应式预剥、会硬失败**（strip 现纯 reactive-learned，无全局 config 键可兜底）。即当前 strip/自愈路径本身也是 **web_search-centric**。
- **工具分类（谁执行决定要不要自建后端）**：真·server-executed（要自建）= web_search（双跳已退役删除，见上）/ web_fetch（本 PoC，execute=fetch，轻）/ code_execution（要沙箱，重，未测但推断 400）；client-executed（**不**要后端，别 strip、透传）= memory（已实测，见本文件上一条）/ computer / text_editor / bash。
- **暂缓原因**：PoC 只证可行性与 execute 的 triviality，未做生产化；此类特性默认无实现、非阻塞；生产化是独立设计任务。
- **若做需改什么**：① 抽 **server-tool provider registry**（按 `type` 注册 `{detect, downgradeToFunctionTool, execute, synthesizeResultBlock}`），从零实现 web_fetch 作第一条（web_search 双跳的旧参考实现已删，只能从 git 历史/exp 探针取形状）；② **响应过滤器旁路 + 专用 handler**——合成的 `server_tool_use{web_fetch}` + `web_fetch_tool_result` 必须绕过常驻 `server-tool-filter`（否则被无条件吞掉、客户端看不到），这是把 web_fetch 从「换个 execute」变成「一整套平行件」的真正承重项；③ synthesize / downgrade 的 **web_fetch 专用变体**（现存 `sanitize/rewrite-server-tool-blocks.ts` 的 downgrade 硬编码 web_search 措辞/形状，synthesize 步随 web-search 目录删除、须重建）；④ 给 `SERVER_TOOL_REJECTION_TABLE` 补 web_fetch/code_execution 的 400 pattern（单行缺口，最小可先补此项）；⑤ **web_fetch 独有 SSRF 面**——execute 抓模型可控任意 URL（可达内网/云元数据），生产 execute 应加目标校验（拒私网/元数据 IP）。发现方：PoC + 对抗性 subagent 审查（2026-07-12）。


## stripToolFields 预剥的深层可观测性（history/telemetry 维度）

- **现状**：`stripToolFields`（`message-tools.ts`）剥除未知 custom-tool 字段（如 `eager_input_streaming`）时仅发结构化 `consola.warn`（命名剥除字段 + 受影响 tool 数），与 sibling `stripServerTools` 同档。反应式腿经 `RetryAction.meta.strippedToolFields` 已可达；但**内置默认 / config / cache 的 proactive 预剥是常态路径**（首请求就零 round-trip），它不经重试、不进 history `sseEvents` / request-telemetry 维度。
- **暂缓原因**：`buildWirePayload`（B1/B2 ctx 初始化，非 prepare step）当前无事件发射通道，sibling `stripServerTools` 亦仅 warn；就地新建 telemetry 通道属跨切面改动，超出与 sibling 对齐的范围。对抗审查 M2 提出、判为「决定数据模型的后续项」。
- **若做**：给 prepare 阶段（或 `stripToolFields` 返回值）接一个能到达 history/request-telemetry 的结构化回执（剥除字段集 + 受影响 tool 数 + 来源 builtin/config/cache/hint），前端可选呈现（richest-data-flow）；同时可顺带给 `stripServerTools` 补同款可观测性。遥测架构见 skill `telemetry-architecture`。

## unknown HTTP endpoint 可配置日志 — 四项范围外后续（spec 2026-07-14，三轮评审识别）

来源：`docs/spec/2026-07-14-unknown-endpoint-logging.md` 的非目标 + 三轮对抗评审识别出的边界项。本轮 spec 做「404/405 按状态码分类的可配置日志」，以下四项明确排除、记此备忘。

- **`browser_probe` 第三类日志级别**：现状浏览器自动探针（favicon / devtools）静默返回 204、不进日志管线，本轮不纳入（用户选择）。**若做**：`unknown_endpoint_logging` 加第三个 key `browser_probe`（silent|debug|info|warn|error），把 `server.ts` 的 `browserProbePaths` 短路也接入分类/finalizer 管线。需求触发时启用。
- **已注册路由 handler error 的分类日志**：现状 `onError`（`src/server.ts`）已对已注册路由抛出的异常 `consola.error`，非当前缺陷。**若做（且仅当有真实需求）**：若要按 route family / status 分级别配置，应**独立设计**、独立 config section，**不复用** `unknown_endpoint_logging`（两者关注点不同：一个是「端点不存在」、一个是「已存在端点内部出错」）。
- **O2(b) 收窄 CORS 使普通 OPTIONS 可诊断**：现状全局 `cors()` 对所有 OPTIONS 返 204（不要求 preflight header），unknown OPTIONS 不到 notFound、永远伪成功（诊断盲区）。用户裁决本轮**保留现状**。**若做**：收窄 `cors()` 只豁免 preflight-shaped 请求（带 `Origin` + 非空 `Access-Control-Request-Method` token——注意这只判「结构像 preflight」，不代表 CORS 策略允许该 method），普通 OPTIONS 落入 404/405 分类。**需改什么**：改 `cors()` 接线 + 回归验证既有 CORS 客户端。reviewer 与主会话原倾向做，用户选最小改动。
- **ALL route-owned `c.notFound()` 精确识别**：现状三态分类器的 route-owned 识别只覆盖 method-specific route；若 `.all()` 业务 handler 主动调 `c.notFound()`，会因 shadow 排除 ALL route 而误判成 unknown-404/405。**当前无实际漏判**（项目现有 `.all()` handler 均不调 `c.notFound()`，有守卫测试锁死此前提）。**若做**：用执行时 provenance（`c.req.matchedRoutes` / `c.req.routeIndex`）区分「当前 handler 是 `.all()` 业务 handler」vs「middleware」vs「真 routing miss」——需先做小 PoC 实测 routing-miss 时的 `routeIndex` 值。守卫测试变红（新增 `.all()` fallback 调 `c.notFound()`）是启动此项的触发信号。

## `PUT /api/config/yaml` 系统性缺口：多个 config section 未接入 mergeConfigIntoDocument（2026-07-14 合并态审查发现）

- **现状/根因**：`src/routes/config/route.ts` 的 `mergeConfigIntoDocument` 是**显式逐 section 列举**（每个 `if (hasOwn(body, "X")) ...` 一行），schema 允许的顶层 section 若漏列，则 `PUT /api/config/yaml` 对该字段**schema 校验通过、但不写进 doc → 返回 200 但磁盘/state 静默不生效**，UI 配置页保存该项形同虚设。unknown-endpoint-logging 功能实现时也踩了同一坑（已修：接线 + 回归测试 config-yaml-routes.http.test.ts）。
- **既有漏列 section（PUT 静默无效）**：经 grep 对比 `ConfigSchema` 顶层 keys vs merge 处理集，至少 **`chat_completions` / `telemetry` / `disabled_models` / `sanitize_tool_names` / `buffered_retry` / `ghc_api_base_url`** 未接入（可能还有，须逐个核）。这些是**既有缺陷**、非某次功能引入。
- **为何暂缓**：跨多 section 的系统性接线 + 各自的 PUT 生效测试是独立清理任务，超出单功能范围；合并态审查（gpt-souls:reviewer 2026-07-14）建议另开 backlog、不阻塞当轮 PR。
- **若做需改什么**：① 逐个把漏列 section 加进 `mergeConfigIntoDocument`（scalar→`setScalar`、嵌套 scalar→`setNestedScalarContainer`、集合→`replaceCollection`，按 section 结构选）；② 每个补一条 PUT 写入生效测试（`config-yaml-routes.http.test.ts` 模式：writeConfig→PUT→readConfig 断言写入 + 字段级 null 删除）；③ **更根本**：考虑把 merge 改为 schema-driven 遍历（从 ConfigSchema 结构自动派生 merge 策略），消除「加 section 忘接 PUT」这类反复复发的漏接——但需先评估各 section 的 scalar/collection/nested 差异能否统一映射（model_mappings 等 replace-semantics 与 timeouts 等 merge-semantics 不同，见 schema.ts `RECORD_MERGE_STRATEGIES`）。发现方=合并态对抗审查。

## context-edits 回执 telemetry（7d 分布）
- **现状**：`applied_edits` 诊断回执已落地（commit f55fd93，`src/lib/anthropic/applied-context-edits.ts`，流式经 accumulator `message_delta` / 非流式经 handler 顶层，两路发 `recordFeature("context-edits-applied", {count, clearedInputTokens, types})`），进 observability feature 维度计数。
- **暂缓**（用户 2026-06-29"暂时不做"）：接进 `request-telemetry` 做 7d 持久分布（现只 feature 维度计数，无 cleared token 量直方图）；实证开启 `protectStreamingEscalateContext` / `contextEditingMode` 后真有非空 `applied_edits`（当前样本 req_1782713407242_1 全空回执）。
- **原因**：命中率 / 价值未知，先收集 feature 计数再决定是否加 telemetry 维度（YAGNI）。遥测架构见 skill `telemetry-architecture`。

## setup-claude-code CLI 尊重已有配置（+/~/- diff）

- **[已落地 2026-07-08]**（commit `86cb2ff5`）：`writeClaudeCodeConfig()` 现总是 per-file `+/~/-` diff + 确认再写；`--yes` 自动应用、`--dry-run` 只展示不写、非 TTY 无 `--yes` 时 abort（never-swallow：坏 JSON 文件拒 clobber）；纯函数 `computeJsonDiff` / `decideWriteAction` 已抽出并单测。
- **Follow-up（learn-by-analogy，本次未做以守范围）**：`src/setup-codex.ts` 与此同构（也写 `~` 下 JSON config）。`computeJsonDiff` / `decideWriteAction` 已文件无关、可直接复用，建议类比给 setup-codex 套用同一 diff/confirm/`--yes`/`--dry-run`/非 TTY-abort UX。
- **现状（历史）**：`src/setup-claude-code.ts` 写 `~/.claude.json`/`~/.claude/settings.json`。config-respect UX（检测已存在的自定义配置、破坏性覆盖前展示直观 `+/~/-` diff 并确认、区分 essential=默认写 vs extension=仅 opt-in）**未实现、未文档化**——此设计意图原挂在记忆 `feedback_tests_never_touch_real_env` 的一条 How-to 里（该记忆的主旨是测试隔离、此条属跑题内容），记忆降 stub 时归位至此以免丢失。
- **若做**：给 `writeClaudeCodeConfig()` 加 merge/diff 层（读现有 config → 计算 essential/extension 分类 → 展示 diff → 确认再写）；无 CI/守卫，属独立 UX 特性。
- **原因**：非承重、无用户明确需求，先记录待用户决定优先级。

## RFC 数据模型裁剪审计 — 剩余低信号

- **现状**：12 个优先 RFC 已审（2026-06-24，4 并行 subagent + 主线核验）零 richest-data-flow 裁剪违规，3 个 SHOULD-BUILD 全实现（非流式语义残缺检测 / 顶层 `failureReason` 投影 / HTTP2 trailers 捕获，commit `0284935`/`6fd6d4d`/`e30ca33`）。判据已内化进 ADR `docs/decisions/2026-07-05-richest-data-flow.md`。完整审计叙事见 `docs/archive/memory/project-audit-rfcs-data-model-pruning.md`。
- **未审（低信号）**：非优先 RFC（p2.6 / upstream-http2 / tool-call-text-recovery）、observability sinks 的 filter 逻辑、dry-run `fidelity.caveats`（subagent 判为诚实文档非裁剪，可复核）。
- **判据**：字段 / 腿 / per-attempt 描述真实可观测阶段即须完整存（前端可不展示）；区分「裁剪数据模型」（禁止）vs「收敛捕获机制 / 单一 owner」（允许）。

## 前端 lint 未启用 react-hooks / jsx-a11y 规则（全仓 tooling 缺口）

- **现状**：`eslint.config.js` 调 `config({ prettier })` 未开 `reactHooks` / `jsx`（a11y）/ `react` 任一开关；预设 `@echristian/eslint-config` 默认三者 `enabled:false`（插件 `eslint-plugin-react-hooks@5` / `eslint-plugin-jsx-a11y` / `@eslint-react` 已装但未接线）。`eslint --print-config` 实测 resolved rules 里 `react-hooks/rules-of-hooks`、`react-hooks/exhaustive-deps`、`jsx-a11y/*` 全缺，仅 16 条 `react/jsx-*` 排版规则且都 off。
- **根因 / 当前行为**：hooks 依赖数组完整性、受控 state、a11y 标记全无自动化护栏——靠手写 + subagent review 兜底（如 ModelsTable TanStack 重写的 `select` useCallback 缺失是 subagent 抓的，非 lint）。ui-v4 是 hooks 密集子项目，长远正确性应把这类正确性固化为门禁。
- **暂缓原因**：跨切面 tooling 改动，牵动全 monorepo（含存量 Vue `ui/` + React `ui-v4/`）；整仓启用会牵出大量存量告警，需独立审计分批修，不宜塞进单个功能提交（会掩盖功能 diff + 有连累 sibling 包 lint 的风险）。属独立工作项而非「因范围大降级」。
- **若做**：`eslint.config.js` 的 `config({...})` 传 `reactHooks:{enabled:true}` + `jsx:{enabled:true, a11y:true}`（可选 `react:{enabled:true}`）；建议先用 `files` glob 限定 `ui-v4/**/*.{tsx,jsx}` 启用（实测本 PR 新代码零报错），再逐步扩到 `ui/`，逐包清存量告警。发现方：ModelsTable TanStack 重写的 subagent code review（2026-07-07）。

## RFC gap F：token-limit 变体正则 — 无真实 golden body，暂缓（O3 无 golden 不猜）

- **根因**：`parseTokenLimitError`（`src/lib/error/parsing.ts`）只有 2 条正则——OpenAI `prompt token count of N exceeds the limit of N`、Anthropic `prompt is too long: N tokens > N maximum`。理论上还可能存在第三种上游 token-limit 措辞（`max_tokens`-inclusive body、Vertex 措辞的 context-length 400、`context_length_exceeded` code、`maximum context length ... tokens` 等 OpenAI/Vertex 变体），若上游真发这类 body，当前会漏解析 → 落到 `bad_request`，`classify.ts:203-207` 的 400→`token_limit` 分支拿不到 `{current, limit}`，auto-truncate 永不触发。
- **当前行为**：`classify.ts` 400 路径已正确经 `extractTokenLimitFromResponseText`→`parseTokenLimitError` 抽取（已核实，无需另改）；解析成功即路由 `token_limit`、失败即 `bad_request`。接线完整，缺的只是「第三种措辞的匹配能力」。
- **理想架构**：捕获真实上游变体 body 建 golden fixture → 加**精确匹配该真实措辞**的第 3 条正则 → TDD 红/绿。措辞必须来自真实 body，不臆造。
- **为何暂缓（硬门槛未过）**：**穷尽扫描了完整 History 语料**（`~/.local/share/copilot-api/history.db`，425MB + 117MB WAL，704 entries / 2501 stages，只读、zstd 解压全量 blob；另 grep `tests/` `docs/` `exp/` `refs/`）——**没有任何一条当前 2 条正则漏掉的真实 token-limit body**。语料里全部 token-limit 上游拒绝都是 Anthropic `prompt is too long: N tokens > N maximum`（code `model_max_prompt_tokens_exceeded`，如 `1002738 tokens > 1000000 maximum` / `1002484 tokens > 1000000 maximum`），**已被现有 Anthropic 正则命中**。其余 400 body 全非 token-limit（`thinking blocks cannot be modified`、`Unexpected role "system"`、`invalid_reasoning_effort`、`web_search` 相关、502 GitHub unicorn HTML、`stale context reaper` 等）。无 `max_tokens`-inclusive、无 Vertex 措辞、无 `context_length_exceeded`、无 `maximum context length`。按 RFC O3「无 golden 不猜」，**不产出任何投机正则**。
- **若做需改什么**：等真实上游发出第三种措辞并被 history 捕获后——① 从该真实 body 建 golden fixture（放 `tests/error/`）；② 写测试断言 `parseTokenLimitError(<真实 body>)` 返 `{current, limit}`（当前返 `null`）；③ 加**只覆盖该真实措辞**的第 3 条正则（不宽泛猜测）；④ 复跑确认 `classify.ts` 400→`token_limit`→auto-truncate 链路打通（接线已就绪、无需改 classify）。复查手法：只读解压 history blob 扫 `success:false` 的 `rawBody`（本次扫描脚本可复用）。发现方：RFC「反应式上游拒绝协商」P3 task F golden-first gate（2026-07-07）。

## Requests 列表增强 — 收尾 backlog（2026-07-06 分支 feat/requests-list-enhancement 最终评审滚存）

七维筛选 + TableVirtuoso 列表引擎全落地（spec `docs/spec/2026-07-06-ui-v4-requests-list-enhancement.md`、plan `docs/plans/requests-list-enhancement/`）。最终整分支评审判「可合并、无 Critical/Important」，两条合并前建议（H1 守卫测试 + 测试名 overpromise）已补（commit 8f06e678）。以下 Minor 入 backlog：

- **response_sessions 孤儿映射未扫**（`src/lib/history/sqlite/write.ts` `deleteEntries`）：scoped delete 不清 `response_sessions`（该表对 entries_v2 无 FK）。与 `deleteSession` 同款行为、`clearAllEntries` 兜底、无害泄漏（非数据丢失）。spec §9 文字提过。**若做**：`deleteEntries` 内按被删 entry 的 response id 清对应 `response_sessions` 行，或加周期性 orphan sweep。
- **[已修 2026-07-08]** **chip 日期标签 UTC vs popover 本地时区**（commit `e92c6561`）：`request-filters.ts` 的 `fmtDate` 已改用本地时区、与 `DateRangePopover` 一致（epoch 值 / 筛选结果不动，加了时区无关断言）。原问题：非 UTC 时区跨午夜两处显示串可能差一天。
- **HistoryRow 硬编码像素宽**（`ui-v4/src/components/requests/RequestRow.tsx`，服务 Sessions AgentLane）：未用 `COLUMN_WIDTHS` SSOT（不同布局语境，History↔Live 的 M4 红线已满足）。**若做**：AgentLane 若要与 History 表列对齐，改用 COLUMN_WIDTHS。
- **cosmetic**：`selectionClass` 在 HistoryList 与 RequestRow 各一份；清空确认 Modal 删除在途时「取消」按钮未 disabled（删除仍完成、无数据丢失）；列可见性菜单 multiplier 列 label 显示孤立 "×"（表头简写兼作菜单标签）；useRequestFilters 的 `FILTER_KEYS` 手列可派生自 `Object.keys(EMPTY_FILTERS)`。
- **测试覆盖薄**（非正确性）：useRequestFilters 的 clearAll/数值维 round-trip 未单测；useDebouncedCallback 的 fnRef-latest/卸载清理未单测。

## clientResponse.status 固有 settle 时序缺口 — 非流式上游 HTTP 错误路径

- **根因**：非流式上游 HTTP 错误（`await p` 抛 `HTTPError`）在 `src/routes/messages/handler-v4.ts:365-388` 的 handler catch 里当场 `ctx.fail(resolvedName, error)` **自 settle**（`toHistoryEntry` 同步冻结 entry 快照），而客户端最终收到的转发 status 由下游 `forwardError`（`src/lib/error/forward.ts:497`）在 settle **之后**才根据 error 分类决定（4xx/5xx/504…）。故这条路径转发给客户端的 status 无法在快照冻结前被 `setClientResponseStatus` 捕获。与刚补的 499 预响应 client-abort 路径**性质不同**——499 是 abort 前即已知的字面量（在 handler 内决定），可在 abort 快照前 set；而非流式 HTTP 错误的转发 status 是下游决定的，handler catch 时尚不可得。
- **当前行为**：该路径 `entry.clientResponse.status` 为 `undefined`（快照冻结时未 set，observability middleware 的兜底写发生在 self-settled ctx 快照冻结之后 → no-op）。**上游 leg status 仍完整**（`outboundResponse.status` = 真实上游 HTTP 状态，如 429/500），只是「代理转发给客户端的 status」这一维度在此路径缺失。成功路径 + 499 abort 路径 + defer-settle 失败路径（middleware 兜底）均已捕获，仅此一路径缺。
- **理想架构**：重排 settle 时机使转发 status 在快照前可得——两条路子：① 把 `ctx.fail` 推迟到 `forwardError` 决定 status 之后再 settle（handler catch 只暂存 error，由更下游统一 settle）；② `forwardError` 决定 status 后**回灌** `ctx.setClientResponseStatus` 并触发 entry 的 `updateEntry` 补写（clientResponse.status 进 `updateEntry` allowlist）。②更契合现有 self-settle 架构、破坏面小。
- **为何暂缓**：属结构性 settle 时序重排，牵动 handler catch ↔ forwardError 的 settle 边界职责划分，超出 P3「在既有转发边界并联 setter」的纯增写范围；且该路径的诊断价值可由 `outboundResponse.status`（上游真实 status）+ `entry.state==="failed"` + `failureReason` 组合还原，缺的仅是「代理层转发 status」的独立记录。非承重，先文档化待专门 settle-timing 重构一并处理。
- **若做需改什么**：选 ② 路子——① `forwardError`（`src/lib/error/forward.ts`）决定最终 HTTP status 后，若 ctx 已 settle 则调 `ctx.setClientResponseStatus(status)` + 触发 `updateEntry` 补写；② 把 `clientResponse.status` 加入 `updateEntry` 的字段 allowlist（`src/lib/context/request.ts`，参见 skill `persistence-async-invariants` §2「新顶层字段三处必改」）；③ 加测试断言非流式上游 500/429 错误路径 `entry.clientResponse.status` == 客户端实收 status（扩 `tests/history/client-response-status.it.test.ts`，独立 oracle = `res.status`）。发现方：P3 clientResponse.status 捕获 reviewer（2026-07-07），报告 `/tmp/hdm-P3-report.md` §4。

## Group-B 运营标量迁移 `_index.aux` / `model.multiplier`（P4c-3 未做，正交于 leg 重构）

> **⚠️ 修复路径已随 History V2 removal（2026-07-18）过时** —— 本条描述的 V2 修法（`serialize.ts` META_KEYS / `deserializeEntry` 列往返 / `buildHeadRow`）已随 V2 写链整体删除。在 V3 下，这批字段的产出方是 `v3/projection.ts::recordToHistoryEntry`，与下一节「History V3 projection 字段缺口」是同一问题域——以下节为准，本条仅作 leg 重构历史裁决记录保留。

- **根因**：history 数据模型重构（RFC 2026-07-07）§4 规划把 `requestBytes`/`responseBytes`/`warningMessages` 归入 `_index.aux.*`、`multiplier` 归入 `model.multiplier`（自由投影层）。但 P4c-3（删 legacy leg 写路径）**只删了 leg 字段 + `_index.derived`-已支撑的标量**（`attemptCount`/`currentStrategy`/`failureReason`），Group-B 这 4 个**列支撑/扁平运营字段原样保留**——因其迁移前置条件在 P4a–P4c-2 期间**从未搭建**。
- **当前行为**：`HistoryEntry.{requestBytes,responseBytes,multiplier,warningMessages}` 仍是顶层扁平字段。`requestBytes`/`responseBytes`/`multiplier` 由 SQL 列往返（`serialize.ts` META_KEYS → `buildHeadRow` 写列 + `deserializeEntry` 从列恢复），喂 `EntrySummary`（`in-flight.ts:toEntrySummary`）+ `ui-v4/RequestRow.tsx`；`warningMessages` 由 producer（`request.ts` `toHistoryEntry`）+ sink（`history.ts onTerminal`）写扁平字段、UI（`ui/MetaInfo.vue`、`ui-v4/MetaSegment.tsx`）直读扁平字段。`_index.aux` **全仓零 producer / 零 adapter / 零 consumer**（`grep '_index.aux'` 仅命中类型定义）。
- **理想架构**：RFC §4 目标形状——`requestBytes`/`responseBytes`/`previewText`/`warningMessages` → `_index.aux.*`；`multiplier` → `model.multiplier`（`model{}` 已由 P4c-1 填充、adapter `adaptModel` 已产 `model.multiplier`，故 multiplier 迁移比 aux 更接近就绪）。
- **为何暂缓**：删 Group-B 需**净新增架构**（填 `_index.aux`：serialize 派生的 bytes 要写进 aux；列往返改指 aux；`toEntrySummary` + `EntrySummary` 类型 + 2 个前端文件改读 aux/model.multiplier），**无任何前置阶段搭建**，且直接删会造成 UI/EntrySummary 回归（丢数据）+ golden EntryRow/列漂移。属独立工作单元而非「因范围大降级」——coordinator 决策为 option 1（prepared-only），理由已代码钉死（非偏好）。leg 重构核心不依赖这层标量 reorg。
- **若做需改什么**：① `serialize.ts` `deriveRequestBytes`/`deriveResponseBytes` 结果写进 `_index.aux.{requestBytes,responseBytes}`（或保留列 + 反序列化时投影进 aux）；② `deserializeEntry` 列往返改填 `_index.aux` / `model.multiplier`（当前填顶层扁平）；③ `buildHeadRow` `multiplier: entry.multiplier` 改读 `entry.model?.multiplier`；④ `toEntrySummary`（`in-flight.ts`）读 `_index.aux.*` / `model.multiplier` 代替扁平字段；⑤ `warningMessages`：producer/sink 写 `_index.aux.warningMessages`、UI（`MetaInfo.vue`/`MetaSegment.tsx`）改读、`updateEntry` allowlist 调整；⑥ golden `entryRowSnapshot` 列值应逐字节不变（bytes/multiplier 是列支撑、迁移只改**内存投影位置**非列内容）；⑦ 删 `HistoryEntry`/`HistoryEntryData` 的 4 个顶层扁平字段。发现方：P4c-3 删 vs 留裁决（coordinator，2026-07-07），报告 `/tmp/hdm-P4c3-report.md`。P6 backfill 或独立跟进。

## History V3 缺口（History V2 removal 2026-07-18 暴露/收敛）

### D-2 —— 在线 in-flight 可见，但进程崩溃后不可恢复发现

- **根因**：History V3 由**终端总线单写者**驱动——只在请求 terminal（completed/failed/aborted）时经 `subscribeModelOperationTerminals` → `enqueueModelOperation` 落一条不可变 operation record，**无 ingress/中间态写入**。这与已移除的 V2 不同：V2 请求一进来即 eager 写 `entries_v2` head 行（`status=pending`）+ 逐 attempt 增量 stage，故进行中请求与崩溃残留都在 SQLite 可发现（崩溃行经 `reclaimOrphanedActiveRows` 标 `interrupted`）。
- **当前行为**：进行中请求仅经 in-flight 内存映射 + WebSocket 实时可见；REST `GET /history/api/entries` 合并 in-flight（在前）+ V3 持久（在后）故**在线时**列表完整，但**进程崩溃/被 SIGKILL 时进行中请求零落盘、不留可发现记录**（V2 会留 `pending`/`interrupted` 半截行）。诊断「卡住/被杀的在途请求」的能力较 V2 退化。
- **理想架构**：若要恢复 V2 的「崩溃可发现」保证，V3 需引入 ingress/中间态 operation 写入（非终态 record）+ 启动期孤儿回收——但这与 V3「只落终态、内容寻址、无中间态行」的设计收敛冲突，需权衡：是否值得为「崩溃诊断」重新引入 V2 那类 active-row 模型 + 其并发风险维度（reclaim 误杀、startup VACUUM 撞在途写），还是接受「进行中只在 WS 实时可见、崩溃不留痕」作为可接受降级（内部工具、崩溃罕见）。
- **为何暂缓**：是**设计收敛的已知取舍**而非缺陷——用户批准的 V2 移除本就以「V3 只落终态」为前提。恢复中间态可见性是独立的产品决策 + 结构性新增，非本次范围。
- **若做需改什么**：① V3 store 加 ingress-time draft operation 写入（terminal 前的 pending record）+ terminal 时 upsert 为终态；② 启动期孤儿扫描把非本进程的 draft record 标 interrupted（重引 pid/bootTime 存活性判据，注意 skill `history-sqlite-schema` DB-health 节记录的并发风险）；③ 或走轻量替代：崩溃前把 in-flight 快照落一个单独的 crash-journal（不进 canonical store）。发现方：History V2 removal Phase 3-4（2026-07-18），旧 V2 eager-write 语义随 `entries.ts` 写链删除时暴露。

### step-6 —— V3 projection 非承重字段尚未产出

- **根因**：`v3/projection.ts::recordToHistoryEntry` 把 `ModelOperationRecord` 投影为 `HistoryEntry` 时，一批字段已在 `HistoryEntry`（`src/lib/history/types.ts`）**类型声明**但 projection 尚未产出——V2 移除的 projection 审计（`docs/plan/2026-07-15-history-v2-removal/v3-projection-gap-audit.md`）把它们判为**非承重**（承重字段——transport / leg bodies / usage / model / timing / state / attempts——已在审计后补齐并有 producer-oracle 测试覆盖）。
- **当前行为**：以下字段在 V3 投影出的 entry 里为 `undefined`：`requestBytes`/`responseBytes`（payload 字节计数）、`clientRequest` 结构化投影的 `max_tokens`/`temperature`/`thinking`、`effectiveSource.pipeline`（本轮 truncation/sanitization/messageMapping 元数据）、上游首包时序（upstream-first-packet-timing）。消费端（ui-v4 详情/列表、export）对这些字段取不到值时降级显示，不崩。
- **理想架构**：projection 从 `ModelOperationRecord` 的 manifest/tracks 里恢复这些字段（多数在 record 里有原始数据、只是 projection 未接线读出）；`effectiveSource.pipeline` 与首包时序需确认 record 是否携带，未携带则是 record 写入侧的上游缺口而非 projection 缺口。
- **为何暂缓**：审计判定非承重（不影响 History 核心可用性——请求内容/响应/失败原因/token/时序主干均在）；用户批准的 V2 移除以「先补承重字段、非承重进 backlog」为路径（「先审计出清单再修」）。
- **若做需改什么**：① 逐字段核对 `ModelOperationRecord` 是否已携带原始数据（携带则 projection 加读出、未携带则先补 record 写入侧）；② 每补一个字段配 producer-oracle 测试（构造带该字段的真实 operation、断言 projection 输出——避免「测试与 projection 同源一起绿」，见 skill `verifying-authoritative-claims`）；③ `requestBytes`/`responseBytes` 与上文 Group-B 的 `_index.aux` 目标形状对齐（一并决定落顶层扁平还是 `_index.aux`）。权威清单见 `docs/plan/2026-07-15-history-v2-removal/v3-projection-gap-audit.md`。发现方：History V2 removal projection 审计（2026-07-18）。



- **现状**：`src/lib/transport/proxy-connect.ts`（SOCKS5 + HTTP CONNECT 隧道原语）**整文件 0% 测试覆盖**（reviewer 2026-07-08 用 coverage 报告实测）。含 `connectViaSocks` / `connectViaHttpConnect` 的隧道握手、`fail` teardown（`socket.destroy()` 无 err + inert 语义）、CONNECT 响应解析、leftover unshift、以及本次崩溃修复新加的两处 `withErrorSink(socket)` 应用点。
- **根因 / 当前行为**：该文件建立时无配套测试（pre-existing 缺口，非本次引入）。本次 class-elimination 重构在其两个 socket 创建点加了 `withErrorSink`，模式与已测的 http2-client 站点同构、原语本身已被 `tests/transport/crash-safety.unit.test.ts` 单元测试锁死，但「proxy-connect 确实在创建点应用了 sink」这一站点级不变量无回归保护。
- **理想架构**：起一个 mock proxy 测试 harness——HTTP CONNECT 用 `net.createServer` 读 CONNECT 行 + 回 200/非 200/超时；SOCKS5 用轻量 mock 或真 `socks` server——覆盖：隧道成功握手、非 200 拒绝、超时 `fail`、握手期 socket error 不崩进程（withErrorSink 载重）、leftover-bytes unshift 正确性。
- **为何暂缓**：需搭建 SOCKS5/HTTP-CONNECT mock proxy，属独立测试基建工作单元（宽于本次崩溃修复的范围），且 withErrorSink 应用是单行、与已测站点同构、原语已单测——载重性证据充分。属「独立工作项」非「因范围大降级」，不阻塞本次交付。
- **若做需改什么**：新增 `tests/transport/proxy-connect.it.test.ts`——① HTTP CONNECT mock proxy（net server）测成功/拒绝/超时 + 断言握手期 socket 'error' 无 uncaughtException（正样本：去掉 `withErrorSink` 则红）；② SOCKS5 路径同理（mock 或真 socks server）；③ leftover unshift 用带 body 的 200 响应验证。发现方：crash-safety class-elimination 重构 reviewer（2026-07-08）。
## L1 move_blocks 翻转首块类型 → messageMapping fallback（畸形输入边界）

- **根因**：L1 de-stack 默认策略 `move_blocks`（`src/lib/anthropic/sanitize/assistant-block-layout.ts`，state 默认 `assistantBlockLayoutStrategy: "move_blocks"`）在**畸形的 thinking-not-first** assistant 轮上会重排首块：`[text, thinking, thinking]` → `[thinking, text, thinking]`（把唯一的 real separator 挪到两个 thinking 之间），使该 message 的**首块类型从 `text` 翻转为 `thinking`**。而 `buildMessageMapping`（`src/lib/anthropic/message-mapping.ts`）的 `messagesMatch` 按 role + **首块类型**匹配，首块类型对不上 → 该 message 匹配失败 → 回退到 `lastMatched`（沿用上一条已匹配的 origIdx）。
- **当前行为（已核实无害）**：**有界**——只在畸形输入上发生（thinking-not-first 本就是非法 Anthropic 结构、会被 GHC 拒；合法输入 thinking 必在首位，move_blocks 保持首块仍是 thinking，不翻转）；**优雅**——不崩溃、不抛错，两指针 walk 照常前进；**影响面仅限 history 关联索引**（rwIdx → origIdx 映射用于把改写后消息回指原始消息做 history 对账），**绝不影响送上游的 payload**（payload 是 de-stack 的正确输出，thinking 已合规去堆叠）。
- **理想架构**：三选一——① 让 de-stack 保持该 message 的首块类型不变（畸形轮也不翻转首块）；~~② 把默认策略切到 `insert_text`（原地插入 marker、不移动任何块，天然不翻转首块）~~（**2026-07-27 作废**：该策略已退役，它与上游 C3 互斥）；③ 让 `messagesMatch` 对首块重排具鲁棒性（如按多块类型集合 / id 匹配而非仅首块）。
- **为何暂缓**：畸形输入才触发 + 优雅降级 + 仅 history 索引受影响（非上游 payload）；~~且 `insert_text` 策略**本就完全规避此边界**（保持所有块原位），已是现成逃生舱。~~（**2026-07-27 更新**：该逃生舱随 `insert_text` 退役而消失，本条的暂缓理由现在**只剩**「有界 + 优雅降级 + 仅 history 索引受影响」这三条；`passthrough` 不是替代逃生舱，它连 C1/C2/C3 都不修。）属「有界且无害的次级效应」，非「因范围大降级」。发现方：`feat/thinking-quarantine` 全分支终审 advisory（2026-07-07）。
- **若做需改什么**：按上「理想架构」三选一。（原「最小侵入是把默认策略改 `insert_text`」一说**已失效**：该策略 2026-07-27 退役，因为它与 C3 互斥。）

## thinking budget 与 max_tokens 冲突的行为化解决（现仅告警，未化解）

- **根因**：`adjustThinkingBudget`（`src/lib/anthropic/request-preparation.ts`）的夹取顺序是「先抬到 min → 再压到 max_thinking_budget → 最后压到 max_tokens-1」，最后一步无 re-floor。当客户端 `max_tokens` ≤ 模型 `min_thinking_budget`（如 max_tokens=1000、min=1024），结果 `budget_tokens=999 < min`——Anthropic 要求 `budget_tokens < max_tokens` **且** `budget_tokens >= min`，二者不可同时满足，是客户端自身矛盾的请求。此路径被 adaptive→enabled 合成预算（`coerceEnabledThinking` / `adaptive-thinking-rejection-retry` 默认 medium=24576）**新近更易触达**（adaptive 客户端本无理由把 max_tokens 设大）。另一相关缺口：reactive 策略恰在**元数据静默**时才触发（prepare 已弃权），故重跑时 `adjustThinkingBudget` 无 min/max 元数据，合成的 medium 预算若超过模型真实 max_thinking_budget 也**无法被夹**，会招致第二个 unhandled 400（预算过大）。
- **当前行为**：本次已加**观测告警**（`consola.warn`：max_tokens 无法容纳 min budget、budget 低于模型下限、将被上游拒），不再静默发出畸形 wire；但**未行为化解决**——仍原样发出 `budget=maxTokens-1`，上游照旧 400（只是现在可诊断）。静默元数据下合成预算超真实 max 的情形同样只会招致上游 400、无 learning 兜底。
- **理想架构**：三选一（需用户定夺，属矛盾请求的语义抉择）——① 抬 `max_tokens` 到 `min_thinking_budget+1` 让 thinking 装得下（改客户端输出上限）；② 显式**禁用 thinking**（`type:"disabled"`）让请求至少无 thinking 成功（牺牲客户端 thinking 意图，但比 opaque 400 好）；③ 新增反应式「budget-too-large」learning 策略，从上游 400 学到真实 max 后收缩预算重试（覆盖静默元数据下超 max 的情形）。
- **为何暂缓**：①②是矛盾请求的行为抉择（改 max_tokens vs 丢 thinking），无客观最优、需用户拍板，超出本次 adaptive→enabled 镜像特性范围；③是独立的新反应式策略工作单元。且现实目标场景（Claude Code haiku 子代理）`max_tokens` 通常 ≥ 数千、真实 thinking max 充裕，边界仅在 max_tokens≤1024 等病态值触达，两 reviewer 均判 LOW。属「独立工作项」非「因范围大降级」，已加告警消除**静默**面。
- **若做需改什么**：选 ②/③ 需——② `adjustThinkingBudget` 在冲突分支改写 `wire.thinking = { type: "disabled" }` + 记录 warning + 加测试（矛盾 max_tokens → thinking 被禁用而非畸形预算）；③ 新增 `budget-rejection-retry` 策略（matcher 认领「budget too large / exceeds」类 400、从错误体解析上限、收缩预算重试、注册进两个 builder、`canHandle` 与既有 thinking 策略 matcher 互斥核验）+ 单测。发现方：adaptive-thinking 镜像 subagent 双审（silent-failure-hunter R1 + typescript-reviewer LOW，2026-07-08）。

## reactive `extractErrorMessage` 嵌套-vs-顶层 message 解包鲁棒性（两个镜像策略）

- **根因**：`adaptive-thinking-rejection-retry.ts` 与 `legacy-thinking-retry.ts` 的 `extractErrorMessage` 均用 `parsed.error?.message ?? responseText` 解包。当前上游体是**顶层** `{"message":"adaptive thinking is not supported on this model"}`（非嵌套 `error.message`），靠 `responseText` 整串 fallback 命中子串，工作正常。但若未来上游体形如 `{"error":{"message":"<无关>"},"message":"adaptive thinking is..."}`，解包会优先返回**无关的**嵌套 message、跳过 responseText fallback，导致 `canHandle` 静默 false、self-heal 丢失。
- **当前行为**：对现有两种体形（顶层 message / 嵌套 error.message）都正确命中；仅对「嵌套 error.message 与顶层 message 同时存在且语义不同」的假想体形有漏判风险（当前上游不产生此形）。
- **理想架构**：解包同时兼顾顶层与嵌套——`parsed.error?.message ?? (parsed as { message?: string }).message ?? responseText`；或更稳的做法：直接对**原始 responseText** 跑 matcher 子串判定（绕过脆弱的字段优先级）。两个镜像策略应**同步改**（避免 extractErrorMessage 逻辑漂移）。
- **为何暂缓**：纯前瞻性硬化（依赖上游未来改体形），当前零触发、零成本；且改动应对称覆盖两个镜像策略、宜作一次性 extractErrorMessage 抽公共 + 双策略共用的小重构，而非单侧打补丁引入漂移。
- **若做需改什么**：抽 `extractRejectionText(error, predicate)` 公共原语（放 `src/lib/request/strategies/` 或 leaf），两策略共用；解包兼顾顶层+嵌套 message + responseText fallback；加单测覆盖三种体形（顶层 / 嵌套 / 二者共存且语义冲突）。发现方：silent-failure-hunter R3（2026-07-08）。

## 陈旧交叉引用 `state.ts:384` 指向已迁移的 `budgetToEffort`

- **根因**：本次把 `budgetToEffort` 从 `request-preparation.ts` 迁到新 leaf `src/lib/anthropic/thinking-coercion.ts`，但 `state.ts:384`（现 `packages/foundation/src/state.ts`）注释仍写「见 request-preparation.ts budgetToEffort」。
- **当前行为**：注释指向失效（函数已不在该文件）；纯文档陈旧，无功能影响。
- **为何暂缓**：`state.ts` 此刻正被并发会话改动（工作区有未提交外来改动），本会话按 concurrent-sessions 纪律**不碰该文件**（pathspec 提交会连带其未提交改动，违「绝不提交他人在飞工作」）。属并发协作让路，非范围降级。
- **若做需改什么**：待 `state.ts` 并发改动落定后，把该注释指针更新为 `src/lib/anthropic/thinking-coercion.ts`。一行 doc-sync。发现方：typescript-reviewer NIT（2026-07-08）。

## 反应式学习记录 生命周期转换的遥测（negotiation lifecycle telemetry）

- **根因**：反应式学习记录（feature-negotiation 缓存）引入 TTL 生命周期后（spec `docs/spec/2026-07-08-negotiation-learning-lifecycle.md`），「自然重测环」在过期时静默丢弃 workaround、在下次上游 400 时静默重学，**无任何遥测**记录一次重测往返发生过；手动 expire / renew / pin 转换同样无信号。
- **当前行为**：生命周期转换纯静默；管理 UI 能看到当前状态与时间戳，但看不到「转换事件流」（何时过期、何时被重学、重测往返频率）。
- **理想架构**：按 richest-data-flow + telemetry-architecture，给 request-telemetry registry 加 `negotiation_lifecycle` 维度（转换类型 expired/re-learned/manual-expire/renew/pin + 分类 category + model），前端可选呈现重测频率、稳定性诊断。
- **为何暂缓**：与核心生命周期改动解耦，避免把跨切面遥测通道耦进本 spec 的数据模型 + API + UI 三块交付；属「决定数据模型后的后续项」。对抗审查 M3 提出（2026-07-08）。
- **若做需改什么**：接 request-telemetry registry（skill `telemetry-architecture`）加维度；在 `isEntryActive` 判过期→未施加的消费点、`markX` 再学点、四个 mutation 处发结构化转换事件。

## negotiation lifecycle 交付评审滚存的两处 sharp edge（2026-07-08）

来自 `feat/negotiation-lifecycle` 分支交付审计（code-reviewer + typescript-reviewer + react-reviewer）flag 的两处非阻塞待复访项：

- **flat-category 快照 `value` 是 endpoint 级 modelKey 而非裸模型**：`systemRejectModels` / `serverToolDowngrade` 分类的 `LearnedEntryView.value` 形如 `https://…|anthropic-messages|<model>`（endpoint 级 modelKey），非裸模型名。**当前行为**：前端 `ui-v4/src/lib/learned.ts` 的 `displayValue` 检测 `|anthropic-messages|` 标记并美化为裸模型名展示，功能完整；但后端快照的裸真值只能靠前端字符串切割还原。**若做**：后端 `viewOf` 给这两分类的 `LearnedEntryView.detail` 携带结构化裸模型名（`detail` 字段已存在），前端读 `detail` 而非切 `value`，更干净、少一处前端解析脆弱点。
- **`negotiation_learning.ttl_days` 整表替换语义易踩**：`config.ts` 把 `ttl_days` 整表替换进 `negotiationTtlOverridesMs`（whole-map replace，非 per-key merge），而默认覆盖含 `partnerFeatures: never`（`Number.POSITIVE_INFINITY`）。**当前行为**：用户设任一 `ttl_days`（如只想改 `toolFields`）而不重列 `partnerFeatures`，会把 `partnerFeatures` 从默认的 `never` 静默打回 `default_ttl_days`（30d）——即 partner-feature 学习记录开始 30d 后过期，非预期。DESIGN 活的架构现状 + 运行时选项表已注记此陷阱。**若做**：在 `config.yaml` / `config.example.yaml` 加一段带注释的 `negotiation_learning` 配置样例，显式演示「改单个分类须重列所有想保留的覆盖（含 `partnerFeatures: 0`=never）」，把陷阱前置到配置发现层。发现方：negotiation-lifecycle 交付审计（2026-07-08）。

## ui-v4 models-list-parity 落地的两个跟进项（2026-07-08）

来自 `docs/spec/2026-07-08-ui-v4-models-list-parity.md` 落地（分支 `feat/ui-v4-models-list-parity`）时的 not-adopted / deferred：

- **CSV 粒度 thinking 导出（not-adopted，待用户决策）**：Task 4 执行者曾把 CSV 的单 `thinking` 布尔列拆成 `adaptive_thinking` + `max_thinking_budget` 两列（信息更丰富）。**已回退**——Spec B 第 66 行明确冻结 CSV（保持与 Vue 17 列 parity），且该改动超出 Task 4 范围、未测新列形状、静默偏离 parity oracle。若用户想要更丰富的 CSV 导出，应作为**有意的独立增强**：改 spec 解冻 CSV + 加断言新 header set 的测试 + 明确接受偏离 Vue CSV parity。
- **billingRange re-clamp（Minor，spec 已声明推迟）**：Spec §2.2 提到对齐 Vue 的 watch-based re-clamp 但显式推迟到「plan 阶段」，落地只硬写了 null-init + 缺失当 0（均已兑现）。当前实务无害：目录来自稳定 react-query fetch、`billingBounds` 不会会话中途变化。若未来某次 refetch 缩小了边界而用户已选窄 `billingRange`，Radix thumb 视觉 clamp 但存储态会留越界值（仍正确过滤、可能显示为 active 但无可见效果）。若做：`ModelsPage.tsx` 的 `billingBounds` memo 处加一个 re-clamp `useEffect`。

## 并发会话预存问题（非本特性引入，2026-07-08 观察）

- **`EntrySummary.responsePreviewText` ui-v4-local tsc 错误（4 处）**：history/requests 测试 fixture（AgentLane / RequestRow / activity-row / useHistoryInfinite）在分支基点 `62ddf224`（另一会话的 `response_preview_text` 落地）已存在 ui-v4-local `tsc` 报错；根 `bun run typecheck` 与 `build:ui-v4` 均绿未捕获。非 models-list-parity 引入，属另一会话领域，未擅自修（concurrent-sessions 边界）。**提示拥有该改动的会话补 fixture 的 `responsePreviewText` 字段**（合并 master `c22aa269` 后该会话的后续 commit 可能已修，合并后须重验）。

## response_preview_text 深度 FTS `/api/search` 索引（现仅列表快筛 OR）

- **根因**：response-content-preview（spec `docs/spec/2026-07-08-response-content-preview.md` §6.2）落地时，`response_preview_text` 只接进 `read.ts` 的 `applyWhere` 列表快筛（`preview_text LIKE ? OR response_preview_text LIKE ?`），**未**进内容寻址 `search_index`（深度全文 `/history/api/search` 的 5 源 inbound/rewrites-req/rewrites-resp/req-headers/resp-headers）。spec §6.2 已显式裁决「只做列表内联快筛、不进 search_index」。
- **当前行为**：列表 `?search=` 能匹配到响应预览子串（快筛，对称请求侧 preview_text）；但专门搜索页 `/history/api/search` 无「响应内容」这一源，无法按响应内容做内容寻址去重搜索 + `contains?hash=` 反查。功能完整、仅深度搜索维度缺一源。
- **理想架构**：给 search_index 加第 6 源「response」（`req_aux` flat 文本或独立映射），backfill 一并建、`GET /history/api/search?source=response` 可选。
- **为何暂缓**：spec §6.2 已显式只做快筛（against 过度设计——响应预览是短摘要、列表 LIKE 已够用，深度 FTS 价值未证）；加源牵动 search_index schema + backfill + API + 前端源选择器，属独立搜索特性工作单元，非本 spec 范围。
- **若做需改什么**：① search_index 加 response 源（`req_aux` 或新表）；② `search-index-backfill.ts` 建该源（须 bump `search_index_version` 重建全索引，代价见 DESIGN 活的架构现状）；③ `/history/api/search` 加 `source=response` 分支 + `partial+builtPct`；④ 前端源单选器加项。发现方：response-content-preview spec §6.2 裁决（2026-07-08）。

## response-preview backfill 靶向 stage 解压（现照 search-index 全解 assembleFullEntry）

- **根因**：`response-preview-backfill.ts`（spec §6.3）实现时照 `search-index-backfill` 先例，per-row `assembleFullEntry(row, allStages)` 全解多腿（含 sse_events）再 `extractResponsePreviewText`；spec §6.3 曾提「靶向只解压 `upstream_response`（取 body）+ `client_response`（取 forwarded sseEvents）两 stage」作为优化，落地时降级为全解以避手工 stage 解码 + 旧行 legacy 适配的复杂度（plan Task 5 注记）。
- **当前行为**：回填正确但每行全量解压所有 stage blob；`extractResponsePreviewText` 只需 upstream_response.body + client_response.sseEvents 两 stage，其余（inbound_request/outbound_request/per-attempt 等）解压后即弃。大库回填 CPU/IO 有浪费（参照 `methodology-derived-column-backfill-targeted-and-nonblocking`：4.2G 库 `SELECT *` 曾卡 3m53s）。
- **理想架构**：靶向 `SELECT ... FROM entry_stages WHERE entry_id=? AND stage IN ('upstream_response','client_response')` 只解这两 stage，跳过 `assembleFullEntry` 全解，配等价性 oracle（靶向 vs 全解结果逐字节一致）。
- **为何暂缓**：正确性已达（全解是超集）；非阻塞后台 + `IS NULL` 谓词跳已建，实际回填一次性；靶向解压需手写 stage 提取 + 兼顾旧库 legacy 单 blob 形态，属性能优化工作单元，价值待大库实测确认。属「独立工作项」非「因范围大降级」。
- **若做需改什么**：① 抽只解 upstream_response/client_response 两 stage 的靶向解码 helper（兼容 legacy 单 blob 行）；② `processBatch` 改调它代替 `assembleFullEntry`；③ 等价性单测（同一行靶向 vs 全解 → 同一 `response_preview_text`）。发现方：response-content-preview spec §6.3 降级 + plan Task 5 注记（2026-07-08）。

## Responses/Gemini 详情页 Response tab 交错 text/tool wire 顺序保真（现恒 text-先-tools）

- **根因**：`accumulate-response.ts` 的 `accumulateResponses` / `accumulateGemini`（本次新补的 tool_use 抽取）组装 `MessageContent` 时恒把 text 块放最前、tools 块追加其后（`content.push({type:"text"}); for(tools) content.push({type:"tool_use"})`），**不保留**上游 wire 里 text 与 tool 的真实交错顺序。Anthropic（`accumulateAnthropic` 按 index 定位）与 CC（`accumulateOpenAICC` 按 tool_calls 数组）无此问题。
- **当前行为**：**净新增能力、非回归**——这两端点流式工具此前在详情页 Response tab 根本不显示（既有盲区），本次补抽取后可见，只是多工具与文本交错时顺序被规整为 text-先-tools。响应预览列摘要（工具优先 `[A,B] text`）本就工具先、不受影响；仅详情页 Response tab 的块渲染顺序与真实 wire 可能不同。
- **理想架构**：`accumulateResponses` 按 `output_index` / `accumulateGemini` 按 part 出现序把 text 与 tool_use 块**按真实交错序**入 `content[]`（类似 `accumulateAnthropic` 的 index 定位），保 wire 顺序保真。
- **为何暂缓**：本次目标是「让这两端点流式工具在预览列 + 详情页可见」（此前完全不可见），已达；交错顺序保真是保真度增量、对预览列零影响、对详情页仅影响多工具+文本混排的罕见块序；且需给两累加器加序号定位逻辑。属「保真度优化独立工作项」非「因范围大降级」。
- **若做需改什么**：① `accumulateResponses` 用 `Map<outputIndex, block>` 保 text/tool 混合序（text delta 也按 output_index 归位）→ 按 index 排序出 content；② `accumulateGemini` 按 parts 遍历序交替 push text/tool_use（不再分离两桶）；③ 交错序单测（text→tool→text → 三块保序）。发现方：response-content-preview spec §4 H1 扩展的保真度残余（2026-07-08）。

## LiveDock 在途浮窗:per-group 折叠(现整面板一档折叠)

- **根因**：`LiveDock` 展开面板按 resolved model 分组渲染,但整个面板只有一档「折叠/展开」(`livedock.expanded`),组头(`LiveGroup` `showHeader`)不可单独折叠。spec §2 已显式把 per-group 折叠列为推迟项。
- **当前行为**：展开时所有组全部铺开;在途请求数少时(典型 1-数条)无碍,组数多、单组行数多时面板变长需内滚。
- **理想架构**:`LiveGroup` 加 per-group 折叠态(组头点击折叠该组明细),折叠态持久化(如 `livedock.collapsedGroups`)。
- **为何暂缓**:小 N 价值低(spec §6 已加 `groups.length>1` 才显组头 + N=1 扁平退化);属体验增量,非阻塞。
- **若做需改什么**:① `LiveGroup` 加 `collapsed` prop + 组头 toggle;② `LiveDock` 维护 per-group 折叠 Set + localStorage;③ 折叠态单测。发现方:live-inflight-dock spec §2(2026-07-08)。

## LiveDock:请求终态淡出动画(现瞬时移除)

- **根因**:`applyActiveEvent` 对 completed/failed/aborted 直接从 `byId` 删除(`live-store.ts`),UI 行随即消失,无过渡。spec §2 列为推迟项。
- **当前行为**:高频完成时行会突兀消失/面板重排(final review I-1 邻域观察),功能正确仅体验略生硬。
- **理想架构**:终态行标记 `settling` 保留短暂(如 300ms)播放淡出后再移除,或用 CSS transition + React 退场(如 framer-motion / 手写 timeout)。
- **为何暂缓**:纯体验项;引入退场态会让 reducer/渲染复杂化(需区分「活跃」与「正在退场」),价值未证。
- **若做需改什么**:① reducer 终态转 `settling` 而非删除 + 延时清理(注意 never-throw/drain);② `LiveDetailRow` 退场动画;③ 时序单测(fake timers)。发现方:live-inflight-dock spec §2 + final review(2026-07-08)。

## LiveDock:面板内直接 abort 在途请求(现仅跳详情页)

- **根因**:`LiveDetailRow` 点击 `onSelect(id)` → `navigate(/requests/:id)`,abort 操作留在详情页;面板内无 abort 钮。spec §2 列为推迟项。
- **当前行为**:要中止在途请求须先进详情页;面板是只读监视器。
- **理想架构**:明细行加 abort 按钮 → 调用现有 abort 端点(详情页所用同一 API),乐观从 `byId` 移除或等 `aborted` 事件。
- **为何暂缓**:超出「把在途信息可视化」的本次范围;abort 是写操作,需确认交互 + 错误处理,属独立功能单元。
- **若做需改什么**:① 明细行 abort 钮 + 确认;② 复用详情页 abort API 调用;③ 乐观更新 / 依赖 `aborted` WS 事件回收;④ 交互单测。发现方:live-inflight-dock spec §2(2026-07-08)。

## LiveDock:展开态键盘焦点行被叠加层遮挡时自动滚入(现仅 Escape 缓解)

- **根因**:展开面板 `absolute bottom-6 max-h-[55%]` 叠加在 History 底部;若 HistoryList 键盘 roving 焦点行(`HistoryList.tsx` ArrowDown `align:"end"`)滚到被面板遮住的区域,会「有 DOM 焦点但视觉不可见」。Virtuoso 对 overlay 无感知。spec §2/§6 列为已知限制。
- **当前行为**:焦点可能落在面板背后;本次以 Escape 收面板缓解,不自动滚入。
- **理想架构**:展开态下把 History 可视区下界收缩到面板顶(paddingBottom 或 scrollIntoView 计算避让),使焦点行始终滚入未遮区。
- **为何暂缓**:边缘可访问性场景;需让 History 感知 overlay 高度(跨组件耦合),价值/频次低。
- **若做需改什么**:① LiveDock 暴露展开高度;② HistoryList 据此调 Virtuoso 视口/scrollToIndex 避让;③ 焦点可见性核验(浏览器)。发现方:live-inflight-dock spec §2/§6 + final review(2026-07-08)。

## ui-v4 raw-json-dual-view 落地的 minor 跟进项（2026-07-08）

来自 `docs/spec/2026-07-08-ui-v4-raw-json-dual-view.md` 落地（分支 `feat/ui-v4-raw-json-dual-view`）的 review minor（均非阻塞，已 landed）：

- **JsonTreeView copy-path 对含 `.`/空格的 object key 非 round-trip**：`{"a.b":1}` 的 copy-path 产出 `$.a.b`（看似嵌套）。copy-path 是便利功能非正确性契约、内部工具可接受。若做：对不匹配 identifier 正则的 key 用 bracket-quote（`$["a.b"]`）。
- **RawJsonView 可选 `label` 位于 `role="tablist"` 内**：WAI-ARIA tablist 直接子元素应仅为 `role="tab"`。若做：把 label `<span>` 移出 tablist 容器。另：完整 tabs 键盘方向键导航 + roving tabIndex 未实现（原生 `<button>` 可点击可聚焦，功能可用）。
- **ResponseSegment ForwardedBody `content` 静态类型 `unknown`**：当前经 producer 契约（`ForwardedResponse.content` = 端点响应对象）保证是结构化 JSON、喂 RawJsonView 安全；与迁移前 `JSON.stringify(content)` 行为一致。若未来某端点转发裸字符串非流式 body，tree 视图会显单个带引号 primitive。若做：加 `typeof content === "object" ? RawJsonView : RawPre` 守卫与其它站点对称。

## `disabled_models` 实际只在 Anthropic 路径拦截，CC/Gemini/Responses 放行（可用性语义不一致）

- **现状（2026-07-08 对抗审查实测，spec `docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md` HIGH-1）**：`config.disabled_models` 经 `applyDisabledFilter`（**2026-07-28 起在 `src/lib/models/cache.ts`**，原 `src/lib/state.ts:996`）把模型从 `state.models`/`state.modelIndex` 滤除，其**自述职责是「从列表隐藏 / 压制废弃项」**（原 `state.ts:461-468` 注释，现 `packages/foundation/src/state.ts`），**不是全局可用性拦截**。实测请求路径：
  - **Anthropic `/v1/messages`**：`supportsDirectAnthropicApi(id)`（[features.ts:38](../../src/lib/anthropic/features.ts#L38)）→ `modelIndex.get` 返 undefined → vendor≠Anthropic → **reject 400**。此路径拦截成立。
  - **OpenAI CC / Gemini / Responses**：`isEndpointSupported(undefined, …)`（[endpoint.ts:47](../../src/lib/models/endpoint.ts#L47)）对不在 index 的模型**返回 true**（legacy fallback）→ passthrough → 用禁用模型准确 id **直发上游、能成功使用**（三 codec：[openai-cc/codec.ts:354](../../src/lib/codec/openai-cc/codec.ts)、[openai-gemini/codec.ts:158](../../src/lib/codec/openai-gemini/codec.ts)、[openai-responses/codec.ts:381](../../src/lib/codec/openai-responses/codec.ts)）。
- **为何记录**：模型抽屉可见性 spec 把 config-disabled 模型暴露到 UI 可见 + 可深链复制 id；结合上述，用户从抽屉拿到禁用 id 即可经 CC/Gemini/Responses 使用。对**内部个人工具**（internal-tool-security-posture ADR：全量暴露、运维价值 > 假想泄露）这本身不是缺陷；但「disabled 在 4 条路径里 3 条不 disable」是**语义不一致**，值得用户决定是否统一。
- **若做（把 disabled 变成真正的可用性拦截）**：在三条 OpenAI 系 codec 的 route 决策里，对「解析出的 name 命中 disabledSet」显式 reject（而非依赖 `modelIndex.get` + permissive `isEndpointSupported(undefined)`）；或收紧 `isEndpointSupported(undefined)` 的 permissive 默认（风险：会连带影响真正的 legacy 未知模型 passthrough）。需一组四路径的拒绝/放行回归测试。发现方：spec 对抗审查 subagent（2026-07-08）。

## ui-v4 模型详情抽屉移动端/窄屏响应式

- **现状**：模型详情模态抽屉（spec `docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md`）默认 60vw、min 320px；窄屏（< ~640px）下 320px 抽屉 + 遮罩仍会挤压，未做「窄屏全宽」响应式。
- **暂缓原因**：用户明确「移动端响应式未来用户要求了再做」（2026-07-08）。本项目主要是桌面端内部工具。
- **若做**：抽屉 `Dialog.Content` 宽度加断点——`< sm` 时 `w-full`（占满、min 让位）、`>= sm` 时用 resizable 60vw；或用 CSS `min(60vw, 100vw)` 之类。属独立 UX 增强。

## ~~retreated（OOM cap）+ empty_text 锚点 → index 碰撞 + 双 message_start~~（已修复 2026-07-11，block-level-buffered-retry P1 Task 7）

> **已关闭**：默认 `on` 翻转（spec `2026-07-11-block-level-buffered-retry` §6.3）把此罕见残留放大，故本 spec P1 一并修复（不再「罕见不修」）。修法即下方「理想架构」：retreat 分支复用 `flushBufferedFrames`（一次性 anchor close-off `stop@0` → H1 message_start dedup → +1 remap），后续 live-write 帧统一施加同一 remap + dedup（`driver.ts:639-648` 的 retreat live 分支 + `:655-680` 的 retreat flush）。retreat flush 用 `suspendHeartbeat`/`resumeHeartbeat`（可恢复）而非终末 permanent freeze——retreat 后仍有 live 流、须保活。M1 post-retreat close-off 经共享 `anchorClosed` 幂等（retreat flush 已关则短路，无双 `stop@0`）。测试 `tests/pipeline/retreat-anchor-collision.test.ts`（retreated-complete + retreated-stream-error + no-anchor 中性三例；注入 bug 证 FAIL：raw flush → 双 message_start + @0 碰撞、live-write raw → 块跨 @0/@1 撕裂）。


- **根因**：`runResponseBufferedSink` 的 retreat 路径（buffer 超 `protectStreamingBufferCapBytes` 默认 16MiB → 放弃缓冲、转 live 写透，driver.ts:601-620）**不做 +1 index remap、不 dedup message_start**——这两个变换只在 commit 成功分支（Task 3.3）做。但 empty_text 锚点（Task 3.2/3.3）一旦经心跳注入，就占了客户端 index 0 且已转发一次 message_start。
- **当前行为**：若「先 idle-stall >20s 触发锚点注入 → 之后上游爆发 >16MB 触发 retreat」这一罕见复合条件命中，retreat 的 flush + live write-through 会：① 真实 `content_block_start@0` 与锚点 @0 **index 碰撞**；② buffer 里已转发的 message_start **被重发**（双 message_start）。两者皆客户端可见协议违规。retreated-complete 与 retreated-stream-error 两子路径都有。Task 3.4 的 `closeAnchorIfOpen` 只补一个 stop@0、无法挽回已 live 发出的真实帧。
- **理想架构**：retreat 路径在 `anchorState.injected` 时对 retreat-flush 帧与后续 live-write 帧统一施加 `anchor.remap(frame, 1)` + `messageStartForwarded && isMessageStart → skip`（镜像 commit 分支 driver.ts:662-668 的变换）。
- **为何暂缓（2026-07-09：罕见残留、不修）**：retreat 触发需 `bufferedBytes > 16MiB`（driver.ts:622 计 `frame.data.length + frame.event.length`），上游对 Anthropic 路径硬上限 `max_output_tokens: 64000` + `max_thinking_budget: 32000`（.claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json），典型响应帧字节远低于 16MiB。**但不可达估算不硬**（plan review N4）：细粒度小 delta 的逐帧 framing 开销 + thinking signature 可把帧字节推高，pathological 下逼近 16MiB 非绝无可能。故定位为**罕见残留协议违规**（非「证明不可达」），叠加「先注锚点」后更罕见——用户 2026-07-09 明确不做。keepalive-timeout-safety 特性的 live 对账 gate 在 `buffered===false`、结构上够不到 retreat（在 buffered 内），故不会误碰。若未来实测确证可达需修：改 driver retreat 分支复用 commit 分支 remap+dedup 读共享 anchorState。锚点特性主路径（commit + 终末失败）正确性已实证。
- **若做需改什么**：`src/lib/pipeline/driver.ts` 的 retreat 分支（:601-620 附近）——注入锚点时对 live 路径帧施加与 commit flush 同一的 remap+1 + message_start dedup；补一条 retreated+anchor 的单元测试（buffer 超 cap + 锚点已注入 → 断言真实块 @1 无碰撞、message_start 恰 1 次）。执行期发现（Task 3.4，2026-07-08）。

## 上游 h2 PING 保活的 unacked-ping 死连接快速 teardown（liveness 探测）

- **背景（2026-07-09 落地）**：为对抗「GHC 长思考静默期连接被空闲回收、上游流无 `message_stop` 截断」，加了上游 HTTP/2 PING 周期保活（`timeouts.upstream_h2_ping` 默认 15s，`transport/http2-client.ts:scheduleH2KeepalivePing`）。v1 是**纯保活**：`session.ping()` 的 ack 回调忽略（`NOOP_PING_ACK`）。
- **现状**：连接真死时，靠 node:http2 session 的 `error`/`close`/`goaway` 事件落 `drop`（清 timer + 移出池）+ 让在途请求失败——但这依赖底层 socket/session 自己察觉死亡（可能拖到它自己的 idle timeout 才 emit）。PING 的 ack **没被用来主动判活**。
- **理想架构**：记录每次 PING 的发出时刻，若连续 N 个 PING 在 `ackTimeoutMs`（如 2×interval）内无 ack，判定连接已死 → 主动 `session.destroy()`，把「静默挂死」转成**及时的可重试错误**（配合 L2 缓冲重试快速换新连接）。这是把 PING 从「保活」升级为「保活 + liveness 探测」。
- **为何暂缓**：本次修复目标是**阻止**空闲回收（放真帧上 wire），已由纯保活达成；unacked-ping 的死连接快速 teardown 是**正交的另一个关注点**（加速失败恢复，非阻止截断），且引入「慢但活的连接被误判 teardown」的假阳性风险，需实测标定 `ackTimeoutMs`。against-yagni 的反面不适用——它不是本 bug 的必需件，是独立增强。
- **若做需改什么**：`scheduleH2KeepalivePing` 的 ack 回调改为记 in-flight ping 计数/时刻 + 一个 `ackTimeoutMs` 守卫（连续无 ack → `session.destroy(new Error("h2 keepalive ping unacked — dead connection"))`）；加 config 旋钮 `timeouts.upstream_h2_ping_ack_timeout`；夹具用 Node http2 server（Bun server 的 ping ack 行为不忠实，见 skill `debugging-ghc-api-upstream-transport`）跑一个「server 停 ack → 客户端在 timeout 内 destroy」的集成测试。发现方：本特性落地设计取舍（2026-07-09）。

## 上游主动发帧手段盘点（END_STREAM 后无流级保活杠杆）+ h2 PING 运行时可观测性

- **背景（2026-07-10 排查 `req_1783704300404_484` 引出）**：一条 anthropic-messages 请求上游静默 ~169s 后爆发部分 `tool_use` 即被截断（无 `message_stop`），追问「h2 PING 有没有生效 / 有没有记录 / 还有什么主动发帧手段」。前两问结论：PING 按默认配置启用（`upstream_h2_ping: 15`），但运行时对 ping 的发送/ack **零可观测**（`NOOP_PING_ACK` 丢弃 ack，无 log/计数/telemetry；history record 是 single-request 视角、结构上不含 connection-level 的 ping 痕迹）。可观测性修法已并入上一条「unacked-ping teardown」的「记录每次 PING 发出时刻」——**不重复**，那条落地时顺带补 per-session `sent/acked` 计数即可让「ping 生效吗」可从 telemetry 回答。
- **现状（实测枚举，2026-07-10 node v24 探针）**：我方请求流是 `req.write(body); req.end()`（`http2-client.ts:489-490`），`req.end()` 后 `writableEnded=true`（END_STREAM 已发、写端半关闭）。此后客户端**仍能主动上 wire 的帧**只有：

  | 帧 / API | 作用域 | 能否刷新单条流的应用层 idle | 备注 |
  |---|---|---|---|
  | `session.ping(payload, cb)` PING | 连接级 | ✗（连接级） | 已用；唯一带 ack 回调可测 RTT/liveness |
  | `session.settings()` SETTINGS | 连接级 | ✗ | 非保活语义 |
  | `session.setLocalWindowSize()` → WINDOW_UPDATE | 连接级 | ✗ | 流级 WINDOW_UPDATE 仅在有 DATA 可 ack 时随消费自动发；静默期无帧可发 |
  | `req.priority()` PRIORITY | **流级** | ✗（多数服务端忽略） | RFC 9113 已废弃 stream priority，唯一 references 本流的客户端帧、但收益存疑 |
  | `req.sendTrailers()` | 流级 | — | 仅 END_STREAM **前**有效，`req.end()` 后已太晚 |

- **结论（承重）**：HTTP/2 协议**不提供半关闭流的流级 keepalive**——所有可主动发的帧要么连接级（刷新的是整条 h2 连接的 idle，防中间盒/连接回收，已由 PING 覆盖），要么是已废弃/被忽略的 PRIORITY。故若掐断方是 **GHC 对单条 stream 的应用层超时**，我方**没有任何新的主动发帧杠杆**能阻止它（case B）；预防层到 PING 为止，恢复层只能靠 **L2 缓冲重试**（`protect_streaming_generation`，默认 OFF）。WebSocket 路径同构：`client.ping()`（Bun-only）也是连接/预防级、不重置帧-idle guard，PoC 已判不落地（见下方 R5.1 条）。
- **为何暂缓**：这是一次**盘点/定性**而非缺陷——现有 PING 预防层 + buffered-retry 恢复层已是协议允许范围内的完整应对，不存在「漏掉的主动手段」可补。记录它是为了封存「能不能给单条流保活」这个反复会被重新提起的问题（答案：协议层面不能），避免后续 speculative 地去实现 PRIORITY-poke 之类无收益改动。
- **若做需改什么**：无需实现主动发帧新杠杆。唯一有收益的动作是把 PING 从 fire-and-forget 升级为**观测 + 判活**——完全落在上一条 unacked-ping teardown 的范围内（那条的 ack 记账即同时补齐本条的可观测性）。若未来实测发现 GHC 对连接级 PING 有响应式续期收益，可再评估缩短 `upstream_h2_ping`；PRIORITY-poke 明确**不做**（废弃帧、收益存疑）。发现方：`req_484` 截断排查（2026-07-10）。

## POST-COMMIT 失败的 error 帧 + 锚点收口帧不进 history clientResponse.sseEvents

> ✅/⚠️ **前提部分失效 + 缩减修复（2026-07-20，landed `301e63b2`，spec/plan 2026-07-20 §Unit 1）**：本条「error 帧 + stop@0 不进 history clientResponse.sseEvents」在 **History V3**（landed 2026-07-18）下**已为假**——durable projection（`v3/projection.ts:383` clientTrack via generation recorder）在 `ctx.fail` 后仍捕获 writeSynthetic 帧（seal 延迟）。`getHistory` 已完整。**残留仅瞬态快照**（`request.failed` 事件的 `entry` 来自 `toHistoryEntry` 读 `_forwardedResponse`，catch 顶部只快照 pings）——缩减版重排 `writeTerminalThenSettle`（closeAnchor→writeSynthetic→setForwarded→fail + finally 兜底）已治，wire 不变。**未做（缩减 scope）**：write-reject 专项测试、4-腿-split 断言。**未治**：reaper-cancel 腿（见下方新条目「reaper-cancel history 两阶段协议」）。下文旧描述为 History-V2 时期历史记录。

- **现状（2026-07-09 Phase 5 审查实证）**：delayed-commit 的 catch 块在 `setForwardedResponse({sseEvents:[...forwardedSseEvents]})` 快照**之后**才写 error 帧（`writeSynthetic`）——`git show` 父提交确认这是**既有** pattern（error 帧本就在快照后写、早已不进 history 轨）。这违反 `client-sink.ts:24-29` 明文契约（handler 应按 `writeSynthetic → recordForwarded → settle` 顺序，即先写 error 帧再快照）。
- **本特性拓宽**：keepalive timeout-safety 的 Phase 5 终末收口新增的 `content_block_stop@0`（`closeAnchorIfOpen`→`writeAnchor`）同样落在快照之后 → 不进 `clientResponse.sseEvents`。wire 协议完整（客户端真收到收口帧 + error 帧、无残留 open 块，已测），仅 **history 轨**这一正交维度不完整。
- **理想架构（richest-data-flow）**：catch 块重排为 `closeAnchorIfOpen → writeSynthetic(errorFrame) → setForwardedResponse(snapshot) → ctx.fail`——与 client-sink 已文档化契约一致，一并闭合既有 error-帧缺口 + 新 stop@0。四个 POST-COMMIT 失败分支（reaper/timeout、HTTPError、unknown、reject）统一。
- **为何暂缓**：正确修法触及 4 个分支的既有 settle-ordering（`ctx.fail` 同步冻结 `clientResponse`，重排须守 persistence-async-invariants），与 keepalive 保活特性正交、宜合并成聚焦跟进（与本 backlog 同族的 settle-ordering 项一并处理）；本特性的 wire 协议完整性不受影响。发现方：Phase 5 交付审查 subagent（2026-07-09）。
- **若做需改什么**：`src/routes/messages/handler-v4.ts` delayed-commit catch 块四分支重排 close→writeSynthetic→setForwardedResponse→fail；补一条断言「注锚点后 POST-COMMIT 失败 → history `clientResponse.sseEvents` 含 error 帧 + stop@0」的测试（现测试断言在 wire `res.text()`，须加 history 轨断言）。参 skill `persistence-async-invariants`。

## 上游 WebSocket 应用层保活（Bun-only ping / TCP keepalive）—— PoC 判不落地（R5.1）

- **PoC 结论（2026-07-09，`exp/ws-upstream-keepalive/`）**：`import { WebSocket } from "undici"` 解析到的实现**取决于运行时**——**Bun**（`dev`/`start` 主运行时）恒等于原生 `globalThis.WebSocket`，带 `ping()`/`pong()`/`terminate()`，实测 `client.ping()` 能把真 WS PING 控制帧发上 loopback wire；**Node**（发布 npm CLI `dist/main.mjs`）是真 undici 7.28.0 WHATWG 实现，**无 `ping()`**、无 socket 访问器。故计划原假设“undici WS 无 ping()”只对 Node 成立。
- **现状（当前行为）**：`upstream-ws-connection.ts` 不做任何上游 WS 应用层保活。h2 路径有双层（`socket.setKeepAlive` + `scheduleH2KeepalivePing`），WS 路径**零保活层**。`ss -tnope` 实测：Bun 客户端 WS 的 upgrade socket 默认**不带** `timer:(keepalive,...)`（h2 socket 有）。
- **根因**：WHATWG WebSocket 面不暴露底层 socket，无法 `socket.setKeepAlive()`；且 Bun 的 `undici` shim 用原生实现、忽略 `WebSocketInit.dispatcher`，故 Node undici 那条“自定义 dispatcher 里设 keepalive”的理论路径在 Bun 上也不通。
- **为何暂缓（不落地 speculative code）**：即便 Bun 的 `.ping()` 可用，WS PING 是**控制帧**、不产生 `ResponsesStreamEvent`，**不重置** `state.streamIdleTimeout` 帧-idle guard（与 h2 PING 同构）——它至多是一层**预防**（防 middlebox/GHC edge 收割空闲连接），**不是恢复**、也不救 > 300s 合法静默。且（a）运行时不对称（Node CLI 无此能力，落地会造成两运行时行为分裂）、（b）真实 GHC 收益**未证**（不像 h2 PING 有过 112s 静默无 `message_stop` 的实测收割观测）。承重恢复防线是 **Phase 3 的 buffered 重试**（spec R5.1；对 WS ≥ 对 h2 关键，因 WS 无有效预防层）。
- **若做需改什么**：① 若要 Bun-only app-level WS ping —— 在 `createUpstreamWsConnection` 加一个 `typeof socket.ping === "function"` 守卫下的周期 `socket.ping()`（类比 `scheduleH2KeepalivePing`，`unref` timer、busy/OPEN 门控），config 键复用或新增 `timeouts.upstream_ws_ping`；**前置门控**：先对真实 GHC 上游做长静默保活对照实验证明确有收益（当前无观测数据），否则是无收益的运行时分裂。② 若未来换 WS 库（如 `ws` 包，暴露 `_socket` 可 `setKeepAlive` + 有 `ping()`）或 Node undici 开放 dispatcher-level keepalive 且 Bun 跟进 —— 可统一两运行时的 TCP keepalive。③ 无论哪条，都**不代偿** > 300s 的帧-idle guard（那需调大 `streamIdleTimeout`，见 R5.3）。发现方：Task 4.1 PoC（2026-07-09）。权威结论见 `exp/ws-upstream-keepalive/REPORT.md`。
- **前置门控实验已跑（2026-07-12，结论仍 NO）**：对真实 GHC 上游做了长静默有/无 ping 对照（`exp/ws-upstream-keepalive/probe-ghc-idle.mjs`，5 次真打 gpt-5.5 effort=high）。**gate 问题「GHC 服务端 WS idle 计时器是否被 client PING 重置」= INCONCLUSIVE**——正样本对照未成立：no-ping 臂（266/285/352s 静默）与 ping 臂（382/462s 静默）**全部正常完成**，GHC 在 ≤462s 内从未 idle-close（完成时 `1000 ""` 空 reason），故无法判断 PING 是否重置 GHC 计时器（探针 `response.created` 恒 0.4s 到达、全程 post-first-event、未进入生产那个 pre-first-event regime）。**但工程决策仍 NO（更强理由）**：ping 对 problem-B（我方帧-idle guard）确定无用（不产 `ResponsesStreamEvent`），对 problem-A（GHC pre-first-event idle-close）未证有用且有更确定修复（per-model 熔断 + 调大 timeout）。仅当未来复现 A 且实测证明 PING 能重置 GHC pre-first-event 计时器时才重评。权威原始日志 `exp/ws-upstream-keepalive/raw-poc-c-run-logs.txt` + REPORT.md「2026-07-12」小节。

## ~~R5.3 实测承重化：`streamIdleTimeout` 默认 300s 对 gpt-5.5 太短~~ 已落地（2026-07-12，per-model idle timeout 特性）

- **已实现**：per-model `stream_idle_overrides` / `response_header_overrides`（bundled `gpt-5.5:600`、per-key merge、`findMostSpecific`）+ 全读点/调用点 threading + history D2 诊断（`pipelineInfo.streamIdleTimeoutMs`）。权威看 spec `docs/spec/2026-07-12-per-model-idle-timeout.md`、ADR `docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`、DESIGN.md `streamIdleTimeoutOverrides` 行。commit d7883b05/b21b10ea/c72e6f31/e8112c82（+ handler 调用点随并发 commit 00f2a38a 落地）。
- **原设计的 undici 耦合前提被推翻**（BLOCKER）：GHC 走 node:http2（无传输 body-idle）、undici 只服务 SearXNG，故 per-model 是**纯 app-guard、不碰 undici**（详见 ADR）。
- **正交遗留 problem-A（GHC pre-first-event idle-close）仍未修**：生产 `close(1000,"idle timeout")` + `failed before first event` 经代码事实裁决为 GHC-originated（非我方 guard），5 次实验未复现（阈值可能 >462s）。由 **A（per-model WS 熔断）** 治理，计划见 `docs/plan/2026-07-12-per-model-ws-circuit-breaker.md`（待实施），非本条范围。


## ~~下游 Responses WS（`ws.ts`）未采用 buffered 重试（现仅 SSE 采用）~~（已修复，block-level-buffered-retry P4 Task 1-2）

> **已关闭**：P4 Task 1（2026-07-11，commit `2181737d`）把 `ws.ts` 的 `handleResponseCreateV4` 接进 `driver.runResponseBufferedSink`（**terminal-only** 选路——`commitBoundaries` 故意省略，见 ws.ts:373-388 的落地理由，纠正下方「理想架构」原设想的「同 opts」表述：WS 不复用 HTTP 的 block-level `commitBoundaries` 谓词，因为 `response.output_item.done` 在 WS 语境下不该提前关闭重试窗口）。P4 Task 2（本条目关闭时新增 `tests/responses/ws-buffered-close-timing.test.ts`）核实并锁定了「若做需改什么」①③④ 三点的时序不变量：③ WS 终态早停 `stopAfterFrame` 在 buffered 路径上结构性 MOOT（`runResponseBufferedSink` 从不读取该 opt，只有 `runResponseSink` 读——见 `driver.ts:490` 是唯一引用点）；`sendErrorAndClose`+1011 与 buffered commit/retreat 的时序天然对齐（1011 close 只在 `driver.await` 返回后才可达，重试期间结构上不可能触发提前 1011）；④ mid-stream WS drop 触发重试 + exhausted 两个回归场景均已锁定（成功重试不泄漏 1011/error 帧、耗尽后 1011 只在 buffer 落定后触发、丢弃的 attempt 内容一律不上线）。②（buffered 分支 heartbeat 强制注入对齐 SSE）**未在本条目范围内验证**——沿用 WS 既有的 `responsesKeepaliveFrame` 强制心跳（`resolveResponsesBufferedAndHeartbeat` 已被 Task 1 复用），P4 Task 3（`docs/plan/2026-07-11-block-level-buffered-retry/plan-4-responses-ws.md` Task 3 Step 1，R4 门）待核实其在 buffered 累积窗口内的行为，若发现缺口应另开条目而非重开本条。

- **根因**：Codex/Responses tier-1 硬化（spec `2026-07-09-codex-responses-tier1-hardening` R4-mid）只把下游 **SSE**（`routes/responses/handler-v4.ts`）接进 driver 的 opt-in `runResponseBufferedSink`（第二消费者）；下游 **WS-to-client**（`routes/responses/ws.ts:359`）仍恒走非缓冲 `runResponseSink`——WS 路径的 buffered 采用未纳入本特性范围（spec §6 Phase 3 列为 Phase 3 范围外）。
- **当前行为（已核实无害）**：下游 WS 路径 mid-stream 上游掉线→fail + 保留 partial + 截断 error 帧（live 语义，即今行为不变），**无 mid-stream 透明重试**。WS 已有下游保活（`responsesKeepaliveFrame`，ws.ts:305-315）+ 崩溃防护 + 上游关闭码修复，仅缺 buffered 重试这一层。功能完整、仅比 SSE 路径少一层可选恢复能力。
- **理想架构**：`handleResponseCreateV4`（ws.ts）比照 SSE handler 经 `resolveResponsesBufferedAndHeartbeat` 选路：`responsesBufferedRetry` on 时选 `runResponseBufferedSink`（同 opts：`sawMessageStop`/`sawUpstreamError`/`anchor:undefined`/caps）、off 走现 `runResponseSink`。注意 WS 的终态早停（`stopAfterFrame: isTerminal`）+ `sendErrorAndClose`+1011 错误路径与 buffered 的 commit/flush 时序需对齐。
- **为何暂缓**：SSE 是 Codex tier-1 主传输（根因记录 `transport: http`），WS-to-client 是次要路径；buffered 采用需核 WS 的 close-code/1011 错误路径与 buffered commit 时序交互（比 SSE 复杂），属独立工作单元；且 buffered 默认 OFF，缺省无差异。属「独立工作项」非「因范围大降级」。
- **若做需改什么**：① `ws.ts` `handleResponseCreateV4` 加 `resolveResponsesBufferedAndHeartbeat` 选路（复用 `buffered-config.ts`）；② buffered 分支的 `makeWsSink` heartbeat 强制注入对齐 SSE；③ 核 WS 终态早停 + `sendErrorAndClose`+1011 与 buffered commit/retreat 的时序；④ mid-stream WS drop（buffered）触发重试的回归测试。发现方：spec §6 Phase 3 范围界定 + Task 5.1 doc-sync（2026-07-09）。

## Responses buffered 无专属 caps（现复用 Anthropic `protectStreaming*`）

> **不关闭，当前行为已更新**：block-level-buffered-retry P0 已把旧 `protectStreaming*`（Anthropic 专属标量）抽成 vendor 中立的共享顶层 `buffered_retry.*` + per-vendor **覆盖 map**（`openai_responses.buffered_retry` / `chat_completions.buffered_retry` / `anthropic.buffered_retry`，接受 `{ enabled, max_retries, buffer_cap_bytes, heartbeat_sec }`，`resolveBufferedCaps(vendor)` 解析优先级：per-vendor 覆盖 > 共享 `buffered_retry.*` > 内置默认 3/16MiB/15s），Responses 现在读的是 `resolveBufferedCaps("responses")` 而非直接借用 Anthropic 命名空间。P2（本特性）在此基础上把 Responses HTTP 从整响应升级为块级提交（`commitBoundaries: isResponsesCommitBoundary`），但**未引入 Responses 专属的独立 cap 键**——`openai_responses.buffered_retry.{max_retries,buffer_cap_bytes,heartbeat_sec}` 是「覆盖共享默认」的 map 字段，不是 `state.ts` 里独立注册的标量键（下方「若做需改什么」①描述的 5-触点标量注册路线未走，走的是 P0 的 map-化路线）。故本条目的核心缺口——「按端点独立调参」——**已通过 P0 的覆盖 map 结构性解决**（用户现在就能设 `openai_responses.buffered_retry.max_retries` 覆盖 Anthropic 的默认值），仅命名认知负担部分（曾读 `protectStreaming*`）已随 P0 重命名一并消除。保留本条目未关闭是因为它记录的「若做需改什么」①提议的独立标量键路线未被采纳（P0 选了更通用的 map-化路线），留作历史记录 + 若未来需要比 map 覆盖更细粒度的东西（如每 vendor 独立 schema 文档字段）时的参考。
- **根因**：Responses buffered 重试（`responsesBufferedRetry`）的 `retryCap`/`bufferCapBytes`/强制 heartbeat 兜底**复用** Anthropic 的 `protectStreamingMaxRetries`（3）/`protectStreamingBufferCapBytes`（16MiB）/`protectStreamingHeartbeat`（`handler-v4.ts:379-380` + `buffered-config.ts`）。Responses 只有独立的**门控**键 `responsesBufferedRetry`（默认 OFF），无独立的 cap 键。spec R4.2 已注「caps 需 Responses 侧对等 config（对齐命名）」但落地时复用 Anthropic 键。**（历史记录，见上方注：P0 已把 caps 结构换成共享 `buffered_retry.*` + per-vendor 覆盖 map，Responses 不再直接借用 Anthropic 命名空间。）**
- **当前行为**：block-level-buffered-retry P0 落地后，两端点**不再共享同一份读取路径**——各自 `resolveBufferedCaps(vendor)` 独立解析，可分别用 `anthropic.buffered_retry.*` / `openai_responses.buffered_retry.*` 覆盖，未设时才 fallback 到共享 `buffered_retry.*` 顶层默认。P2 进一步把 Responses HTTP 提交粒度块级化（`isResponsesCommitBoundary`），caps 解析机制不变。功能完整、按端点独立调参已可行。
- **理想架构**：给 Responses 引入对等 cap 键（`openai_responses.buffered_retry_max_retries`/`buffered_retry_buffer_cap_bytes`/`buffered_retry_heartbeat`，或统一到一个跨端点 `streaming_buffered.*` section），`resolveResponsesBufferedAndHeartbeat` 读 Responses 键、fallback 到共享默认；Anthropic 保持 `protectStreaming*` 或一并迁到共享 section。**已通过等价但更通用的路线实现**（P0 的 `buffered_retry.*` 共享 + per-vendor 覆盖 map，见上方注），未采纳本段描述的「扁平标量键」具体形状（record-not-adopted：map-化比逐 vendor 扁平键更省 schema 触点、且天然支持任意 vendor 新增，P0 决策时选了这条）。
- **为何暂缓**：默认值对两端点均合理、buffered 默认 OFF，独立调参需求未证；引入 3 个新 config 键属 config-schema 扩展工作单元（5 触点注册 + 文档），价值待实证按端点调参需求。**此暂缓理由已部分过时**——P0 出于「三端点起步（Anthropic/Responses/CC）都需要覆盖能力」的更广需求，已经做了 map-化的通用方案，非本条目原先设想的「仅 Responses 一处标量键」小改动。
- **若做需改什么**：① `state.ts` 加 Responses 对等 cap 键（5 触点：类型/CONFIG_MANAGED_DEFAULTS/schema.strict/两处 assign，参照 `responsesBufferedRetry` 注册）——**未采纳此路线**，P0 走的是 `nullableBufferedRetry()` map schema + `bufferedRetryOverrides` per-vendor 覆盖表（`state.ts` 的 `setBufferedRetryOverride`），触点更少且对未来 vendor 免加键；② `buffered-config.ts` + `handler-v4.ts:379-380` 改读 Responses 键（fallback 共享默认）——**已完成**（`resolveBufferedCaps("responses")`）；③ `config.example.yaml` 补注释样例——**已完成（2026-07-14，P2/P3/P4 default-on 收尾）**：`config.example.yaml` 新增 `buffered_retry` 一节，示范共享 caps 覆盖 + per-vendor `enabled`/map 覆盖形状，并注明 Responses（HTTP+WS）/CC 默认已翻 `true`、Anthropic 单独一段说明其 `protect_streaming_generation` 默认 `false` 的 CLI-unsafe 阻断原因；④ DESIGN 运行时选项表 + 「活的架构现状」Codex/Responses 行更新——本轮（P2 Task 7）+ 2026-07-14 default-on 收尾均已做。发现方：spec R4.2 caps 命名注记 + Task 5.1 doc-sync（2026-07-09）。

## chat-completions + Gemini 下游 SSE 无 heartbeat（长静默 idle 风险，现仅 Anthropic/Responses 有保活）

> **部分解决（2026-07-13）**：**CC 已落地默认心跳**（block-level-buffered-retry P3，commit `c9f0cbf5`+`3baf6095`：`ccKeepaliveFrame()` empty-delta chunk 经 `makeSseSink` heartbeat 注入、`synthetic:"keepalive"` 标记、buffered 强制 + live 路径 `streamKeepalivePingSec>0` 默认 20 也发）。**仅 Gemini 未做**——本条实际降为「Gemini 下游 SSE 无 heartbeat」。下方根因/架构的 CC 部分已作古，保留供 Gemini 参照同构解法。

- **根因**：下游客户端保活（forward-idle heartbeat）目前只接在 Anthropic（`stream_keepalive_*` / delayed-commit）+ Responses（`responsesKeepaliveFrame`，本特性 Task 2.1）两条 SSE 路径。~~**chat-completions**（`routes/chat-completions/handler-v4.ts:327-329`）~~（**已解决**，见上）+ **Gemini**（`routes/gemini/handler-v4.ts:271` "Gemini has no `[DONE]` / no heartbeat"）的 `makeSseSink` 都**不传 heartbeat**，故长上游静默期不注入保活帧。
- **当前行为（已核实无害）**：CC/Gemini 客户端若有 ~300s-idle 超时（如某些 SDK 默认），遇到长 reasoning 静默的上游会 idle 断连（与 Responses 修复前同类问题）。当前无已知 CC/Gemini 消费者命中此边界（多数 CC/Gemini 客户端 idle 容忍更宽或有自己的 keepalive），故实际零触发；但架构上是 Responses 已修、CC/Gemini 未修的**不对称缺口**。
- **理想架构**：同 Responses——给 CC/Gemini 各定一个格式专属保活帧（CC：`data: {"choices":[{"delta":{}}]}` 或注释帧核定客户端容忍；Gemini：data-only 空 candidates 帧或核定容忍），经 `makeSseSink` 的 heartbeat hook 按 `streamKeepalivePingSec` 注入 + `synthetic:"keepalive"` 标记，帧型以各自 SDK 容忍契约为 oracle（比照 Responses 的 `refs/codex` + openai-node/python 三重容忍核验）。
- **为何暂缓**：无已知命中此 idle 边界的 CC/Gemini 消费者（价值未证）；每格式的保活帧型需独立核定客户端容忍契约（不能盲抄 Responses 的 `response.ping`）——属独立工作单元，同类修复模式（`learn-by-analogy`）但需各自 oracle。若将来某 ~300s-idle 消费者命中 CC/Gemini 即优先做。发现方：Task 2.1 keepalive 落地（2026-07-08，spec §3 R3 边界）。
- **若做需改什么**：① CC：定 CC 保活帧（核定 openai-node/兼容 SDK 对空 delta 帧容忍）+ `handler-v4.ts` 的 `makeSseSink` 接 heartbeat；② Gemini：定 Gemini 保活帧（核定 `@google/generative-ai` SDK 容忍）+ 同接；③ 各配容忍契约 oracle 测试 + 长静默注入回归；④ DESIGN「活的架构现状」Codex/Responses 行的「CC/Gemini 仍无 heartbeat」注记同步更新。

## ~~protect_streaming 遥测无端点归因（Anthropic + Responses 共享全局计数器）~~ 已关闭

> **已关闭（2026-07-14，P2/P3/P4 default-on 收尾）**：block-level-buffered-retry P0（`protect-streaming-stats.ts`）已把下方「理想架构」的 `format`/`endpoint` 维度落地为 `Record<string, ProtectStreamingStats>`（`byVendor`），`recordProtectStreamingOutcome(outcome, retries, { vendor })` 接受 vendor 参数；P2/P3/P4 三端点各自 `telemetryVendor: "responses"` / `"chat_completions"` / `"responses_ws"` 接线完毕（`src/routes/{responses,chat-completions}/handler-v4.ts`、`src/routes/responses/ws.ts`），`/api/status.protect_streaming.by_vendor` 已能按端点分列，**且 P2/P3/P4 三者默认已翻转 ON**（`CONFIG_MANAGED_DEFAULTS`，2026-07-14；该文件 2026-07-28 迁至 `packages/foundation/src/state-defaults.ts`）——vendor 归因 + default-on 两个前置条件均已满足。**Anthropic 侧**（`messages/handler-v4.ts:1145`）也已传 `telemetryVendor: "anthropic"`（P0 落地时一并接好，为 P1 块级机制铺路）——vendor 维度本身对 Anthropic 已就位，且 **P1 的 `commitBoundaries` 接线已 landed**（756387cf 起 handler-v4.ts:1134 buffered 分支传 `commitBoundaries: anthropicCommitBoundaries`，`partial-degrade` 对 Anthropic 已可达）。**P1 默认仍 OFF**——非 vendor-归因/default-on 维度的问题，而是真实 Claude Code CLI 门测（`tests/e2e-client/anthropic-coexist-cli.e2e.test.ts`）实测块级 anchor-coexist 形状导致 CLI 静默丢内容，须先做形状修复（见本文件另条 P1 专属 backlog）才能翻转；P1 的 vendor 归因本身不受此阻塞，仅其 buffered 重试尚未默认启用。
- **根因**：`recordProtectStreamingOutcome(outcome, retries)`（`src/lib/anthropic/protect-streaming-stats.ts:31`）是一个**无维度**的进程内全局聚合计数器（saved/exhausted/retreated 各一个数）。Anthropic buffered（`messages/handler-v4.ts`）+ Responses buffered（`routes/responses/handler-v4.ts:387` `onBufferedResolve`）**都喂同一个计数器**，`/api/status.protect_streaming` 快照无法区分某次 L2 engagement 来自哪个端点；per-entry `recordFeature("protect-streaming-retry", {outcome, retries})` 同样不带端点/格式维度。
- **当前行为（已核实无害，大部分已修复见上方部分解决注）**：~~`/api/status.protect_streaming` 显示的是 Anthropic + Responses 合计的 L2 命中计数（saved/exhausted/retreated），诊断「buffered 重试整体是否在起作用」够用；但无法回答「Responses 的 buffered 命中率 vs Anthropic」。~~per-entry feature tag 仍在 history（可事后按 entry 的 endpoint 聚合），**vendor 维度已落地**（见上方部分解决注），仅 Anthropic 侧 P1 块级机制未接线。
- **理想架构**：给计数器加 `format`/`endpoint` 维度（`Record<format, ProtectStreamingStats>` 或 counters bag 泛型化，见 skill `telemetry-architecture` 的可扩展 registry 三支柱），`recordProtectStreamingOutcome(outcome, retries, format)` 各端点传自己的 format，`/api/status.protect_streaming` 按端点分列；`recordFeature` 的 meta 补 `format`。**已落地**（见上方部分解决注）。
- **为何暂缓**：per-entry history 已可事后按端点聚合（真值不丢，仅实时聚合视图缺维度）；加端点维度属遥测 registry 扩展工作单元（跨切面，牵动 status API + 前端展示），价值待「需实时对比两端点命中率」的运维需求证实。属「决定数据模型后的后续项」非「因范围大降级」。遥测架构见 skill `telemetry-architecture`。**已由 block-level-buffered-retry P0 落地，本段为历史记录。**
- **若做需改什么**：① `protect-streaming-stats.ts` 计数器加 `format` 维度（`Record<ClientFormat, ProtectStreamingStats>`）+ `recordProtectStreamingOutcome` 加 format 参；② Anthropic + Responses 两 `onBufferedResolve` 各传自己 format；③ `getProtectStreamingStats` + `/api/status` 快照按端点分列；④ `recordFeature("protect-streaming-retry", {…, format})` 补维度；⑤ 前端 status 展示分端点。**①②③④ 均已落地**（②对 Anthropic 已接 vendor 但 `commitBoundaries` 仍 gated，见上方注）。发现方：Task 3.2 Minor（2026-07-08，Responses 作 buffered 第二消费者时暴露共享计数器无归因）。

## ui-v4 列表↔详情「双入口」（Linear 式 peek + 整页）— shadcn 重设计的未来演进

- **背景（2026-07-10 设计讨论）**：ui-v4 正在讨论全面切换到 shadcn/ui（new-york 变体 + 锐角 + 可调色默认继承现有 Amber 暗色 + 标准密度）——决策见 ADR `ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md`。列表↔详情的组织方式定了基调 **形态 A**：保留现有「整页详情」（详情独占全宽，契合 request-inspector「深看单条」的主任务）+ 补「连续性」（相邻请求 prev/next 快捷键翻页 + 返回列表定位 `?at=id`），以消除「孤岛式整页」这个真正违反直觉的根源（而非整页本身）。双入口（形态 C）作为未来演进被显式 defer，不砍。
- **当前行为**：Requests 列表 `/requests` → 点击**整页跳转** `/requests/:id`（`RequestDetailPage` + `DetailPanel` 占满主内容区，顶部「‹ 返回列表」）；Models 详情用**右侧抽屉**（两处详情模式不一致）。无 peek 面板、无相邻导航。
- **理想架构（形态 C 双入口）**：单击列表行 = **右侧 peek 面板**（快速扫读、不离开列表上下文）；回车 / 双击 = **整页详情**（深度审查，即现有整页视图）；深链 `/requests/:id` 直达整页。兼得「快速扫读比对」与「全宽深看」，与主流（Linear / Jira / 邮件客户端）双入口一致。
- **为何暂缓（用户 2026-07-10 决策）**：形态 A 已满足用户核心偏好（喜欢整页全宽）+ 补 prev/next 后同时满足通用直觉（连续浏览 + 不丢列表上下文），是最小改动解；双入口是**严格增量**演进，形态 A 不挡路（prev/next 与 peek 可共存演进）；peek 面板引入 master-detail 分栏基建 + 单击/回车双语义交互复杂度 + 用户教育成本，价值待「实测更多在扫读比对而非深看单条」后再证。属独立 UX 演进工作单元，非「因范围大降级」。
- **若做需改什么**：① 引入右侧 peek 面板组件（可复用 `DetailPanel` 的 segment 渲染、窄宽版）；② 列表行「单击 → peek / 回车 · 双击 → `navigate(/requests/:id)` 整页」的双语义路由；③ peek 与形态 A 的 prev/next 快捷键协调（peek 内也可 j/k 翻相邻）；④ Models 详情统一到同一双入口（替换现抽屉，或把抽屉视作 peek 的一种）；⑤ 交互 + 键盘可访问性测试。**前置**：形态 A（整页 + prev/next 连续性）先落地。发现方：ui-v4 shadcn 重设计布局讨论（2026-07-10）。

## Vue 模型退役 + CSV 移除留下的孤儿（2026-07-10，已解决）

退役 Vue `/models` 视图 + 移除 ui-v4 CSV 导出后，两处成孤儿，**已按用户决策清理**（2026-07-10，commits `ee838f63` + `62d14d7d`）：删 `ui/src/components/ui/JsonViewerSurface.vue`（+ detail-page.test.ts 惰性 stub）、删 ui-v4 `sortModelRows` 及其两处测试与连带 unused imports。表格自身排序（TanStack `getSortedRowModel`）不受影响。**残留独立 refactor（未做）**：ModelsPage 的 `sorting` 受控 lift 现仅用于把排序态传给 ModelsTable，若嫌多余可下沉回表格内部（TanStack 自持）——属独立小重构，非孤儿。

## Requests 列配置的键盘 a11y 路径（2026-07-11，暂缓）

- **根因**：列配置特性（resize + reorder，spec `2026-07-11-ui-v4-requests-column-config`）的两个拖拽交互都只走指针设备。
- **当前行为**：列宽 resize 手柄仅 `onMouseDown/onTouchStart`（无键盘调宽）；列 reorder 的 `DndContext` 仅注册 `PointerSensor`（无 `KeyboardSensor` + `sortableKeyboardCoordinates`）。键盘用户无法 resize/reorder 列（仍可经 Columns 菜单显隐 + Reset）。
- **理想架构**：① reorder 加 `KeyboardSensor({coordinateGetter: sortableKeyboardCoordinates})`；② resize 手柄改可聚焦元素 + 方向键调宽（或提供数字输入）。
- **为何暂缓**：本期 spec 明确只要求指针拖拽；键盘路径是正交增强，不阻塞核心可配置能力。内部工具、单用户，优先级低。
- **若做需改什么**：`RequestsListPage` 的 `useSensors` 加 KeyboardSensor；`SortableHeaderCell` 补键盘激活语义；resize 手柄换 focusable + keydown 调 `columnSizing`；补键盘交互测试。发现方：column-config Task 3 审查（2026-07-11）。

## Responses via-chat-completions fallback 子路径未采用块级 buffered（flushResponse post-loop 结构不兼容）

- **根因**：Responses HTTP 的 **via-chat-completions fallback**（模型不支持 `/responses` → CC 上游 + CC→Responses translator）的终止生命周期 `output_item.done` + `response.completed` 由 `codec.flushResponse(env)`（`src/routes/responses/handler-v4.ts:454` post-loop 闭合 drain）在 driver 循环**外**合成——translator `translate()` 只发 `output_item.added`（`src/lib/openai/translate/responses-to-cc-request.ts:297,345`），`.done`/`.completed` 只在 `flush()`（`:418,446,459`）产出。故 buffered 循环**内**：块级 `commitBoundaries` 永不见 `output_item.done`、`sawMessageStop`（`acc.status`）drain 时仍 false → driver 误判干净 fallback 收尾为截断、重试到 exhausted。与 Gemini（§7.4，`flushResponse` post-loop 不可见）**同根因**。
- **当前行为（已修为无害）**：P2 Task 3 把 fallback 子路径**排除 buffered、保持 live**（`bufferedConfigured && !viaFallback`，`src/routes/responses/handler-v4.ts:307`）；direct 子路径走块级 buffered。fallback 功能完整（live 收尾正确），仅缺 buffered 保护（截断→fail+保留 partial，与 buffered off 等价）。
- **理想架构**：把 `codec.flushResponse` 的终止生命周期产出重构进 driver 的 buffered 提交单元（`runResponse` 循环内产出 `output_item.done`/`response.completed`，或让 buffered sink 感知 handler 的 post-loop flush 作为最终 commit 边界）——则 fallback 与 direct 统一块级。Gemini 同一重构可一并解（两者都卡 flushResponse-post-loop）。
- **为何暂缓（不落地 speculative code）**：需动 translator 的 emit 时序（把 `flush()` 的终止事件前移进 `translate()` 的 finish_reason 处理，或让 driver 承接 handler post-loop flush）——跨 codec 结构改动，超出 P2「Responses HTTP 块级」范围；无已知 fallback-under-buffered 的生产命中（fallback 本身是回退路径）。
- **若做需改什么**：① CC→Responses translator 在见到 CC `finish_reason` 时在 `translate()` 内即产出 `output_item.done`（而非 `flush()`）；② 或 driver 增「handler-supplied 终结 flush」纳入 buffered 提交单元；③ 去 `handler-v4.ts` 的 `!viaFallback` 门控；④ fallback+buffered mid-stream drop 重试回归测试；⑤ 与 Gemini §7.4 排除条合并考虑。发现方：P2 Task 3（2026-07-12，读 `codec.ts:237` flushResponse + translator emit 点确证；行号已核对现状，非 brief 原始估值）。
## 组成/tool-密度感知 calibration factor（size 无法解释的残差 ~7%，2026-07-11 暂缓）

- **根因**：size-aware calibration（spec/plan `2026-07-11-size-aware-calibration-learning`，Phase 1 已落地）把 factor 从「单标量」升为「per-bucket（按 localEstimate 规模分 6 桶）tok-weighted 滑动加权均值」，离线实测把 count_tokens 误差从 ~50% 高估砍到 **MAPE 6.9%**（时间留出集 6.4%，非过拟合）。**残差 ~7% 是纯 size 维度无法解释的部分**——来自请求**组成 / tool 密度**（同规模但 tool_use/tool_result/code 占比不同的请求，o200k↔Claude tokenizer 失配率略有差异）。当前 factor 只按 `localEstimate` 分桶，对同桶内不同组成的请求用同一 factor。
- **当前行为（已核实足够）**：两个消费者（`count_tokens` route 的客户端 compact 判定 + `debug` route）配安全边际后，~7% 残差**均可接受**——离线验证 p90 仅 17.6%，且 size-aware 已消除主要偏差（50%→7%）。size 分桶已把 400-regime（顶桶）与典型-regime（中桶）自动隔离。功能完整、仅精度还有第二维可挖。
- **理想架构**：给 factor 模型加**第二维**（组成/tool 密度）——如按 `(sizeBucket, toolDensityBucket)` 二维分桶，或在 per-bucket factor 上叠加一个 tool-ratio 线性修正项；学习信号仍来自成功腿 usage + local estimate，只是落桶键多一维。`countTotalTokens` 已能从 payload 算出 tool block 占比作第二维特征。
- **为何暂缓**：残差已在两消费者可接受范围内（against over-engineering——精度收益边际递减，第二维把 6.9%→可能 ~4-5%，价值未证）；二维分桶会稀释每桶样本量（需更多 live/backfill 数据才收敛）、增加 seed 表维度与迁移复杂度；spec §2/§11 已显式列为暂缓项、两轮 subagent 对抗审查均认可暂不加。属「独立精度增强工作单元」非「因范围大降级」。
- **若做需改什么**：① `engine.ts` 的 `FactorBucket` 落桶键加 tool-density 维度（`bucketIndexFor` → 二维索引，或 factor 叠加 tool-ratio 项）；② `CalibrationSink` + `calibration-backfill.ts` 落桶时算 tool 密度特征（复用 `countTotalTokens` 的 tool block 统计）；③ `DEFAULT_FACTOR_SEED` 表升二维 + `boundsVersion` bump 触发重 seed；④ 离线 `exp/token-calibration-size-aware/` 重训二维模型验证残差实际降幅、时间留出集不过拟合；⑤ 迁移路径（一维 v2 → 二维 v3）。发现方：size-aware calibration spec §2/§11 暂缓裁决（2026-07-11）。

## size-aware calibration 的廉价 follow-up（2026-07-11 全分支终审 triage）

三条长远正确的低成本增强，`feat/size-aware-calibration` 终审判为非阻塞、记此暂缓：

- **CalibrationSink model-miss 静默无日志**：`src/lib/observability/sinks/calibration.ts` 在 `state.modelIndex.get(body.model)` 未命中时裸 `return`，与 backfill `processRow` 打 skip 计数不对称。**若做**：补 `consola.debug`（never-swallow 观测性），使「某端点 wire 名 ≠ index id 导致全程不学」可见。发现方：Task 5 review + 全分支终审。
- **backfill cursor+accum 两次 setMeta 非原子**：`src/lib/history/sqlite/calibration-backfill.ts` 相邻两条同步 sqlite 写之间无 await，仅 SIGKILL/断电撕裂窗可致 1 批（~100 行）cursor/accum 漂移；有界 + seed 自 CAP 封顶自愈。sibling backfills（usage-normalize / response-preview）同款 pattern。**若做**：统一用 `db.transaction` 包裹 cursor+accum 双写（系统性、非单点）。发现方：Task 6 review + 全分支终审。
- **calibration 靶向测试缺口**：CalibrationSink 的 REAL_FLOOR/EST_FLOOR/model-miss/usage-缺-cache 分支、pre-flight driver 接缝「首轮只调一次」均无直接单测（经读码 + 505 回归间接覆盖，行为已核实正确）。**若做**：补靶向 golden 用例。发现方：Task 5/9 review + 全分支终审。

**待实测验证项（spec 已 defer，§3.2-S2/§11）**：400 腿 `reportedCurrent` 是否含 cache token（whole-prompt 口径）。Task 1-4 实施时探针初判含 cache（opus 400 报 ~1M 只可能 cache-inclusive），但未在活服务器端到端复验。若某天发现 cache-heavy 请求两腿口径偏差，回查此处。400 几乎总落顶桶 + CAP 封顶，影响边际。

## 翻译矩阵正向流式 OQ1（流式 reasoning 帧形态活服务器实测）+ L2 缓冲重试（2026-07-12，Phase 4 暂缓）

翻译矩阵 Phase 4（正向 CC→Anthropic 流式 + handler 缝合）落地时，两项留待后续：

- **OQ1 流式 reasoning 帧形态未活服务器实测**：非流式已实测（PROBE-FINDINGS：cc 腿无 `reasoning`/`reasoning_content` 字段、responses 腿 `reasoning.summary:null`——两腿均不回传 reasoning 内容）；**流式**帧形态本会话未实测——`no-auto-server` 禁止自启服务器，且运行中的 4141 实例仅有 anthropic-messages 流量（零 CC/Responses/Gemini 流式条目、零翻译腿条目，特性刚落地无真实流量），无法只读观测原始 CC/Responses 流式 reasoning 帧。
  - **当前行为（已核实正确、与实测无关）**：`cc-to-anthropic-stream.ts` translator **识别** `delta.reasoning`/`reasoning_content`（经 CC accumulator 累积 `reasoning_tokens` 进 usage）但**从 content 丢弃**——绝不合成无 signature 的 thinking 块（反向红线 WARN-B，`ghc-anthropic-upstream` "cannot be modified" 400/毒化）。无论 GHC 是否流式回传 reasoning delta，此行为都安全：不回传→no-op；回传→丢弃出 content、reasoning_tokens 仍计入 usage。单元测试已锁 W2 thinking-drop。
  - **为何暂缓**：best-effort 丢弃已实现且正确（不依赖流式帧形态实测）；活服务器流式帧形态验证需用户跑服务器 + 真实 `@cc`/`@responses` 流式请求（省配额 + no-auto-server）。属**用户可验证的实测项**，非阻塞正向流式解锁。
  - **若做需改什么**：① 用户跑服务器 + 发真实 claude-via-cc / responses 流式请求，经 4141 History 只读观测某翻译腿条目的 `attempts[].upstreamResponse.sseEvents`（原始 CC/Responses 帧）确认 GHC 是否流式发 reasoning delta、形态如何；② 若发现 GHC 流式回传**带 signature 的**可复用 thinking（当前实测两腿都不回传），再评估是否透传（当前一律丢弃是安全上界）。发现方：Phase 4 golden 预捕获期（2026-07-12，OQ1 剩余）。

- **翻译腿流式 L2 缓冲重试（`protect_streaming_generation`）未接**：`pumpTranslateLegStreamingV4` 走 LIVE 路径（`runResponseSink`），**不接** buffered-retry。原因：buffered commit 的 `sawMessageStop` gate 读 Anthropic `message_stop` 终止符，但翻译腿的 message_stop 由 `flushResponse` 在 render 循环**之后**合成（上游 CC/Responses 流携带的是 `finish_reason` 而非 Anthropic `message_stop`），buffered driver 在循环内提交前看不到它。
  - **当前行为（已核实完整）**：LIVE 路径对正向流式解锁字节正确且完整——逐帧翻译 + 心跳复用 + reconcile + 截断检测（getStreamMeta F2）全在。仅缺「上游 RST 时缓冲重试整代」这一 opt-in 增强（默认 OFF，与直连腿默认一致）。
  - **理想架构**：给 buffered driver 的 `sawMessageStop` 一个「翻译腿感知」信号——buffered 消费上游 CC/Responses 帧、在上游终止（CC `finish_reason` / Responses `response.completed`）时提交，flush 的 Anthropic 终止符在 commit 后附加；或让翻译腿的 outbound 累加器暴露「上游是否见终止」供 gate 读（对齐 Responses buffered 的 `acc.status !== ""` 模式，见 `routes/responses/handler-v4.ts` 的 `sawMessageStop: () => acc.status !== ""`）。
  - **为何暂缓**：LIVE 路径完整解锁正向流式（核心目标达成）；buffered-retry 是正交 opt-in 增强（默认 OFF），翻译腿的终止符时序与直连腿不同需专门接线（独立工作单元，`learn-by-analogy` 同 Responses 作 buffered 第二消费者的模式但需翻译腿专属 gate）。属「决定形状后的后续增强」非「因范围大降级」。
  - **若做需改什么**：① `pumpTranslateLegStreamingV4` 按 `resolveBufferedAndHeartbeat` 分 buffered/live；② buffered 分支 `runResponseBufferedSink` 的 `sawMessageStop` 读翻译腿 outbound 累加器的上游终止信号（cc: `ccAcc.finishReason !== ""`；responses: `respAcc.status !== ""`）；③ `onAttemptReset` 重建 CC/Responses 累加器 + 重置 translator（translator 需支持重置或每 attempt 重建）；④ commit 后 flush 附加 Anthropic 终止符；⑤ 缓冲重试回归测试（对齐 `streaming-l2-buffered.http.test.ts`）。发现方：Phase 4 T4.2 handler 缝合（2026-07-12）。

## ✅ 上游 Transport middleware(ad-hoc hook 机制) —— 已实施 2026-07-12

已落地并合并 master(`118a9c33`)。**实际架构非本条原设想的 HookedTransport decorator,而是 driver 编排的三挂载点**(`onRequest`/`onExchange`/`rewriteUpstreamFrame`,收口进 `createPipelineDriver`)。权威:spec [2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md) + ADR [2026-07-12-driver-orchestrated-upstream-hooks.md](../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md) + DESIGN.md 活的架构现状 + 用法 skill `upstream-hook-mocking`。遗留增强见下方「hook-rewrite forwarded 标记覆盖缺口」「Responses WS 腿 hook」「attempt 级 source provenance」三条。

## `hook-rewrite` forwarded 标记覆盖缺口：Responses(HTTP+WS) + 全部 translate 腿（2026-07-12，Task 2.3 实现后核实）

> ✅ **已解决（landed `3341efb4`，2026-07-20，spec/plan 2026-07-20-synthetic-frame-forwarded-track-completeness §Unit 2）**：`responseFrame`（`candidate-response-session.ts`，前 `restoreAndAccumulate`/`restoreAccumulateCount` 已合并）改 `...frame` 展开，单点覆盖 HTTP+WS（探针实测：buffered-merge 按引用透传 + delivery-session default 分支 + makeWsSink.write 读 readSyntheticKind）。**translate 腿 + 两处减法边界仍未覆盖**（drop-delta 丢 delta / repair 重建 terminal 覆盖 hook-rewrite / N:1 累加器 ill-defined）——已 characterization 固化为「可接受、两轨 diff 可还原」，非缺陷。

- **背景**：Task 2.3（`docs/plan/2026-07-12-upstream-hook-middleware/plan-2-history-provenance.md`）给 `rewriteUpstreamFrame` 改写的帧接了 forwarded 轨 `synthetic:"hook-rewrite"` 标记——用一个 Symbol-keyed 属性打在改写后的帧对象上（`hooks/origin.ts` 的 `tagFrameRewritten`/`wasFrameRewritten`），靠对象引用/`{...frame}` 展开语义存活到 `client-sink.ts` 的 `write()`。
- **实测覆盖矩阵**（读代码 + 单测锁定，非猜测）：
  - **可靠**：Anthropic `/v1/messages` 直连（`codec.ts:293` `renderResponse` 对非-translate leg `return frame` 逐字返回）、CC `/chat/completions` 直连（`openai-cc/codec.ts:207-209` 同样逐字返回 + `chat-completions/handler-v4.ts:384` 的 `onRenderedFrame` 用 `{...frame, data: X}` 展开——对象展开会复制 Symbol 键，亲手用 `bun -e` 实测确认）。
  - **丢失（已知、已用测试锁定预期行为，见 `driver-provenance.unit.test.ts` 两个"KNOWN GAP"用例）**：
    1. **任何 translate 腿的 `codec.renderResponse`**（CC→Anthropic / CC→Responses / CC→Gemini 的 stream translator）——这些是**跨多个上游帧的有状态 N:1/1:N 累加器**，构造全新帧对象、不展开输入，"这个输出帧对应哪个输入帧"本身就 ill-defined（spec §3.4/§8 已预见）。
    2. **`routes/responses/handler-v4.ts` 的 `restoreAndAccumulate`（Responses HTTP，direct 腿也中招）** 与 **`routes/responses/ws.ts` 的 `restoreAccumulateCount`（Responses WS）**——两者重建全新 `{event, data}`/`{data}` 字面量（不展开 `frame`），**连 direct 腿也丢**——这是一个与 hook 特性无关、独立存在的既有模式（顺带也丢了 `id`/`retry` 字段，只是历史上无人关心）。
- **为何暂缓**：Task 2.3 的验收门槛是"passthrough 腿至少可靠"（已达成，覆盖最常用的 Anthropic/CC 直连），核心透传机制（driver.ts 打标 + client-sink.ts 读标，纯 `src/lib/pipeline/` 层，3 个小文件）本身干净、无需为了覆盖 Responses/Gemini 去动 handler 业务逻辑（那会把改动面扩到 `routes/responses/handler-v4.ts` + `routes/responses/ws.ts`，且需谨慎不能意外改变 Responses 帧重建后的 wire 形状）。这是 Task 2.3 执行时**新发现**、比 brief 预判更细的一层缺口（brief 只预期"translate 腿 ill-defined"，未预期 Responses 的 direct 腿也因**独立**的帧重建模式丢标）。
- **若做需改什么**：① Responses 缺口——让 `restoreAndAccumulate`/`restoreAccumulateCount` 从 `{...frame, event: ..., data: ...}` 展开构造（而非全新字面量），顺带补上 `id`/`retry` 字段保真（需评估是否改变现有 wire 字节——这两个字段目前从未被写出，加上后需重新对齐 golden 等价测试）；② translate 腿缺口——本质上是"改写单帧 vs 累加器多帧"的语义冲突，除非重新设计 stream translator 让它逐帧携带 provenance 位（侵入式改造，不值当只为一个可观测性标记），否则建议保持现状、接受可辨识性缺口，靠上游轨/forwarded 轨的**内容 diff**（两轨都已如实记录）间接定位改写。发现方：Task 2.3 实现 + `bun -e` 实测对象展开语义（2026-07-12）。

## `onRequest` hook 抛错无 warn（Task 5.4 收尾评审 M-3，2026-07-12，决定跳过）

- **现状**：`driver.ts` 的 `onRequest` 挂载点调用（`runRequest` 内，[driver.ts:197-198](../../src/lib/pipeline/driver.ts#L197)）不带 try/catch，抛错直接向上传播到 `runRequest` 的调用方（各 handler 的常规错误路径）——不同于 loader 加载/重载失败有 `consola.warn`（warn-continue）。
- **为何暂缓（决定不做，非"暂缓待做"）**：读代码确认这不是遗漏而是与既有设计一致的行为——`onExchange` 挂载点（[driver.ts:320-323](../../src/lib/pipeline/driver.ts#L320)）同样**不**warn-continue：它的调用点在 retry 循环的 `try`/`catch` 内，抛错被 `classifyError` 当作**真实上游错误**吃进反应式 retry 机制（这正是 spec §4.2 `mockUpstreamError` 契约的设计意图——hook 抛错 = 模拟上游失败，驱动 reactive 策略，而非被吞掉）。若给 `onRequest` 包一层 warn-continue（吞掉异常、退回 `rewritten` 直通），会与 `onExchange` 的"hook 抛错是真信号"模式不一致，且**改变单请求错误路径的语义**：当前"hook 抛错→该请求失败"是合理行为（hook 是开发者自己写的 ad-hoc 代码，抛错通常意味着 hook 本身有 bug 或故意模拟失败），改成"警告+静默继续"会让 hook 的 bug 被悄悄吞掉、给出"请求成功但 onRequest 改写其实没生效"的误导性假象——这正是本项目 `never-swallow-errors` 纪律要防的类别。**默认关闭功能**（`hooks.enabled:false`）意味着此路径对生产流量零风险，收益（更友好的开发调试体验）不足以抵消引入的不一致 + 潜在误导。
- **若做需改什么**：若未来仍想加 warn，应同时决定是否要**对称地**给 `onExchange`/`rewriteUpstreamFrame` 也加同款 warn-continue（而非只改 `onRequest` 一处、制造新的不对称）——但这会让 `mockUpstreamError` 驱动 reactive retry 的核心用途失效（异常会被吞而非进入 `classifyError`），故基本不可行；更现实的路径是**只在 hook 文件加载/重载时**做形状/类型校验（loader 已做），把"运行时抛错"留给调用方错误路径处理，不新增一层吞错。发现方：Task 5.4 收尾（本轮 fix+closeout）读 `driver.ts` 全部三个挂载点调用点后核实。

## 上游 hook 覆盖缺 Responses WebSocket 腿（2026-07-12，closeout 遗留）

- **根因**：本特性的 `onExchange` 挂载点收口在 `createPipelineDriver`（[driver.ts:321-323](../../src/lib/pipeline/driver.ts#L321)）——`hook?.onExchange ? await hook.onExchange(wire, current, () => deps.transport.send(wire, current)) : await deps.transport.send(wire, current)`，即挂在 driver 调用 `Transport.send` 的那一层。凡是经这条 `Transport` 接口发起上游通信的路径（HTTP 直连的 `http-transport.ts` + Responses HTTP 的 `responses-transport.ts`）都天然被覆盖。但 **Responses 的 WebSocket 腿**（`src/routes/responses/ws.ts`）走的是一条独立通道：`ws.ts:227` 直接 `createUpstreamResponsesTransport({...})` 建立 WS 连接、自行驱动帧收发，**完全不经过 `createPipelineDriver`/`onExchange` 挂载点**（读 `ws.ts` 全文确认：无 `getUpstreamHook`/`onExchange` 任何引用）。
- **当前行为**：对 Responses WS 请求（`stream:true` 且走 WS 传输的 Responses 调用）使用 mock/拦截改写/录制回放/注入故障四个 hook 用途中的任何一个都**不生效**——`onRequest`（作用于请求准备阶段，与传输方式无关，故仍生效）+ `rewriteUpstreamFrame`（挂载点也在 driver 内，逻辑上应该也覆盖不到 WS 腿的独立帧循环，需与 `onExchange` 一并核实）会被静默跳过，WS 请求总是真发上游，无法用 hook 拦截/mock。这是一个**功能缺口**（非"已知且接受"的边界）——用户若对 Responses WS 场景写 hook 期望它生效，会得到"看似生效（HTTP 路径下工作）但 WS 路径下静默不生效"的误导性体验。
- **理想架构**：让 `ws.ts` 的 WS 收发也接入同一 `UpstreamHook` 挂载点——两种可行路径：① 把 WS 通道也包一层符合 `Transport` 接口的适配器、经 `createPipelineDriver` 统一调度（架构上最一致，但 WS 是长连接双工，`Transport.send` 目前是"发一次收一个 `UpstreamStream`"的单次语义，需评估是否天然适配）；② 直接在 `ws.ts` 内复刻 driver 那行 `hook?.onExchange ? ... : ...` 的调用形状（更快但制造第二处需要同步维护的 hook 挂载逻辑，长期有漂移风险）。`rewriteUpstreamFrame` 同理需要在 WS 帧收发循环里补一个等效调用点。
- **为何暂缓**：本轮特性验收范围是"HTTP 腿"（spec 未把 Responses WS 列入 in-scope 端点矩阵），且 WS 传输的双工语义与现有 `Transport.send`（单次调用返回一个流）不完全对齐，接入方案需要先决定是否改造 `Transport` 接口本身（影响面超出本特性）——这是一个需要单独设计讨论的架构问题，非本特性单个 task 可完成的收尾项。
- **若做需改什么**：① 评估 `Transport` 接口是否要扩展出双工语义（或专门给 WS 定义一个平行的 `DuplexTransport` 概念）；② `ws.ts` 接入 `getUpstreamHook()` 读取 `onExchange`/`rewriteUpstreamFrame`，语义与 driver 内的调用保持一致（尤其 mock 短路 `next`、reactive retry 对 `mockUpstreamError` 的响应）；③ 补 WS 腿的 hook 集成测试（对齐现有 HTTP 腿的 driver hook-mount-point 测试）；④ `docs/spec/2026-07-12-upstream-hook-middleware.md` 的端点覆盖矩阵补 Responses WS 行、`docs/DESIGN.md`「活的架构现状」同步。发现方：closeout fix-subagent 复核 hook 挂载点覆盖范围（2026-07-12）。

## attempt 级 hook provenance（`source` 字段，2026-07-12，可选增强首版未做）

- **根因/背景**：spec §3.4 决策 4（[docs/spec/2026-07-12-upstream-hook-middleware.md:86](../spec/2026-07-12-upstream-hook-middleware.md#L86)）在设计阶段就预见并列为"可选增强"：`UpstreamResponseData` 可增一个 `source?: "upstream" | "hook-mock" | "hook-replay"` 字段，`attempts[].effectiveSource`（[types.ts:339](../../src/lib/history/types.ts#L339)）是现成的近亲落点（同一个"这条 attempt 的数据从哪来"语义维度）。首版实现选择只用**帧级** `synthetic` 标记（`synthetic:"hook-mock"`/`"hook-replay"`/`"hook-rewrite"` 打在 `UpstreamFrame` 上，见 §3.4 承重不变量）来做可辨识性，未落地这个 attempt 级字段。
- **当前行为（已核实完整、非缺陷）**：帧级标记已经能完整回答"这条 history 记录里的每一帧数据是真实上游、mock 生成、回放历史还是 hook 改写"——这是本特性 BLOCK-1/H2 承重不变量要求的最小充分粒度（防止 hook 产物毒化 history 又不可辨识）。attempt 级 `source` 是在此之上的**汇总视图**：不需要展开 `sseEvents` 逐帧查看 `synthetic` 标记，就能在 attempt 概览层一眼看出"这整个 attempt 是不是 hook 产物"。两者不冲突，帧级是唯一真值来源，attempt 级只是可选的派生汇总字段。
- **理想架构**：给 `UpstreamResponseData`（[history/types.ts](../../src/lib/history/types.ts)）加 `source?: "upstream" | "hook-mock" | "hook-replay"` 字段，在 `legFromUpstreamResponse`（[context/request.ts:145](../../src/lib/context/request.ts#L145)）或对应的 attempt 落盘投影处，扫描该 attempt 的 `sseEvents` 是否**全部**帧带同一个 `synthetic:"hook-*"` 标记（mock/replay 场景下应当是"整个 attempt 全部帧同源"，不会出现半真半假的混合，因为 mock/replay 是"不调 `next`"的整流短路），据此派生出这个汇总值；`hook-rewrite` 场景（改写单帧、落 forwarded 轨而非上游轨）不适用此字段（因为它描述的是上游轨来源，改写发生在 forwarded 侧，语义不同，见另一条 backlog「`hook-rewrite` forwarded 标记覆盖缺口」）。
- **为何暂缓**：帧级标记已满足本特性 BLOCK-1/H2 的验收门槛（可辨识性不缺）；attempt 级汇总字段是纯 UI/查询便利性增强，价值需等 History UI 或运维场景实际暴露出"逐帧翻 synthetic 标记太麻烦、想要一眼看 attempt 级摘要"的需求后再做，避免为了假设性便利性抢先扩 schema（新增 history 字段涉及类型/序列化/前端 `~backend/*` re-export 多触点，值得等真实需求）。spec 起草阶段已把它明确记为"可选增强"、非首版承诺范围。
- **若做需改什么**：① `history/types.ts` 的 `UpstreamResponseData` 加 `source?: "upstream" | "hook-mock" | "hook-replay"`；② 落盘投影处（`legFromUpstreamResponse` 或等效 attempt 归档点）扫描 attempt 的 `sseEvents` synthetic 标记派生该字段；③ history serialize/deserialize（`sqlite/serialize.ts`）+ 前端 `~backend/*` re-export 同步类型；④ History UI 的 attempt 概览视图消费该字段做徽标展示（免逐帧翻找）；⑤ 补落盘/读取往返测试。发现方：spec §3.4 决策 4 设计阶段预留（2026-07-12），closeout fix-subagent 补记为正式 backlog 条目。

## ✅ 已裁决：auto-truncate 移除后遗留的死代码（2026-07-13 集中 review + 清理，分支 chore/auto-truncate-deadcode-cleanup）

- **背景**：移除 auto-truncate 截断本体（RFC `2026-07-13-remove-auto-truncate-keep-calibration`）后，4 处符号被暂缓，2026-07-13 经独立 reviewer 对抗裁决 + 主会话亲手复核（含 Vue ui/ 消费点、旧库读侧适配、在飞 cell-assembly 重构接口、级联孤儿、6 并发分支 diff 陈旧 fork 假象排除）。**结论：逐项分化，只 1 项该删、3 项保留** —— 印证「无消费者就反射式删」之错。裁决依据：长远正确 + 无死代码 vs `no-destructive-workspace-loss` + richest-data-flow ADR + 不撞在飞重构。
- **① orphan-filter 原语（`src/lib/anthropic/message-tool-utils.ts`）→ 已删 4 函数**：`filterAnthropicOrphanedToolResults` / `filterAnthropicOrphanedToolUse` / `getAnthropicToolResultIds` / `getAnthropicToolUseIds` 删除（auto-truncate 是唯一历史消费者；Anthropic sanitize 管道走自己的 orphan 处理 `SanitizationInfo.orphanedTool*Count`，不复用这套）。**订正原记述错误**：backlog 原文把 `isLegalLeadingUserMessage` 列入「五函数」是**错的**——它被保留函数 `ensureAnthropicStartsWithUser`（同文件调用 → `sanitize/system-messages.ts` 生产消费），**有生产消费者、已保留**。测试同步删（`message-sanitizer.it.test.ts` 4 个纯函数 describe + server-tool 块内 4 个直调 test；`leading-user-message.unit.test.ts` 只测保留项、整个不动）。**learn-by-analogy 副产**：OpenAI 版 orphan-filter（`src/lib/openai/orphan-filter.ts`）**不是死代码**——`src/lib/openai/sanitize.ts:124/136/137/145` 生产管道主动调用，一律保留。
- **② `FormatCodec.preSend?` 扩展缝 → 保留（移交在飞重构）**：在飞 cell-assembly 重构（RFC `2026-07-13-inbound-codec-outbound-leg-split.md:38/170-171/303`）明确把 preSend 列为 **OutboundLeg 保留的腿专属 pre-flight 方法槽**。删它会撞 `feat/inbound-outbound-split` worktree + 删掉重构设计仍引用的扩展缝。现有注释（`pipeline/types.ts` "A general extension seam, no codec currently implements it"）已是保留说明，本轮不碰。若 cell-assembly 新设计最终不保留 pre-send 缝，届时由重构 owner 一并清理。
- **③ `PipelineInfo.truncation` → 保留（richest-data-flow + Vue 活消费）**：**订正原记述误导**——非「惰性 inert 永不写入」。写侧确死（`beginAttempt` 不传、`TruncationInfo` 无构造点），但读侧仍活：① richest-data-flow ADR——`pipelineFromLegacyAttempt`（`sqlite/serialize.ts`）读出旧 history.db 存过的真实 truncation 诊断，删读侧 = 丢历史数据；② Vue `ui/` 详情页（`usePipelineInfo.ts` / `AttemptsTimeline.vue` 读**新腿** `effectiveSource.pipeline.truncation` 等 10 处）仍渲染这些数据。已在 `history/types.ts` 的 `TruncationInfo` 加保留注释。ui-v4（React 活前端）不消费。**分阶段前提**：仅当 Vue ui/ 正式退役后才重评 UI 消费侧，届时仍倾向保留 `TruncationInfo` + `pipelineFromLegacyAttempt`（旧库诊断读出通道）。
- **④ `countTotalTokens`（`src/lib/anthropic/token-counting.ts`）→ 保留+注释（校正复用理由）**：生产/测试零消费者（生产端统一 `countTotalInputTokens`）属实，但删它会级联孤立 `countFixedTokens`+`countMessagesTokens`；且 backlog「组成/tool-密度感知 calibration」条记录了它作二维分桶复用锚点的 roadmap 意图。已加保留注释（`token-counting.ts` 的 `countTotalTokens` doc），并**校正原理由不准**：该函数只返 whole-prompt 单一总数、**不**产出 tool-block 占比，真做二维分桶需 per-block 分解。
- **遗留独立项（非本轮范围）**：`exp/token-calibration-size-aware/analyze.ts:15` 的 import 引用已删的 `auto-truncate/token-counting.ts` 目录、已断链。该文件是 **gitignored 未追踪本地脚本**（不进版本库），已在本地改指 `~/lib/anthropic/token-counting`（`countTotalTokens` 本轮保留、可运行），但此修复只对本地有意义、不随提交传播。


## ✅ 已解决：keepalive anchor 注入器可在真实块之间二次触发，产生重复 `message_start` + 索引 0 碰撞（2026-07-13 发现，2026-07-14 修复，commit `1da8a033`）

- **解决**：defect (a) 已按「若做需改什么」①②③修复并落地——`client-sink.ts` 加 `everOpenedRealBlock` 标志（`noteBlockState` 首次 push 真实块时置位），注入门改为 `openBlockStack.length===0 && !anchorAttempted && !everOpenedRealBlock`，锚点只在**从未开过任何真实块**的纯前置静默窗口注入，绝不在块间静默复触发。producer wire-oracle 回归测试 `tests/pipeline/anchor-multiblock-lifecycle.test.ts` test (a) 锁定「真实块快速开合 → 块间静默 → wire 不出现第二个 message_start / 不出现索引碰撞 / tick 退化为裸 ping（scenario-B 诚实回落）」。同 commit 一并修了 defect (b)（驱动侧 anchor 跨块 open 生命周期，见下），两缺陷本质是同一"anchor 跨块级 commit 生命周期"假设缺口的两条腿。~~④ `enveloped_ping` 对称问题：该模式 `anchorBlockOpen` 恒为 false（不占块索引），注入门同样受 `everOpenedRealBlock` 保护，故重复 message_start 风险也一并堵住、无索引碰撞。~~ **订正（2026-07-14，补写 `enveloped_ping` golden 时发现，见下方新条目）**：④ 这句判断**是错的**——`everOpenedRealBlock` 只在 `noteBlockState` 里置位，而 `noteBlockState` 被 `trackOpenBlock = heartbeatOn && typeof heartbeat.pingFrame === "function"` 全局短路；`enveloped_ping` 的 `pingFrame`（`resolveAnthropicKeepalive("enveloped_ping")`）是固定帧对象、非函数，故 `trackOpenBlock` 恒 false、`everOpenedRealBlock` 永不置位、守卫对该模式**零防护**——重复 `message_start` 缺陷实际未堵住。**保留下方原始条目正文作为根因存档**。**再订正（2026-07-14，同日修复）**：该缺口已修复——`trackOpenBlock` 放宽为 `heartbeatOn && (typeof heartbeat.pingFrame === "function" || heartbeat.injectAnchor !== undefined)`，详见下方「✅ 已解决：`enveloped_ping` 模式的 `everOpenedRealBlock` 守卫零防护」条目。

原始条目（根因分析，存档）：

## keepalive anchor 注入器可在真实块之间二次触发，产生重复 `message_start` + 索引 0 碰撞（2026-07-13，P1 Task 6 接线时发现）

- **根因**：`client-sink.ts` 的心跳 tick（约 :356）的 anchor 注入门是 `heartbeat.injectAnchor && openBlockStack.length === 0 && !anchorAttempted`——只看「当前开块栈是否为空」，不区分「从未开过块的纯前置静默窗口」与「已经开/关过至少一个真实块之后的块间静默窗口」。真实块 `content_block_stop` 会把它 pop 出栈（`noteBlockState` :204），若这是唯一开着的块，栈就变空；下一次 tick 若恰好命中静默阈值，`openBlockStack.length===0` 为真，且 `anchorAttempted` 从未被置位（因为前一个静默窗口从未触发过注入——被真实内容抢先），于是**再次**调用 `injectAnchor()`，它内部只守卫 `state.injected`（一次性），而 `state.injected` 在这条时间线上确实还是 `false`（第一个块流动很快、从未进入静默），于是注入成功——转发**第二个** `message_start`（携带早前捕获的 `capturedMessageStart`，与已经真实转发过的第一个 `message_start`重复）+ 打开一个**新的** `content_block_start@0`（与刚关闭的真实块@0 索引碰撞，因为该场景没有 anchor 抢占索引 0、真实块本就用的是索引 0）。
- **实测复现**（driver 级确定性 harness + 完整 HTTP 端到端，均复现；已在诊断脚本中亲手验证、诊断脚本用后已删除，未落地为正式回归测试——不属本条 backlog 的交付范围）：
  1. **LIVE 路径**（`protect_streaming_generation` 默认关闭、`runResponseSink` + `liveReconcilingSink`）：block#1（text@0）快速开合、从未触发静默 → block#1 关闭后一个块间静默窗口 → tick 命中 `openBlockStack.length===0` → 二次注入 → wire 出现两个 `message_start` + 索引 0 的碰撞（真实 block#1 曾用的索引 0，此刻又被合成 anchor 抢占）。
  2. **本特性新增的块级 BUFFERED 路径**（`commitBoundaries` 已接线后）：同样场景——block#1 在缓冲期内快速完整流入并在其自身 `content_block_stop` 处提交（`committedAny=true`），提交时因为没有前置静默、`anchorState.injected` 仍是 `false`；随后的块间空档静默命中心跳 → 同样二次注入 → wire 上出现"已提交的 block#1@0" + "之后又插入一个新 message_start + content_block_start@0"的碰撞（两个索引 0 语义冲突，且 message_start 出现两次）。
- **当前行为（LIVE 路径已存在，非本次改动引入；本次改动让它在块级 BUFFERED 路径下同样可触达）**：`anchorAttempted` 只在"某次 tick 命中静默阈值但 `injectAnchor()` 因为 `state.injected` 已真而返回 false"时才重置；但它从未在"这次静默根本没有触发注入门（栈非空，真实块正开着）"的正常路径上被主动置位为"已经安全度过一次真实块窗口，不该再无条件复触发"。换句话说，`anchorAttempted` 只防**同一个**静默窗口内的并发重入，不防"跨越了一个完整真实块的生命周期之后，又出现另一个从未见过 message_start 判定的静默窗口"这种情况——因为 `capturedMessageStart` 一直非空、`state.injected` 一直是 `false`（从未被第一次静默消费掉），下一次任何空栈静默都会被误判为"仍处于前置静默、尚未注入"。
- **理想架构**：注入门不应只看 `openBlockStack.length === 0`，还需要一个"是否已经有真实内容流过 wire（至少一次真实 `content_block_start`/`content_block_stop` 已发生）"的信号——一旦任意真实块开过、关过一次，后续任何空栈静默都应该退化为 block-aware 逻辑的现有 fallback（裸 ping，或者块栈的"回落到栈底"逻辑，视是否已有 anchor 决定），而不是重新触发 `injectAnchor`（那本该是**仅前置静默**专属的一次性动作）。最小修法：给 sink 增加一个 `everOpenedRealBlock`（或等效）标志，在 `noteBlockState` 首次 push 时置位，注入门改为 `openBlockStack.length===0 && !anchorAttempted && !everOpenedRealBlock`。
- **为何暂缓**：本条属于 P1 Task 6（本任务，仅接线 `commitBoundaries` 到 Anthropic handler）范围之外的 sink 层缺陷——它在 LIVE 路径上早已存在（与本次改动无关），本次改动只是让它在块级 BUFFERED 路径下同样可达。修复涉及 `client-sink.ts` 心跳 tick 的核心判定逻辑，属于独立的正确性修复工作单元，不应该塞进"仅接线一个已验证字段"的收窄任务里（scope-ambiguity-then-ask：这是真分叉，不是本任务能顺手带上的一行改动）。且触发条件较窄（需要"至少一个真实块在从未静默的情况下快速开合，随后遇到一次块间静默"），生产 default OFF（`protect_streaming_generation` 默认关闭）时暴露面有限，块级默认转 on 前必须先解决本条。
- **若做需改什么**：① `client-sink.ts` 加 `everOpenedRealBlock`（或复用 `noteBlockState` 已有的栈变更时机置位），注入门加上 `&& !everOpenedRealBlock` 条件；② 补两组回归测试——LIVE 路径 + 块级 BUFFERED 路径，均为"真实块快速开合 → 块间静默 → 断言 wire 上不出现第二个 message_start / 不出现索引碰撞 / tick 退化为已有 fallback（裸 ping 或块栈回落逻辑）"；③ 核实这条修复不破坏纯前置静默（从未有过真实块）场景下的现有注入门（那种场景下 `everOpenedRealBlock` 应为 false，注入门保持现状）；④ 复核 `enveloped_ping` 模式下（`makeSyntheticEnvelopeInjector`）是否有对称问题（该模式不占块索引，风险可能只剩"重复 message_start"，无索引碰撞，但仍需验证）。发现方：P1 Task 6（`docs/plan/2026-07-11-block-level-buffered-retry/plan-1-anthropic-block-level.md` Task 6）接线 `commitBoundaries` 后，为验证「anchor@0 全程 open + 块间保活」写诊断探针时发现（2026-07-13）。**这不影响 P1 Task 6 本身的正确性**（本任务只接线已被 P0/P1 Task 1-3 验证过的字段，`commitBoundaries` 谓词、块栈、心跳挂起/恢复均已独立测试覆盖），但会影响 Task 5 两段 PoC 门的第二段（真实 Claude Code 长静默测试）之前，务必先排查测试场景是否恰好触发本条（若探针只测"单一静默窗口"则不会触发，若测"多个块 + 多次静默"则可能触发）——**建议在两段 PoC 门通过、默认翻 on 之前先修复本条**，否则默认 on 后生产可能偶发遇到本条导致的协议损坏。

## scenario-B 残留：anchor 从未注入 + 单次块间静默 >300s → 裸 ping 无法重置 CC 的 300s 看门狗（2026-07-14，anchor-lifecycle fix 时明确记录）

- **根因**：empty-text anchor 的注入是**仅前置静默**专属的一次性动作——只有在「响应开始后、第一个真实 `content_block_start` 之前」出现静默窗口时，心跳 tick 才会注入合成 anchor@0（转发 message_start + `content_block_start@0` + 空 `text_delta@0`），从而占住索引 0、后续块间静默都能骑在这个常驻 open 的 anchor 上发空 `text_delta@0`（真实内容，重置 CC 的 300s no-real-content 看门狗）。但如果**第一个真实块流动足够快、从未触发前置静默**（`anchorAttempted` / `injected` 均未置位），anchor 就**永远不会被注入**；此后若出现一次**块间静默**（一个真实块已 `content_block_stop` 关闭、下一个真实块尚未 `content_block_start`），此刻开块栈为空、且 defect (a) 修复后的 `everOpenedRealBlock` 已为 true（正确地阻止了 anchor 在块间二次注入），于是心跳 tick 只能退化为 block-aware provider 的**裸 ping** fallback（`emptyDeltaFor(undefined)` → PING）。裸 ping **不**被 CC 计为 "chunk"，**不**重置其 300s 看门狗（exp/cc-idle-280s/REPORT.md）——若这段块间静默持续超过 300s，CC 会断连。
- **当前行为**：这正是 `anchor-multiblock-lifecycle.test.ts` test (a) 第 356-358 行**有意锁定**的诚实回落——「anchor 从未注入 + 块间静默 → 恰好一个裸 ping」。这是 defect (a) 修复刻意保留的正确形状（阻止有害的二次注入/索引碰撞），但它同时暴露了这条独立的保活盲区：块间静默拿不到能重置看门狗的 `text_delta@0`。生产 default OFF（`protect_streaming_generation` / `responsesBufferedRetry` 默认关闭）时暴露面有限；触发需要"首块极快无前置静默 + 随后一次 >300s 的块间静默"，属较窄场景，但真实长思考/工具调用间隙理论上可达。
- **理想架构**：块间静默也应能拿到一个能重置 CC 看门狗的真实内容 delta，而不是裸 ping。两条候选路径（择一或组合，需 PoC 定夺）：① **mid-stream 懒注入 anchor**——放宽 anchor 注入时机，允许在「已开过真实块、当前栈空、且从未注入过 anchor」的块间静默窗口**首次**注入一个 anchor@N（N = 下一个空闲索引），此后块间静默骑在它上面发空 delta。风险：需与 defect (a) 的 `everOpenedRealBlock` 守卫协调（那个守卫本是为堵二次注入索引碰撞而设），要区分"有害的 @0 碰撞式二次注入"与"无害的 @N 块间新 anchor"，索引管理复杂度上升。② **保活侧改用「重开一个瞬时空块」策略**——块间静默时合成 `content_block_start@N`（空 text）+ 空 `text_delta@N`，下一个真实块到来前 `content_block_stop@N`；等价于把每个块间空档都变成一个短命 anchor。风险：wire 上多出若干合成空块，客户端/history 需容忍（打 synthetic 标记，符合 richest-data-flow ADR）。
- **为何暂缓**：① 需要**用户跑真实 Claude Code 长静默 PoC** 才能定夺——裸 ping 到底在什么阈值断连、mid-stream anchor 是否真能重置看门狗、CC 对块间新 anchor@N 的容忍度（exp/cc-idle-280s 只测了"全程单块 + 裸 ping"与"前置 anchor + 空 delta"两个 arm，没测"块间新 anchor@N"），属实测门（empirical-verification）而非可推断结论；② 与本次 anchor-lifecycle fix（defect a+b）**正交**——本次 fix 的目标是「让已注入的 anchor 跨块保持 open」+「阻止有害二次注入」，scenario-B 是「anchor 压根没注入过」的**另一个**问题空间，把它塞进本次 fix 会同时改动注入时机 + 生命周期两个维度、难以独立验证；③ 触发场景窄 + 默认 OFF，非阻塞当前块级 buffered retry 特性交付。**块级默认翻 on 之前应连同 Task 5 两段 PoC 门一并评估本条**（真实 CC 长块间静默是块级 buffering 最该服务好的场景之一）。
- **若做需改什么**：① 在 `client-sink.ts` 心跳 tick 或 `keepalive-anchor.ts` 注入器中实现选定的 mid-stream 保活策略（②路径改动面更小、更内聚，倾向优先 PoC 它）；② 若走①路径需重构 `everOpenedRealBlock` 守卫为更细粒度的"已注入过 anchor"信号 + 空闲索引分配；③ 合成的块间保活帧必须打 `synthetic` 标记（richest-data-flow ADR，wire/history 可辨识）；④ 补 producer wire-oracle 回归——"首块快速开合无前置静默 → 长块间静默 → 断言拿到能重置看门狗的真实 delta 而非裸 ping"，替换/扩展当前 test (a) 第 356-358 行的裸 ping 断言（届时该断言从"诚实回落"升级为"已修复"）；⑤ 用户 PoC 实测确认所选策略在真实 CC 下确实不再 300s 断连。发现方：anchor-lifecycle fix（defect a+b，commit `1da8a033`）交付时，test (a) 的裸 ping 断言暴露此盲区，作为独立 backlog 条目记录以免湮没（2026-07-14）。

## ✅ 已解决：`enveloped_ping` 模式的 `everOpenedRealBlock` 守卫零防护——重复 `message_start` 缺陷实际未堵住（2026-07-14 发现，2026-07-14 修复）

- **解决**：按下方原始条目「若做需改什么」①②③④修复并落地——`client-sink.ts` 的 `trackOpenBlock` 由 `heartbeatOn && typeof heartbeat.pingFrame === "function"` 放宽为 `heartbeatOn && (typeof heartbeat.pingFrame === "function" || heartbeat.injectAnchor !== undefined)`，纯增量（`typeof === "function"` 分支不变，`empty_text` 行为字节级不变；只新增 `enveloped_ping` 走 `injectAnchor !== undefined` 分支参与开块追踪）。`enveloped_ping` 现在也会驱动 `noteBlockState`/`everOpenedRealBlock`，注入门的 `!everOpenedRealBlock` 项不再对该模式恒真。`tests/pipeline/anchor-multiblock-lifecycle.test.ts` test (a′) 由 `test.failing` 改回普通 `test`，断言真正生效并通过。回归确认：`tests/pipeline/anchor-multiblock-lifecycle.test.ts`（4/4 pass）、`tests/anthropic/enveloped-ping.test.ts`、`tests/responses/`（305 pass）、`tests/chat-completions/cc-buffered.integration.test.ts` 等 CC/Anthropic buffered 套件全绿，`bun run typecheck` 干净；grep 确认 `heartbeat.injectAnchor` 仅在 `src/routes/messages/handler-v4.ts`（Anthropic Messages 端点）赋值，CC/Responses/WS/Gemini 均不传，故这些消费者的 `trackOpenBlock` 判定值不受影响（中性改动）。上方「已解决」条目④的订正说明现已过时——守卫对 `enveloped_ping` 的防护缺口已补上。

原始条目（根因分析，存档）：

## `enveloped_ping` 模式的 `everOpenedRealBlock` 守卫零防护——重复 `message_start` 缺陷实际未堵住（2026-07-14，补写回归测试时发现）

- **根因**：defect (a) 的修复给 `client-sink.ts` 加了 `everOpenedRealBlock` 标志，注入门改为 `openBlockStack.length===0 && !anchorAttempted && !everOpenedRealBlock`（见上方「已解决」条目）。但 `everOpenedRealBlock` **只在 `noteBlockState` 里置位**（:214），而 `noteBlockState` 整个函数体被 `trackOpenBlock = heartbeatOn && typeof heartbeat.pingFrame === "function"`（:186）短路——只有当 `heartbeat.pingFrame` 是一个 PROVIDER 函数（`empty_text` 模式）时才追踪开块状态。`enveloped_ping` 模式的 `pingFrame`（`resolveAnthropicKeepalive("enveloped_ping")`，`keepalive-frame.ts:60`）是**固定帧对象** `ANTHROPIC_PING`，不是函数——所以 `trackOpenBlock` 对 `enveloped_ping` 恒为 `false`，`noteBlockState` 变成完全空操作，`everOpenedRealBlock` 无论真实块流过多少次都**永不置位**。注入门的 `!everOpenedRealBlock` 项因此对 `enveloped_ping` 永远是真值（vacuous），提供**零防护**。当年"已解决"条目④的判断（"该模式同样受 `everOpenedRealBlock` 保护"）是**未实测的错误推断**——只看到"该模式不占块索引，无索引碰撞"就跳到"故重复 message_start 风险也堵住了"，没有意识到守卫本身对该模式失效。
- **实测复现**（`tests/pipeline/anchor-multiblock-lifecycle.test.ts` test (a′)，`test.failing`）：`enveloped_ping` 模式下，首块快速开合（真实 `message_start` + `content_block_start@0` + `content_block_stop@0` 均已上线），从未触发前置静默 → 块间静默命中心跳阈值 → `injectAnchor()`（`makeSyntheticEnvelopeInjector`）的注入门 `openBlockStack.length===0 && !anchorAttempted && !everOpenedRealBlock` 三项全真（`openBlockStack` 因 `trackOpenBlock=false` 永远是空数组、`everOpenedRealBlock` 永远是 `false`）→ 再次调用注入器 → 注入器内部只守卫 `state.injected`（此刻仍是 `false`，因为第一次静默从未发生过）→ 转发**第二个** `message_start`（携带早前捕获的 `capturedMessageStart`，与已经真实转发过的第一个重复）。反事实验证：临时把 `trackOpenBlock` 放宽为 `heartbeatOn && (typeof heartbeat.pingFrame === "function" || heartbeat.injectAnchor !== undefined)`（让 `enveloped_ping` 也参与开块追踪）后，同一测试从"通过（因为抛出，`test.failing` 语义反转）"变为"失败（断言真的全部成立，不再抛出）"——证实该测试是 load-bearing 的、能检测到修复。
- **历史行为（已修）**：`enveloped_ping` 是实验模式、非默认（当前默认 `ping`）。旧实现未追踪真实块，可能在首块快速开合后的静默期重复 `message_start`；现已由 `everOpenedRealBlock` 守卫与 envelope/content 独立 latch 修复。保留本条仅供历史取证，不再是活缺陷。
- **理想架构**：`trackOpenBlock` 不应仅由"`pingFrame` 是否为函数"（block-aware 保活的判据）决定 `everOpenedRealBlock` 的可观测性——`everOpenedRealBlock` 是"是否已经有真实内容块流过 wire"这一更通用的信号，理应对所有装有 `injectAnchor` 的模式（`empty_text` 与 `enveloped_ping`）都生效，即使该模式不需要 block-aware 的 provider 保活帧。最小修法：把 `trackOpenBlock`（或至少 `noteBlockState` 的调用条件）从"仅 provider 模式"放宽为"provider 模式 OR 存在 `injectAnchor`"（已在反事实验证中试出可行，`heartbeat.injectAnchor !== undefined` 判据）。
- **为何暂缓**：① `enveloped_ping` 是非生产安全的实验性模式（spec §10.6 用户已定夺不追求达到生产标准），本条缺陷不影响默认路径、不阻塞块级 buffered retry 特性交付；② 修复需要改 `client-sink.ts` 的 `trackOpenBlock` 判定逻辑（生产代码），超出本轮"补一个回归测试关闭覆盖率缺口"任务的 test-only 范围（scope-ambiguity-then-ask：这是需要用户决定是否值得为一个非生产模式投入修复的真分叉）；③ 已用 `test.failing` 锁定现状（测试因为断言真实失败——即 bug 复现——而"通过"，一旦有人真的修好 `trackOpenBlock` 会转为"失败"从而提醒维护者把它改回普通 `test`），不会被默默遗忘。
- **若做需改什么**：① 把 `client-sink.ts` 的 `trackOpenBlock` 改为 `heartbeatOn && (typeof heartbeat.pingFrame === "function" || heartbeat.injectAnchor !== undefined)`（已验证可行，见上方反事实）；② 把 `tests/pipeline/anchor-multiblock-lifecycle.test.ts` test (a′) 从 `test.failing` 改回普通 `test`（此时断言会真正生效）；③ 确认此改动不影响 `empty_text` 模式的既有行为（`empty_text` 的 `pingFrame` 本就是函数，`typeof ... === "function"` 分支不受影响，改动只新增 `enveloped_ping` 的 OR 分支，纯增量）；④ 跑 `tests/anthropic/enveloped-ping.test.ts` + `tests/pipeline/anchor-multiblock-lifecycle.test.ts` 全量回归确认无副作用。发现方：为封堵 capstone review 提出的"`enveloped_ping` 覆盖缺口"补写 producer wire-oracle golden 时发现（本应只是"safe but untested"的覆盖率任务，写测试过程中证伪了「已解决」条目④的推断，2026-07-14）。

## Anthropic（P1）块级缓冲重试默认仍 OFF——block-level anchor-coexist 形状对真实 Claude Code CLI 不安全（2026-07-14）

- **背景**：block-level-buffered-retry 特性四端点中，P2（Responses-HTTP）/P3（Chat-Completions）/P4（Responses-WS）已于 2026-07-14 把默认值从 `false` 翻转为 `true`（`CONFIG_MANAGED_DEFAULTS.{responsesBufferedRetry,chatCompletionsBufferedRetry}`，现 `packages/foundation/src/state-defaults.ts`）。**P1 Anthropic（`protectStreamingGeneration`）本轮刻意未被翻转，继续保持默认 `false`**——这不是「跟其它三个一样等 keepalive 实证门」的临时性延后，而是一个**已被真实工具实测证伪**的阻断。
- **实测证据**：`tests/e2e-client/anthropic-coexist-cli.e2e.test.ts`（P1 Task 5 第二段 PoC 门产物，Tier-2 真实 CLI e2e）用真实 `claude` CLI 驱动一个 hook-mock 的代理，让上游发出 P1 块级机制的「anchor-coexist」wire 形状（一个空文本锚点块@0 在两个真实文本块之间全程保持 open，只在终态才收口）。**结果：真实 CLI 把最终结果吃成空字符串**（`r.result` 收到 `""`，未含预期的 `COEXIST_OK_MARKER`）——推断根因是 CLI 的 agent-loop 状态机按「最后关闭的内容块」取生成结果，而 anchor@0 恰好是最后收口的块，真实文本块的内容因而被 CLI 侧丢弃（并非代理侧丢帧——SDK-only 的 Tier-1 测试 `anthropic-buffered.it.test.ts` 已证明 `@anthropic-ai/sdk` 的底层累加器本身能正确接受这个 wire 形状，问题出在 CLI 自己的更高层状态机）。本次任务重新跑了这个 gated e2e 测试（`claude` 在 PATH 上、门控条件满足），确认失败依旧复现，与本次的 P2/P3/P4 翻转无关（该测试自带的 config 显式设 `protect_streaming_generation: false`，不受本次默认值改动影响）。
- **当前行为**：P1 的块级提交机制（`content_block_stop` 谓词 + sink 块栈 + 心跳 suspend/resume + retreat 修复）代码本身已全部 landed 并通过独立 review（见 `.superpowers/sdd/progress.md` P1 Task 1-4/7），`commitBoundaries: anthropicCommitBoundaries` 的 handler 接线也已完成（P1 Task 6），但 **`protectStreamingGeneration` 的默认值维持 `false`**——用户必须显式 opt-in（`anthropic.protect_streaming_generation: "on"` 或 `"tool_use_only"`）才会启用，且**启用后会撞上这个真实 CLI 内容丢失缺陷**，故不建议在形状修复前手动开启。
- **理想架构**：修复块级 anchor-coexist 形状，让锚点块@0 不再是「最后收口」的块——候选方向包括：①锚点块提前在某个真实块提交时就收口（而非全程 hold 到终态），让最后收口的永远是最后一个真实内容块；②改用 P1 Task 5 PoC 报告里记录的「备选形状」（每块 close@0 重开，而非单一常驻 anchor@0）；③若 SDK/CLI 生态确认「按最后收口块取结果」是不可变更的既定行为，则从根本上放弃 anchor-coexist 路线，Anthropic 走「兜底」形状（整响应缓冲，同 Responses/CC 特性交付前的 L2 前身），牺牲 P1 的块级增量流式收益换 CLI 兼容性。**用户裁决（2026-07-14）：「保全 > 流式体验，能保 block 粒度就保」——故方向锁定 ① 或 ②（二者均保留 block 粒度、只改锚点收口时机），③（退回整响应、丢 block 粒度）不采纳。** 关键实证锚点：CLI gate 测试的隔离对照 (b)（把锚点收口排到最后一个真实块**之前** → `result` 恢复非空）+ live 路径 reconcile 本就在**首个真实块**处收口 anchor@0（故 live 一直 CLI-safe）——证明「让真实内容最后收口」即安全，① 就是把 buffered 路径对齐到这个已被证安全的 live 收口时机。**⚠️ 选定的具体子形状必须用 gated CLI 测试实测复验（`r.result` 含 marker + numTurns===1），绝不凭推理判安全**——本特性的教训正是「离线+capstone 都判安全、真 CLI 却 FAIL」。
- **为何暂缓**：形状修复是一个独立的设计问题（需要重新设计 anchor 生命周期或收口时机，牵动 `client-sink.ts`/`driver.ts` 的锚点状态机核心），不是本次「翻转默认值」任务的范围；且该缺陷是**用真实 CLI 实测出来的**、必须先决定修复方向才能继续，贸然翻默认值会让默认路径下的用户遇到内容丢失（比现状「opt-in 才可能踩坑」更差）。
- **若做需改什么**：① 用户决策三分支之一（提前收口 / 每块重开 / 放弃 anchor-coexist 走整响应兜底）；② 按选定方向改 anchor 生命周期机制（`src/lib/pipeline/driver.ts` 的 `flushBufferedFrames`/`closeAnchorIfOpen`、`src/lib/anthropic/keepalive-anchor.ts`）；③ 重跑 `tests/e2e-client/anthropic-coexist-cli.e2e.test.ts` 确认 `r.result` 含 `COEXIST_OK_MARKER` 且 `r.numTurns===1`；④ 确认后再翻转 `CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration`（现 `packages/foundation/src/state-defaults.ts`）。发现方：P1 Task 5 第二段 PoC 门 + 本次（2026-07-14）P2/P3/P4 default-on 收尾时重跑验证复现。
## 上游错误→客户端整形（Phase 3 收尾发现，2026-07-13）

来自 `docs/plan/2026-07-13-upstream-error-client-shaping/` Phase 3 合并态审查，裁定「刻意正确/非阻塞」但值得记录的两项。

- **① accumulator H2 识别缺陷：缺顶层 `type:"error"` 的上游 error 帧不被识别 → 走 truncation 双帧**：
  - **根因**：`src/lib/anthropic/stream-accumulator.ts` 的 `accumulateAnthropicStreamEvent` 按 parsed `event.type` 分派（`switch (event.type)` 的 `case "error"`），而**不是**按 SSE event 名（`frame.event === "error"`）。一个 `event: error` SSE 帧若其 `data` JSON 缺顶层 `type:"error"`（如 raw GHC 形状 `{error:{code,message}}`），parsed `type` 为 undefined → 命中 `default`（warn "Unknown event type"）→ `acc.streamError` 不被设置。
  - **当前行为**：handler-v4 的 H2 分支（`if (acc.streamError)`）不触发 → 该 clean-drain-without-message_stop 被归类为 **truncation**，handler 额外补一个合成 truncation error 帧。于是客户端收到**两个** error 帧（Phase 3 的 S5 `errorFrameCanonicalRewrite` 整形了 forwarded 轨的第一帧，第二帧 truncation 仍来自 handler）。这是**既有行为**、非 Phase 3 引入（`errorShapingEnabled=false` 同样双帧），Phase 3 的 S5 rewrite 只改了第一帧的形状、未消除第二帧。
  - **理想架构**：让 accumulator 也按 SSE event 名识别 H2（`frame.event === "error"` 时无条件当作 stream error，无论 parsed `type` 是否为 `"error"`），与 S5 `errorFrameCanonicalRewrite` 的判据（键 `frame.event`）对齐。进一步可把「从一个上游 error 帧抽取 `{type,message}`」抽成**共享 primitive**（当前 `parseRawUpstreamErrorFrame` 在 `error-shaping.ts`、accumulator 的 `err?.type ?? "unknown_error"` 各写一份），防两处判据漂移。
  - **为何暂缓**：属正交轨道（accumulator = 上游轨 bookkeeping，Phase 3 明令 accumulator 零改动）；真实 GHC/Anthropic 上游的 `event:error` 帧几乎总带顶层 `type:"error"`（canonical 形状），双帧只在非 canonical 上游错误时冒头、客户端 SDK 仍能解析（两帧都是合法 `event:error`）。非阻塞。
  - **若做需改什么**：`stream-accumulator.ts` 的 dispatch 改为「先看 SSE event 名、再 fallback parsed type」（需 accumulator 的入参携带 `frame.event`，当前签名只收 parsed `event`——要么改签名传 rawEvent、要么在 `recordUpstreamFrame` 层拦截 `rawEvent.event==="error"` 直接 set `acc.streamError`）；抽 `parseRawUpstreamErrorFrame` 为 accumulator + error-shaping 共享；加回归测试证「非 canonical 上游 error 帧 → 单帧、被识别为 H2 而非 truncation」；核对 handler-v4 H2 分支与 truncation 分支的互斥。

- **② 403/404/529 的 canonical wire error.type 保真度差异（enabled 态刻意行为）**：
  - **根因**：`error-shaping.ts` 的 `anthropicErrorTypeForApiError`（按 11 类 `ApiErrorType` 映射）比 legacy `post-commit-error.ts:anthropicErrorTypeForStatus`（按 HTTP status 映射）**粒度更粗**。`classifyError` 把 401/403 都归 `auth_expired`、把非特殊 4xx（含 404）归 `bad_request`、无 529 专类。故 enabled 态 post-commit 终点①：403→`authentication_error`（legacy `permission_error`）、404→`invalid_request_error`（legacy `not_found_error`）、529→`api_error`（legacy `overloaded_error`）。
  - **当前行为（裁定为刻意正确）**：Phase 3 合并态审查 concern 2 已裁「刻意正确、无需改」。理由——post-commit 的 SSE HTTP status 已锁定 200、客户端观察到的 `status` 为 undefined，故 error.type 差异**无客户端行为后果**（CC 的 post-commit 重试判据是 status===529 或 message 含 `"type":"overloaded_error"` 子串，与 canonical error.type 无关，见 `exp/cc-error-retry-surface/FINDINGS.md`）；差异仅影响**终端渲染的文案标签**。disabled 态逐字节保留 legacy 精确 type（CF-2 golden lock）。
  - **理想架构（若将来要 enabled 态也保精确 wire type）**：在 error-shaping 层引入 **status 维度**——`decide()`/`canonicalErrorDecision` 携带 `error.status`，`anthropicErrorTypeForApiError` 对 auth_expired 按 401/403 分派 authentication/permission、对 bad_request 按 404 分派 not_found、识别 529→overloaded；或扩充 `ApiErrorType` 增加 `permission_denied`/`not_found`/`overloaded` 细类（连带改 `classify.ts` 的 status 路由 + Phase 1 真值表 + 其单测）。
  - **为何暂缓**：无客户端行为后果（仅文案）、属刻意设计（Phase 1 真值表基于 `ApiErrorType` 非 status）；改动面涉及 classify.ts + 真值表 + 多处单测，收益仅终端渲染文案精度。非阻塞。
  - **若做需改什么**：见「理想架构」——`ApiError` 已带 `status` 字段可直接读；`decide()` 的 canonical 分支按 status 细化 error.type；同步 Phase 1 `error-shaping.unit.test.ts` 真值表断言 + Phase 3 `postcommit-error-shaping` 的 enabled 态断言（403/404/529 期望值）。

## forward.ts↔classify.ts 分类分歧：503 + `code:"rate_limited"` 被 forward.ts 强改 429 wire

- **根因**：`src/lib/error/forward.ts:424` 对「HTTP 503 且 body `error.code==="rate_limited"`」的响应，在 wire envelope 上强制标成 429（rate_limit 语义），而 `src/lib/error/classify.ts` 对同一响应分类为 `upstream_rate_limited`（status 保 503）。两个模块对「503-upstream-ratelimit」的 wire 呈现视角不一致。
- **当前行为**：`forward.ts` 是 anthropic/openai/gemini 三格式共享的纯 status→envelope 分派、被 6 条非-Anthropic 路由复用，其 503→429 改写是既有行为、非本特性引入。error-shaping 的 pre-commit glue 不改 forward.ts（HIGH-1 铁律），故该分歧原样保留。
- **为何暂缓**：属既有分歧、`forward.ts` 禁改（改会波及 6 条非-Anthropic 路由的错误形态）；本特性范围内不修。发现于 error-shaping Phase 2 执行 + reviewer 提醒（否则只存 commit body 会丢）。
- **若做需改什么**：统一 forward.ts 与 classify.ts 对 503-upstream-ratelimit 的 wire 视角——要么 forward.ts 保 503 status（与 classify 对齐），要么 classify 也视作 429；须跨 6 条路由回归（`forward.ts` 三格式 envelope + 各路由 golden）。

## error-shaping 观测：raw-stream 终点（H3/截断）无 `error-shaping-decided` 维度

> ✅ **已解决（landed `0bd599fc`，2026-07-20，spec/plan 2026-07-20-synthetic-frame-forwarded-track-completeness §Unit 3）**：加专属 FeatureKind `error-shaping-raw-canonical{ wireErrorType, terminus, leg }`（4 canonical 终点接线）+ `shapeRawStreamErrorFrame` 打 `synthetic:"error-shaping-canonical"`（writeSynthetic 读帧 tag 根因修，`c2a28b20`）。⚠️ 下文「当前行为」段旧前提已被证伪并修复：Anthropic messages HTTP `writeSynthetic` 路径此前 forwarded 轨 synthetic 恒 undefined，现打标记与真实上游帧可辨识。

- **根因**：`shapeRawStreamErrorFrame`（handler-v4 的 H3 + truncation 两个 raw-stream 终点 + translate 反向腿两点）从不调 `decide()`——调用方直传 wire 级 `errorType` 字符串（非 `ApiErrorType`），无类型正确的 `error-shaping-decided` payload 可报（该 FeatureKind 的 payload 含 `decision.kind`/`ApiErrorType`）。
- **当前行为**：`error-shaping-decided` recordFeature 只在 glue 的 pre/post-commit `decide()` 路径产出（有 ApiError 分类）；raw-stream 透传路径的 canonical 化仍打 `synthetic:"error-shaping-canonical"`（帧级可辨识不丢），只是缺 feature 维度的「走了哪条整形分支」诊断。
- **为何暂缓**：非数据丢失（synthetic 标记 + upstream/forwarded 双轨 diff 仍可还原）；raw-stream 路径本无 ApiError 分类语义，硬塞 decided 维度需为「纯 wire 透传路径」设计专属 FeatureKind，属观测面扩展独立工作项。发现于 error-shaping 终局 whole-branch review 的观测面接线 fix。
- **若做需改什么**：为 raw-stream 终点设计专属 FeatureKind 维度（如 `error-shaping-raw-canonical{errorType:wire-string}`）+ 在 `shapeRawStreamErrorFrame` 接线；或让 raw-stream 路径也经一次轻量 classify 复原 ApiErrorType（成本/收益需评估）。
## typed server 工具可被 tool-search 延迟（F32 校正遗留，2026-07-14）

- **根因**：`message-tools.ts` 的 `shouldDefer`（199-204）判据**只按 `tool.name`** 匹配 `NON_DEFERRED_TOOL_NAMES`，**从不检查 `tool.type`/`isApiDefinedToolType(tool.type)`**。F32 给 `API_DEFINED_TOOL_TYPE_PREFIXES` 补的 4 个前缀（`advisor_`/`agent_toolset_`/`memory_`/`tool_search_`）只修了 `buildAnthropicToolNameMapper` 的 sanitize 排除路径（typed 工具不进 custom-name 集、不被 rename），**没有**、也**不能**触及 `shouldDefer`——两者是完全独立的判据函数，前缀补全不会自动传导到延迟保护。
- **当前行为**：任何 typed server 工具（不限本轮新增 4 前缀，**含原有 6 前缀** `web_search_`/`web_fetch_`/`code_execution_`/`text_editor_`/`computer_`/`bash_`）只要其 `name` 不在 `NON_DEFERRED_TOOL_NAMES` 里，在 tool-search 默认 ON 时都会被打上 `defer_loading:true`——即使它是 server-tool 协议契约的一部分。这与「server 工具名是 upstream 协议契约、不该被当作可延迟的 custom 工具对待」的设计意图不一致，但**目前尚未观测到该行为对上游造成实际拒绝**（未实测确认 GHC 对「被 defer 的 server 工具」的具体反应——可能上游本就接受 server 工具带 `defer_loading:true` 并原样处理，也可能拒绝）。
- **理想架构**：`shouldDefer` 增加 `&& !isApiDefinedToolType(tool.type)` 条件，让 typed server 工具（无论前缀新旧）在延迟判定上获得与 sanitize 判定一致的保护——两个判据函数共享同一个「是否 API-defined」原语，消除当前的不对称。
- **为何暂缓**：① 需先确认 GHC 对「携带 `defer_loading:true` 的 server-tool-typed 工具」的实际反应（可能是良性的——GHC 也许直接忽略 defer_loading 语义处理已知 server 工具；也可能是真实拒绝，需要 e2e 探针，见 skill `client-proxy-e2e-testing`）；② 与本任务（F28 根因修复 + F32 清单回退）范围独立，属于 F32 揭示但未纳入本次改动范围的第四类判据修复，需要单独的实现 + 测试周期。
- **若做需改什么**：① `message-tools.ts` 的 `shouldDefer` 加 `!isApiDefinedToolType(tool.type)` 条件；② 补回归测试：一个 `type:"web_search_20260209"`（或新前缀）的工具在 tool-search ON 时不应被 `defer_loading:true`；③ 若探针证实 GHC 对 defer 的 server 工具确有拒绝行为，标注为「确认功能 gap」并提升优先级；若证实良性，仍建议修（协议语义正确性 > 观测到的表面无害）。发现方：F32 task-reviewer 探针实测（2026-07-14，`docs/plan/2026-07-13-cc-tool-inventory-completion.md` Task 2）。


## 罕用 CC 内置工具在 tool-search 下被延迟（接受为预期权衡，2026-07-14）

- **现象**：`CLAUDE_CODE_OFFICIAL_TOOLS`（16 项）经 `message-tools.ts:86` `...CLAUDE_CODE_OFFICIAL_TOOLS` spread 进 `NON_DEFERRED_TOOL_NAMES`，故这 16 项在 tool-search ON 时不被延迟；**不在此清单**的 CC 内置工具（`WebSearch`/`BashOutput`/`NotebookRead`/`ListMcpResources`/`ReadMcpResource` 等）会被 `defer_loading:true`（探针实测：真实 `WebSearch` 工具 `defer_loading===true`，`Read` 为 `undefined`）。
- **裁决（用户 2026-07-14）：接受、不修**。延迟**罕用**工具正是 tool-search 省 context 的**设计目的**；**热路径工具**（Read/Bash/Grep/Edit/Write/Task 等 16 项）已受静态保护；罕用工具首次调用触发一次 `deferred-tool-retry` 自愈往返（非硬失败）。此为**既有基线行为**（Task 1 补清单一度改善、Task 2 因 F28 改用根因修复而回退恢复基线）。
- **若日后要改（理想方向）**：把 `NON_DEFERRED_TOOL_NAMES` 的 spread 源与 stub 注入列表 `CLAUDE_CODE_OFFICIAL_TOOLS` **解耦为两份**——stub 列表保持精简 16 项（Path 2 已根因兜底），另建独立「非延迟保护」列表纳入全部已知 CC 内置工具名（含 WebSearch 等），并先经真实 CC 抓包（skill `client-proxy-e2e-testing`）确认哪些工具值得非延迟（全部 vs 仅高频子集）。**为何暂缓**：当前自愈成本低（首用一次往返）、无硬失败；且「哪些罕用工具值得占 context 换免首用往返」是需实测数据支撑的权衡，非拍脑袋补全。
- **注意勿混淆**：本条（非延迟维度、按 `tool.name`）与上一条「typed server 工具可被延迟」（按 `tool.type`/`isApiDefinedToolType`）是 `shouldDefer` 的**两个不同判据**——前者关客户端工具名单、后者关 server-tool 类型识别。

## no-tools 分支的孤立历史 tool_use 兜底不对称（whole-branch review 抓，2026-07-14）

- **现象**：F28 根因修复解除了 `processToolPipeline`（有 tools 路径）Path 2 的 tool-search 门控，但 `preprocessTools` 的**无-tools 分支**（`message-tools.ts:292` `else if (state.toolSearchEnabled && …)`）仍门控在 `toolSearchEnabled`。tool-search OFF + 无 tools + 配对历史 tool_use 时探针实测返回 `tools:[]`，不注 stub。
- **为何非硬失败（暂缓）**：真正孤立（无配对 tool_result）的 tool_use 会被 `processToolBlocks`（`sanitize/tool-blocks.ts`）作为 orphan **删除**（连同 tool_result），故不给 GHC 留悬空引用。有兜底、非硬失败——但兜底手段（**删历史块**）与有-tools 路径（**注 stub 保历史**）**不一致**：一个丢历史、一个保历史。
- **理想架构**：无-tools 分支也解除门控使两路径对称（保历史优先，对齐 richest-data-flow），或至少在代码注释显式说明「无-tools 依赖 orphan 删除兜底」消除困惑。
- **为何暂缓**：当前有兜底、无硬失败；两路径对称化是一致性改进非缺陷修复，可独立处理。发现方：whole-branch review（2026-07-14）。
- **补充（2026-07-13 合并态审查发现）**：`src/lib/anthropic/token-counting.ts` 的 `countTotalTokens`（whole-prompt 计数，含 thinking）在 caliber 统一为 `countTotalInputTokens` 后**已无生产/测试消费者**（成功腿/backfill 均改用 input-only 版）。同上属可删死导出——或删除，或保留作通用 whole-prompt 计数工具并加注释说明；一并纳入本条 review 裁决。

## telemetry `sketchGamma` 命名实为 `relativeAccuracy`（2026-07-13，Fix round 2 reviewer 指出）

- **根因**：config 键 `telemetry.sketch_gamma` → state `telemetrySketchGamma` → `createSketch(relativeAccuracy)`（[sketch.ts:26](../../src/lib/telemetry/sketch.ts#L26)）。该数值**实际是 DDSketch 的 `relativeAccuracy`**（默认 0.01 = 1% 相对误差），而**非**数学意义上的 γ（`mapping.gamma = (1+ra)/(1-ra)`）——命名把两个不同量混为一谈。tel_meta 冻结键也沿用 `sketch_gamma`（[store.ts `SKETCH_GAMMA_META_KEY`](../../src/lib/telemetry/store.ts)）以对齐 config。
- **当前行为（非缺陷，仅命名误导）**：数值语义正确、功能无误；只是标识符名字（`sketch_gamma`/`telemetrySketchGamma`/`effectiveSketchGamma`/`SKETCH_GAMMA_META_KEY`）叫「gamma」而承载 relativeAccuracy。Fix round 2 已在 `effectiveSketchGamma` 与 `SKETCH_GAMMA_META_KEY` 的文档注释里标注「此字段承载 relativeAccuracy 数值」，未做重命名。
- **理想架构**：把 config 键 `sketch_gamma` → `sketch_relative_accuracy`（留旧键别名读时映射，遵配置「留兼容层」纪律）、state 字段 `telemetrySketchGamma` → `telemetrySketchRelativeAccuracy`、模块级 `effectiveSketchGamma`、tel_meta 键统一到 relativeAccuracy 语义（tel_meta 键改名需迁移已有库的 `sketch_gamma` 行）。
- **为何暂缓**：本轮聚焦 MAJOR-2（γ 绑 db + poison 隔离）修复，reviewer 明确「加一行注释即可、别扩到 config 5 触点重命名」——重命名横跨 config schema/别名/state/store/tel_meta 迁移 5+ 触点，属独立可分离清理，值得单独一次改动 + review。
- **若做需改什么**：① `config/schema.ts` + `config/config.ts` 键改名 + 旧 `sketch_gamma` 别名读时映射；② `state.ts` 字段改名（`telemetrySketchGamma` 全站点）；③ `request-telemetry.ts` `effectiveSketchGamma` 改名；④ `store.ts` `SKETCH_GAMMA_META_KEY` 值改名 + 迁移已有库的 tel_meta 行（`sketch_gamma` → 新键）；⑤ 相关测试/文档同步。发现方：Fix round 2 MAJOR-2 reviewer（2026-07-13）。

## telemetry 迁移 transient：首个 post-migration 会话 7d 窗欠报 legacy 历史（2026-07-14，全分支合并态评审裁 acceptable）

- **根因**：单轨收敛（P7）后 `initRequestTelemetry` 从 `tel_raw` 重建 dimBuckets（7d live cache）、发生在 `start.ts` 的 P6 一次性 backfill（listen 之后）**之前**——首个 post-migration 会话 init 时 tel_raw 只含本会话 dual-write 行、缺被 backfill 吸收的 legacy 历史。legacy 历史进 tel_raw 后要**下次重启**才现于 7d 窗。
- **当前行为（已裁 acceptable、非缺陷）**：影响 ui-v4 主路径 `/api/status.requestTelemetry.modelsLast7d`——首会话欠报 pre-migration 历史。评审裁符合项目「无向后兼容负担 + 强制迁移允许短期降级」：**无数据丢失**（tel_raw 拿到 backfill）、**自愈**（下次重启）、仅一次性。cumulative（lifetime 窗）不受影响（backfill 直接写 tel_cumulative）。
- **理想架构（seamless-fix）**：P6 backfill **完成后触发一次 dimBuckets rebuild**，使 legacy 历史当会话即现。
- **⚠️ footgun（评审强调）**：naive「backfill 后直接再调 `rebuildDimBucketsFromRaw`」**有坑**——该函数用 `dim.set()` **覆盖**而非 merge，二次 rebuild 会用 tel_raw 值覆盖 live accumulator、**丢弃本会话已累积但尚未 drain 到 tel_raw 的 outbox 增量**。正确 seamless-fix 须**先 flush outbox（`await persistRequestTelemetry()`）再 rebuild**，或改 rebuild 为 merge-not-overwrite 语义。
- **为何暂缓**：一次性、自愈、无数据丢失，seamless-fix 增复杂度（须处理 flush 时序 + footgun）；评审裁本轮接受、记 backlog。
- **若做需改什么**：① `start.ts` backfill 调用点后：`await persistRequestTelemetry()`（drain outbox）→ 再 `rebuildDimBucketsFromRaw`/`rebuildAcceptedBucketsFromDb`（或给 rebuild 加 merge 语义避免覆盖 live）；② 加测试证「backfill→flush→rebuild 后 7d 窗含 legacy + 不丢本会话未 drain 增量」。发现方：全分支合并态评审（2026-07-14）。

## telemetry tiered-storage 收尾 Minor 清理（2026-07-14，各轮评审 triage 为 backlog）

一组低风险、可分离的清理项，攒批单独一次改动 + review：
- **重建等价 oracle cost 字段诚实化**（Task 8 review）：`dual-write`/rebuild 等价测试用整数 `multiplier:3` 掩盖 cost 的 float-accum（内存腿 `tokens*mult` 浮点累加）vs micro-sum（重建腿逐请求 `round(cost*1e6)` 求和）分歧。重建值实为**更 canonical**（per-request-micro 是 `buildSettledDelta` 明示正确形）、非真回归；但「counters byte-equal」措辞是普适假象。修：oracle 加分数-multiplier 例、cost 用 `toBeCloseTo` + 注明已知 canonical 分歧。
- **FE 同名类型碰撞**（Task 8 review）：`ui-v4/src/lib/model-telemetry.ts` 的 FE 自有窄形 `RequestTelemetrySnapshot` 与 `status.ts` 新 `~backend` re-export 同名并存；`parseRequestTelemetry` 取 `raw:unknown` 在消费边界 widen，故 P7 SSOT 收敛偏 cosmetic（仅防 field 声明漂移）。FE 解析型宜改名（如 `ParsedModelTelemetry`）真正收敛。
- **`rollup.ts` 空源桶返回类型整洁**（Task 5 review）：`rollupTier` 空源桶且 watermark=null 返回 `-Infinity`（number），下游 `===null` 判断落空走 `-Infinity+1`（行为等价、`pruneTier` !isFinite 跳过）。修：返回类型改 `number|null`、空桶 `return watermark`、两处 caller 同步。
- **rollup 增量多-tick 测试**（Task 5 review）：现有幂等/链式测试用同一 `now` 一次卷完；补一条「两次不同 now 增量上卷不重不漏」证单调水位路径。
- **Task 3 真-db mid-drain fault 用例**（Task 3 review）：drainOutboxToSqlite 的「事务中途故障原子回滚、无 partial double-count」靠 bun:sqlite `transaction()` 语义、无真-db 覆盖（现有用 sync-throwing db 绕过真 BEGIN/ROLLBACK）；MAJOR-2 逐条 try/catch 已部分覆盖。低风险高成本。

发现方：telemetry-tiered-storage 各 task per-task review + 全分支评审（2026-07-13~14）。遥测架构见 skill `telemetry-architecture`。

## 通用 schema 驱动的 tool_use 顶层键剥离（2026-07-14，AskUserQuestion salvage 特性的通用化延伸）

- **根因**：opus-4.8 偶发在 tool_use input 里 hallucinate **schema 非法的顶层键**（实测唯一受累工具是 AskUserQuestion 的顶层 `question`，见 [spec/2026-07-13-askuserquestion-toplevel-key-salvage.md](../spec/2026-07-13-askuserquestion-toplevel-key-salvage.md)）。客户端工具 schema 若 `additionalProperties:false` 则拒收，报 `InputValidationError: unexpected parameter`。
- **当前行为（已治 AskUserQuestion、其余工具未覆盖）**：`normalizeAskUserQuestionInput` 只对 AskUserQuestion 做定向抢救 + 剥离。别的工具将来若 hallucinate 顶层非法键，代理仍原样转发、客户端拒收。
- **理想架构**：把每个工具的 `input_schema`（请求里带）穿进 response-rewrite；当 `additionalProperties:false` 时，剥掉所有不在 `properties` 里的顶层键——**工具无关**、防未来任意工具的幻觉参数。
- **与 AskUserQuestion 特性不重叠、须并存**：通用腿是工具无关的**剥离**（只剥不救、无 tool-specific 语义）；AskUserQuestion 的「顶层 `question` → item」是专属**语义抢救**启发式。通用腿落地后专属抢救仍须保留——一个防幻觉参数（剥）、一个治语义错位（救）。
- **为何暂缓**：实测唯一受累工具是 AskUserQuestion（已治），无第二例证据；通用腿要把 tool schema 从请求穿到 response-rewrite 层（新接线面），additive 不阻塞、不制造错数据。
- **若做需改什么**：① 把请求 `tools[].input_schema` 经 env/state 传到 decode/rewrite 层（现只有 recover-tool-call 用了 tool schema，可复用同通道）；② 加通用剥离步（`additionalProperties:false` gate + 非 `properties` 顶层键剥离），排在 AskUserQuestion 专属抢救**之后**；③ 诊断复用 `pipelineInfo` 落盘通道；④ 测试覆盖非 AskUserQuestion 工具的幻觉顶层参数。发现方：AskUserQuestion salvage 特性 brainstorm（2026-07-14，方案 C 的通用腿）。

## 语义抢救类现有 2 例——第 3 例出现再泛化为配置驱动别名映射（2026-07-14）

- **背景**：「语义抢救」（治**必填字段错位/错名**、非剥幻觉键）现有两个专属实现，均定向、硬编码单工具：`normalizeAskUserQuestionInput`（顶层 `question` → item）与 `normalizeSendMessageInput`（`agentId` → 必填 `to`，本次新增）。二者都在 `decode-tool-input-core.ts`、经 `response_tool_use_fix.*` config 门控、诊断落 `pipelineInfo`。
- **当前行为**：每新增一个「必填字段以别名/错位到达」的工具都要手写一个 `normalizeXxxInput` + 一个 config leaf + 一条 pipelineInfo 诊断字段 + 接线。AskUserQuestion 的抢救过于 bespoke（salvage + header 回填 + strip 三步）无法折进通用别名映射；但 SendMessage 是干净的「别名重命名」子形（`to` 缺失且别名在 → 搬值删别名）。
- **理想架构**：当出现第 3 例干净「别名重命名」时，抽配置驱动的 `tool → { canonicalField: [aliasNames...] }` 映射（canonical 缺失且某 alias 在则重命名），SendMessage 作首个数据项；与上面「通用剥离腿」并列（一个治错名必填、一个剥幻觉键）。AskUserQuestion 的复杂抢救仍保留专属。
- **为何暂缓**：用户本轮明确选「一次性专属修复」而非通用机制（2 例证据尚不足以压过通用化的配置面成本；SendMessage 硬编码与配置映射代码量相当，但只有 1 个 alias 数据点）。
- **若做需改什么**：① 加 config `anthropic.response_tool_use_fix.field_aliases: Record<tool, Record<canonical, string[]>>`；② 抽 `renameFieldFromAlias` 通用原语替换 `normalizeSendMessageInput`；③ 诊断沿用 `pipelineInfo.sendMessageNormalization` 的形状泛化为 per-tool；④ 保留 AskUserQuestion 专属抢救不动。发现方：SendMessage `agentId→to` 抢救实现（2026-07-14）。

## AskUserQuestion 规范化诊断在 buffered-retry 下过报（2026-07-14，合并态 review MED，gated on buffered-retry 启用）

- **根因**：`ctx.recordAskUserQuestionNormalization` 把诊断写进 **request-level** `_askNormalization`（[context/request.ts](../../src/lib/context/request.ts) `recordAskUserQuestionNormalization`），**不做 per-attempt-reset**。buffered-retry（block-level / responses）下，某 attempt 的 tool_use 块跑完 `content_block_stop` 触发 salvage/strip（记 diag）后、在 `message_stop` 前 RST → 该 attempt 被丢弃、帧从不转发；但 diag 已 publish 进 `_askNormalization` 并落 in-flight entry。若 committed 重试 attempt 输入干净（不再 normalize），history 的 `pipelineInfo.askUserQuestionNormalization` 就展示了一个「转发 wire 从未发生」的 salvage。
- **当前行为（已裁 acceptable、非缺陷）**：**转发 wire 正确性不受影响、不丢数据**——只影响 buffered 路径（默认关、opt-in）下的诊断保真度。相邻的 `recordRepairOutcome` 为「discarded 尝试信号绝不污染 committed」显式做了 per-attempt-reset（`resetRepairOutcomesForAttempt` + `onAttemptReset` + committed flush），本诊断取了相反的 request-level 策略。已在 setter/types 注释改诚实措辞（「任一 attempt 流上执行的规范化，未必 committed」）。
- **理想架构**：与姊妹 `recordRepairOutcome` 对齐——改 per-attempt 累积 + `onAttemptReset` 清空 `_askNormalization` + 在 committed settle 点 flush 进 pipelineInfo（而非每次 record 即 publish）。
- **为何暂缓**：转发正确、无数据丢失；buffered-retry 默认关，触发窗口窄；per-attempt-reset + committed-flush 与当前「每次 record 即 in-flight publish」模型不兼容、是诊断落盘时序的架构级重构，值得单独一次改动 + review。
- **若做需改什么**：① `_askNormalization` 改 per-attempt 语义 + `onAttemptReset`（`context/request.ts`，仿 `resetRepairOutcomesForAttempt`）清空；② 把 in-flight publish 改为 committed settle 点 flush（handler，仿 `flushToolInputRepairObservability`）；③ 测试证「discarded attempt 的 salvage 不进 committed history」。发现方：合并态 review（2026-07-14，`docs/spec/2026-07-13-askuserquestion-toplevel-key-salvage.md` 特性）。

# 热路径并发 / 性能审计（2026-07-14，双异模型 reviewer 并行 + 主线亲自复核）

审计范围 = 每请求热路径（driver 七阶段 / client-sink / http2 session 池 / adaptive-rate-limiter / state / feature-negotiation / stream-accumulator / 异步 finalize 落盘）。方法 = 派 Claude reviewer 查并发 + GPT reviewer 查性能，两份报告主线逐条复核绝对断言（含推翻/修正 reviewer 机制描述，见各条「复核」）。**总评**：并发面基本健康（防护设计成熟，只 1 MED + 2 LOW）；性能面真痛点集中在 **history 持久化路径的同步 CPU/I-O 阻塞全并发事件循环**（4 条 HIGH 同根）+ **长流无界内存**（1 HIGH）。

## 【承重·根因性】history 全阶段持久化的同步 CPU/I-O 阻塞事件循环（4 条 HIGH 同根，宜一并重构）

- **根因**：history 写路径只把 finalize 的 **zstd** 移出了主线程（`compressAsync` 走 libuv 线程池，`compression.ts:52-54`），但**同阶段的 `JSON.stringify` + jsdiff 仍同步、eager/attempt/status 写全程同步、SQLite 写自身同步 + `busy_timeout=5000`**——四条同步阻塞子路径共享一个根因：**没有一个统一的有界异步 writer 队列/worker 把 history 的全部 CPU+I-O 阶段移出请求生命周期**。因 `bun:sqlite`/`node:sqlite` 是同步 API，任何一段同步块都冻结**所有并发在途流**的转发、heartbeat、新请求接收，而非只慢本请求。
- **当前行为（四子路径，实证/微基准）**：
  - **① finalize 残留 ~63ms 连续同步块**——`compressAsync` 前的 `JSON.stringify(10.4MB request_group)≈40ms`（`compression.ts:53`）+ `search-index-write.ts:276` 的同步 `buildAux` jsdiff≈23ms（`search-index-write.ts:272-276`）。`compression.ts:49-50` 注释「JSON.stringify still runs on the main thread (cheap relative to the compress)」**自证只 offload 了 zstd**，对 10MB payload 绝对值并不 cheap；8 并发真实 finalize 事件循环 max-gap≈614ms（仓库 profiling `docs/spec/history-finalize-async-offload.md`）。**复核确认**：注释自证成立。
  - **② eager/attempt/status 写在请求生命周期内同步压缩+序列化+写 SQLite**——`persistEntryEager`（`sinks/history.ts:216-223`）、每次 attempts context update 同步重写 head + 压缩 attempt request stage（`sinks/history.ts:123-143`）、每次 lifecycle transition 同步重建压缩 head、`buildHeadRow` 经 `payloadBytes()` 对大请求**再次** `JSON.stringify` 只为算字节数（`serialize.ts:312-315`/`372-374`，即使只是 status update）。微基准（2MB payload，隔离 in-memory SQLite）：eager 14.9–22.9ms / attempt stage 15.6–23.3ms / status 3.6–29.2ms，全连续主线程停顿。
  - **③ `busy_timeout=5000` 把 SQLite 锁等待变成最长 5 秒同步冻结**——`connection.ts:32,67`。**复核修正语境**：同步 API 属实，但 `connection.ts:25-30` 注释说明单进程单连接稳态自身事务不重叠，真实触发**仅限**外部连接持锁（重启进程重叠 / 误开第二实例 / 外部工具查库）——**非稳态每请求命中**，实际严重度低于 ①②（列为同簇但触发条件性最弱）。
  - **④ 未决 finalize 无并发上限/背压**——`entries.ts:143-151` 每个终态请求立即启动自己的 search build + 一组并发 `compressAsync`，Promise 入 `pendingFinalizations`（`entries.ts:204-227`）无 semaphore/队列上限/背压。每个 pending 闭包持有完整多 MB `HistoryEntry`（重复 request legs + SSE 数组 + 待压缩 payload + 输出 buffer）；到达率超四线程 libuv 压缩吞吐时队列+驻留内存**按请求数线性增长**、潜在 OOM，且并发 stringify 仍串行制造停顿。**复核**：无界集合 + 每项持有数据由代码确认（强推断）。
- **理想架构**：**单一有界异步 writer 队列/worker**统一处理 eager / stage / status / finalize 的全部 CPU（stringify + search normalization/diff + zstd）+ SQLite 写；请求侧只保留不可变 snapshot / append-only delta，writer 负责合并、压缩、串行写库。`requestBytes` 应在首次实际 wire serialization 时直接计数并随 entry 携带，避免每次 head upsert 对整个 payload 再 stringify。队列应有固定并发度 + 公开 queue depth / resident bytes / wait time / high-water 遥测；容量满时对 history producer 施加**异步背压**或落可恢复磁盘 journal，**绝不退回主线程同步压缩**。SQLite 写宜由专用 writer worker/线程串行执行、主循环只提交有界任务 await 异步结果（仅调低 busy_timeout 会重引丢写，不解决同步 I/O 架构）。
- **为何暂缓**：属跨 history 全层的结构性重构（producer↔sink↔serialize↔connection 的 settle/写时序职责重划），牵动 `persistence-async-invariants`（drain-before-close / self-owned pending / never-throw / 全 test await 等不变量须整体保持），远超单点补丁；且需真多并发 metronome oracle 验证（不能再用预 stringify 的探针代替端到端）。属独立大工作单元，非「因范围大降级」。
- **若做需改什么**：① 设计 `HistoryWriteQueue`（有界 + 固定并发 + 背压/journal + 遥测），把 `sinks/history.ts` 的 eager/stage/status/finalize 全改为「入队不可变 snapshot」；② stringify+jsdiff+zstd 全移入 worker（结构化 clone/transferable 输入，避免主线程先生成同量级 JSON）；③ `requestBytes`/`responseBytes` 首次 wire serialize 时计数携带、删除 `payloadBytes` 的重复 stringify；④ SQLite 写串行化到 writer；⑤ 遵 `persistence-async-invariants` 复核全不变量 + 真多并发 metronome oracle。发现方：热路径性能审计（GPT reviewer，2026-07-14）+ 主线复核。遥测/落盘架构见 skill `telemetry-architecture` / `persistence-async-invariants` / `history-sqlite-schema`。

## 【承重】长流同时无界保存 upstream frames + forwarded frames + accumulator + retry 副本（HIGH）

- **根因**：每请求的诊断/history 采样对**每帧**保存完整 `raw` 字符串，多条轨并存且**无帧数/字节上限**：`driver.ts:521-549` 的 `upstreamSse` 逐帧存完整 `raw`；各 handler 的 `forwardedSseEvents` 再存客户端帧完整 `raw`（`handler-v4.ts:1011-1020`/`1046`/`1052`）；Anthropic direct pump 另有 diagnostics 本地 `sseEvents` 副本；accumulator 同时重建完整 text/thinking/tool-args/结构化 content（`context/request.ts:622-625`）；buffered retry 对失败 attempt `[..._sseEvents]` 为每次失败 generation 再留一整份；`recordForwarded()` 又 `[...forwardedSseEvents]` 做全数组 O(n) 快照，正常分支 + `finally` 可**重复**执行。内存 ≈ `O(upstream bytes + forwarded bytes + accumulated content) × retry attempt 数`。
- **当前行为**：主要消耗当前超长请求内存，但 GC pause / OOM 影响整个进程。大 tool arguments / 长 reasoning / 未及时终止的流增长无结构性边界。**已挡住的对偶**：driver 的 buffered-retry buffer 本身有 `bufferCapBytes` 阀门（`driver.ts:813-860`）超限 retreat——无界的是**独立的 history/diagnostics frame tracks**，两者别混。
- **理想架构**：richest-data-flow 不要求全部常驻 RAM——raw frame tracks 增量写入临时 append-only spool / 分块压缩 stage，内存只留固定窗口 + 索引 + accumulator 必需状态，终态原子挂接 spool；history sampling 与 diagnostics 各需独立、可观测的 resident-byte 上限。
- **为何暂缓**：与上一条 history 重构强相关（spool 化同属持久化路径重构），宜一并设计；additive-observability 不阻塞现有正确性。
- **若做需改什么**：① 给 upstream/forwarded 两轨加 resident-byte cap + spool 溢出；② `recordForwarded` 消除重复全数组快照（增量 append 或幂等守卫防 `finally` 二次拷贝）；③ 长流回归测试断言 resident bytes 有界。发现方：热路径性能审计（GPT reviewer，2026-07-14）。

## 【每帧冗余簇】高频流放大的每帧开销（4 条 MEDIUM，可攒批一次改动）

- **① 同一 SSE 帧被重复 `JSON.parse`**（实测 ~4ms/流、~63% 冗余）——一帧可能先被 timing predicate parse（`request-timing.ts:54-64`/`97-127`，OpenAI first/latest 谓词各一次）、再被 handler accumulator parse、随后每个启用的 rewrite 各自 `parseFrame`（`response-rewrite-adapters.ts:85-92`/`141-159`/`183-190`/`262-263`/`295-299`）、最后 sink 的 `frameType()` + block-state tracker 再 parse（`client-sink.ts:145-154`/`214-224`）。**若做**：upstream frame 首次 parse 时挂非枚举/sidecar parsed representation 供各层复用，rewrite 改 `data` 时只失效/替换该帧 parsed cache（**不可**全局按字符串缓存，会无界增长）。
- **② accumulator 逐 delta `+=` 拼接**（O(n²) 拷贝风险 + 重复存两份正文）——Anthropic `b.text += delta.text` 与 `acc.rawContent += delta.text` 对同一文本累两次，thinking/tool-input 亦 `+=`（`stream-accumulator.ts:319-340`）；OpenAI `rawContent += choice.delta.content`（`openai/stream-accumulator.ts:99-102`）。**Responses accumulator 已用 `contentParts.push()` + 终态 `join("")`（`responses-stream-accumulator.ts:154-176`）是现成正确样板**。**若做**：Anthropic/OpenAI 对齐——按 block 存 `Array<string>` 终态 join 一次；`rawContent` 若可由 content blocks 派生则不再每 delta 维护第二份。
- **③ 每内容帧同步 publish 完整 `stream_progress` + 扫全 subscribers**——每帧构造 progress 参数 + `snapshot()` 分配新 `RequestContextSnapshot`（查 modelIndex、读 current attempt）+ 分配 event + 线性扫全 bus registrations 执行 filter + TUI 更新（`chat-completions/handler-v4.ts:440-446`、`responses/handler-v4.ts:410-415`、`context/request.ts:1026-1033`/`304-325`、`observability/bus.ts:95-117`、`tui/terminal-ui.ts:400-405`）。成本 O(frames × subscribers) + nursery GC 压力；UI 只需人类可见频率。**若做**：producer 或专用 coalescer 按时间/字节阈值节流（如每 50–100ms 发最新累计值，terminal 前强制 flush），原始 byte/event counter 仍逐帧更新不丢终值。
- **④ S5 链每帧每 rewrite 重分配中间数组**——driver 为单帧建 `[effFrame]`；`passThrough()` 每 rewrite 建新 `next=[]`；多数 passthrough rewrite 又返回 `{kind:"emit",frames:[frame]}` 再 spread 复制（`driver.ts:585-593`/`1032-1050`、`response-rewrite-adapters.ts:183-190`/`295-299`）。Anthropic 默认链最多六 rewrite，普通未改写帧也产一串短命对象。**注**：registry **非**每帧重 filter/sort（`driver.ts:500-503` 每 stream/attempt 只 assemble 一次，已确认），问题是高频分配+GC。**若做**：最常见单帧 passthrough 加零分配 fast path（独立 `pass` action / scalar frame 通道），只有真产 0/多帧才升数组，保 buffer/flush 语义不变。
- **为何暂缓（整簇）**：均为每帧微优化，单条量小、但高频/长流累积放大且共享主线程；宜攒批一次改动 + 一次 review，避免散点 churn。发现方：热路径性能审计（GPT reviewer，2026-07-14）。

## Anthropic 请求准备每 attempt 深拷贝大字段（MEDIUM）

- **根因**：`buildWirePayload`（`request-preparation.ts:538-572`）对 `DEEP_CLONE_FIELDS`（messages/system/tools/output_config/thinking）逐个 `structuredClone`，且该 `Set` 在函数内每次重建（`:562`）。Claude Code 常见请求 ~2MB，retry 重跑 preparation 按 attempt 数重复；仓库 profiling 记录该 clone ~4.5ms/请求。
- **当前行为**：同步阻塞事件循环、增加当前请求 dispatch 前延迟。**复核确认**：`:551-561` 注释解释深拷贝**必要性**——防 prepare-time mutate-in-place transform（applyCacheControlMode/stripServerTools/clampEffortLevel/adjustThinkingBudget 等）泄漏回 caller payload、跨 retry 累积损失，**故不能简单删**。
- **理想架构**：prepare pipeline 改 copy-on-write / persistent update——顶层浅拷贝，仅当某 transform 确实修改对应分支时才克隆该分支，同一 attempt 内多 transform 共享已 owned 分支。至少把 `DEEP_CLONE_FIELDS` hoist 到模块级（主要收益仍来自消除未修改大字段的深拷贝）。
- **为何暂缓**：copy-on-write 重排触及所有 mutate-in-place transform 的所有权契约，需逐个核实哪些真改写、哪些只读，属独立正确性敏感重构；Set hoist 可顺手先做。发现方：热路径性能审计（GPT reviewer，2026-07-14）+ 主线复核。

## keepalive 锚点注入器与 block-level flush 的帧序错乱（MEDIUM，gated on 两特性同开）

- **根因**：`empty_text` 锚点注入器 `makeSyntheticAnchorInjector`（`keepalive-anchor.ts:159-194`）是 async，内部先 sync-flip `injected`+`anchorBlockOpen`、再 `await sink.writeAnchor(startFrame)`（`:170`）、再 `await sink.writeKeepalive(deltaFrame)`（`:171`）——**两个 await 之间非原子**。buffered-retry 的 commit-boundary flush（`driver.ts` block-level flush）能在该 await 间隙推进、按 `anchorBlockOpen=true` 快照同步 enqueue flush 帧。`suspendHeartbeat` 只 flip flag 拦「新 tick」，**拦不住一个已从上一 tick 派发、await 仍 pending 的 injector 调用**。
- **当前行为（已裁 MED、gated）**：**复核修正 reviewer 机制描述**——reviewer 原称「stop@0 早于 start@0、关闭未打开的块」**不准确**：读 `makeSerializer`（`client-sink.ts:121-130`）`enqueue(fn)` 在**调用瞬间同步**排入串行链，而 `await sink.writeAnchor(startFrame)` 的**函数调用先于 await 求值**，故 startFrame 必先于 flush 的 stopFrame 排定链上位置。真实错乱形态是 injector 的**尾帧 `deltaFrame@0` 迟到落到 flush 帧之后**（非「stop 早于 start」），块结构破坏形态更轻。触发前提 = 两 gated 特性（`empty_text` 锚点 + block-level buffered-retry）同开 + 慢 sink.write 放大 await 窗口；据 MEMORY 两者默认 OFF，故 blast radius 受限，定 MED 非 HIGH。
- **理想架构**：给 injector 与 commit flush 加真正互斥——让「message_start + startFrame + deltaFrame」三帧作为**单个不可分割的 serializer fn**（单个 enqueue 内顺序 send、中途不 await 让出），确保 `anchorBlockOpen` 置真的同一刻整个 anchor prelude 已在链上排定于任何后续 flush 帧之前；或让 commit-boundary flush 在写帧前 await 一个「anchor 结构写入完成」的 barrier promise。
- **为何暂缓**：两特性默认关、触发窗口窄；修复触及 injector↔driver flush 两条独立 promise 链的协调协议，宜单独一次改动 + 按 `empirical-verification` 纪律写最小复现探针（慢 sink.write + 缓冲期 tick + 紧接 commit boundary，断言 wire 序 anchor prelude 三帧连续、先于 flush 帧）。发现方：热路径并发审计（Claude reviewer，2026-07-14）+ 主线复核修正。

## http2 abort listener 跨 retry 累积（LOW，噪声告警）

- **根因**：`http2-client.ts:478` 的 `signal.addEventListener("abort", () => req.close(...), { once: true })` 在每次 response handler 内注册但**永不 removeEventListener**（对比 `:485` 的 `onPreResponseAbort` 在 `req.once("error")` 时被清理）。同一请求的 ctx abort signal 跨 retry attempt 复用，每个「收到响应头后失败被重试」的 attempt（400/429 走 reactive retry）都在共享 signal 上累加一个 listener。
- **当前行为（已核实）**：learning-retry 上限 32（`driver.ts:468`），单请求最多累积 ~32 个 abort listener → 超 Node/Bun 默认 maxListeners=10 → 触发 `MaxListenersExceededWarning`（噪声，掩盖真实 listener 泄漏排查）；abort 真触发时 N 个 listener 各对已多为 closed 的 req 调 close()，**无害但冗余**（`{once:true}` 未触发时不自动移除）。
- **理想架构 / 若做需改什么**：把 `:478` 的 listener 纳入 response 完成/错误时的清理（类似 `:404` 对 `onPreResponseAbort` 的 removeEventListener），或改用绑定到本次 `req` 生命周期的派生 AbortSignal 而非直接挂长命 ctx signal。**易修**。发现方：热路径并发审计（Claude reviewer，2026-07-14）+ 主线复核确认。

## rate-limiter `lastRequestTime` 跨 loop 竞写（LOW，仅 pacing 近似、非 bug）

- **根因**：`adaptive-rate-limiter.ts:265`（`executeInRecoveringMode` 写 `lastRequestTime=slotStart`）与 `:475`（`processQueue` 写 `lastRequestTime=Date.now()`）在「429 队列 drain 未完 + mode 已翻 recovering（driver `:452-457` 自承 drain 与 recovering 并存）+ 新请求进 recovering」三者并发时**互相覆盖同一 `lastRequestTime`**。
- **当前行为（已核实无害）**：仅 pacing 计算被扰动（recovering 预约的未来 slotStart 被 processQueue 的 now 覆盖或反之）；真正的漏桶闸门 `recoveringNextAvailableAt` 不被 processQueue 触碰，故**无双发/丢更新、无正确性或数据损坏**。
- **理想架构 / 若做需改什么**：processQueue 与 recovering 预约各用独立 last-fire 时间戳；或在注释显式记为「已知 pacing 近似、非 bug」（当前注释只解释 `lastRequestTime` 语义、未点明跨 loop 竞写）。发现方：热路径并发审计（Claude reviewer，2026-07-14）。

## 【建议·非缺陷】response hook 逐帧读取导致帧级版本偏斜（backlog，需用户权衡）

- **现状**：`driver.ts:568` `getUpstreamHook()` 响应流每帧重新读 module-global hook；若 hook 流中途热重载，同一响应相邻帧用不同 hook 版本。hook 是 dev/test 特性（mock/拦截/录制回放），生产默认无 hook（返回 undefined），帧级重读本为让热重载生效而设计。仅「流进行中恰好热重载 hook」的开发调试场景产生跨帧不一致，**无生产正确性影响**。
- **若做需改什么**：如需严格性，可在 `runResponse` 入口对 hook 取一次快照供整个流使用（与 `:532` 对 origin tag 的「读一次」对称），代价是牺牲流中途热重载生效能力。需用户权衡（严格一致 vs 热重载即时生效），先记 backlog。发现方：热路径并发审计（Claude reviewer 主观建议，2026-07-14）。

## History 侧 resolveResponseToolNames 对恢复的 tool_use 同样漏名（LOW，当前无消费者）

- **根因**：`entry-view.ts:100` 的 `resolveResponseToolNames` 与完成行同源，读 `finalUpstreamResponse().body`（upstream-original 轨）。tool-call 恢复场景该轨按 Option A 只存降级文本、无 tool_use 块，故返回 `[]`——与本次修复前完成行的「裸 tool_use」同因。
- **当前行为**：grep 全仓 `resolveResponseToolNames` 仅定义处、无生产消费者，故**当前无活跃 bug**。本次（2026-07-14）已修复完成行 TUI 侧：经 `recordFeature("tool-call-recovered", { tools })` feature detail 旁路传名 + `resolveCompletionToolNames` fallback。
- **理想架构 / 若做需改什么**：若未来 History Web UI（ui-v4）要展示 `tool_use(<names>)` token，会复现同一症状。**关键前置**：TUI 侧的名字来自 bus 实时 feature detail，而 `recordFeature` 不落 history（持久化诊断走 `pipelineInfo`，见 [[methodology-plan-verify-interface-location-and-wiring-channel]]）——故 History 侧要 fallback，须先把 recovered names 落到某个持久化通道（如 pipelineInfo 或专用列），再让 `resolveResponseToolNames` 消费。不是简单加 fallback 分支。
- **为何暂缓**：无活跃消费者、纯前瞻；且真做需先建持久化通道（独立于本次 TUI 修复）。发现方：本次修复的 reviewer 建议（Claude reviewer，2026-07-14）。

## HTTP 级真两跳 e2e：翻译型 /responses 早 message_start + 长静默（2026-07-14 记，reviewer 建议）

- **根因 / 现状**：[live-reconcile-collision-e2e.test.ts](../../tests/pipeline/live-reconcile-collision-e2e.test.ts) 的「早 message_start + reasoning 静默 → 恰一个 message_start」回归用 **identity codec** 且直接注入 Anthropic `message_start` 作 upstream head，隔离了被修的 reconcile/injector 协调逻辑,但**未走真实 Responses→CC→Anthropic 两跳 translator**。
- **当前行为**：修复正确、覆盖充分——reconcile 逻辑由 unit + 该 e2e（含 fix-stash 正样本对照）完整覆盖;承重假设「真两跳会早转发 message_start」**双证**:①代码接线确证 [cc-to-anthropic-stream.ts:142](../../src/lib/openai/translate/cc-to-anthropic-stream.ts#L142)（首个上游 chunk 惰性发 message_start）+ translate-leg sink 经 `liveReconcilingSink`（[handler-v4.ts:1421](../../src/routes/messages/handler-v4.ts#L1421)）;②生产 History 实证（req_1784035548020_524 / _564 / _719）。故非活跃缺陷。
- **理想架构 / 若做需改什么**：加一个 HTTP 级 e2e——真实 Responses 帧 `response.created → 静默 → output frames → response.completed` 走实际 `@responses` 翻译路由,从客户端 SSE wire 经 Anthropic SDK decoder + 完整 frame-order oracle 断言「早 envelope + 长静默 + resumed block」完整序列且恰一个 `message_start`。
- **为何暂缓**：属冗余守护（承重假设已代码+生产双证、非轶事）;价值在防未来 translator 事件顺序/flush 变更绕过 identity-codec e2e,非修当前缺陷。发现方：本次修复 reviewer 建议（GPT + Claude reviewer,2026-07-14）。

## 流式交错并行 tool-call 产出非法 Anthropic block 序列（MEDIUM，评审 #1，2026-07-14 记）

- **根因**：[cc-to-anthropic-stream.ts:244-256](../../src/lib/openai/translate/cc-to-anthropic-stream.ts#L244) 的 LIVE 流式翻译器按上游到达顺序逐帧发 `input_json_delta`。当两个 tool 的 argument delta **交错**到达（tool0-start, tool1-start, tool0-args, tool1-args…），代码对**已 `content_block_stop` 的块**再发 `content_block_delta` 且无法重开 → 违反 Anthropic「一块 start→delta*→stop 后不可重开」协议，@anthropic-ai/sdk 可能拒收或错误累积。代码作者注释（`:247-249`）已自认此路径坏、赌「well-formed OpenAI stream 永不交错」。
- **当前行为（实测确认）**：用 producer wire-oracle 复现（[cc-to-anthropic-stream.unit.test.ts](../../tests/openai/cc-to-anthropic-stream.unit.test.ts) 的 `test.todo` "interleaved tool args…"，交错输入下 illegal deltas 非空）。**是否真触发未证**——赌注（GHC 是否真交错吐 tool 参数）无实测背书；CC/Responses wire 用 `index`/`item_id` 恰是为**允许**交错。
- **理想架构 / 若做需改什么**：在 commit 边界**从累加器重渲染** tool_use 块（累加器已按 index 聚齐完整 arguments），每块原子 `start→delta→stop` 连续发出，绕开上游到达顺序。这正是「缓冲提交点从累加器渲染」大改的一部分（与 reasoning 透传同源的「翻译腿从累加器渲染」方向）——一次建成、三档 commit 粒度共用。live 模式的小修是逐 index 缓冲 args 到块完成再发。
- **为何暂缓**：属独立于 reasoning 特性的既有 bug；正确修法是结构性大改（≥RFC 量级）；且触发条件待真 GHC 探针确认。发现方：GPT reviewer（2026-07-14，异模型独有发现，Claude reviewer 漏），主线核码 + producer wire-oracle 复现确认。

## reasoning 透传：low-effort 无 summary 时 encrypted reasoning 跨轮丢失（LOW，2026-07-14 记）

> ⚠️ **架构注记（2026-07-14）**：本条描述的 reasoning 透传实现走 **CC 中转 side-channel accommodation**，被 (anthropic↔responses) **直连映射**取代中（见 [anthropic-responses-direct-mapping-handoff.md](anthropic-responses-direct-mapping-handoff.md)）。直连落地后本条应在直连路径重新评估（`encrypted_content` 的承载与回传由直连 A 响应侧处理，见 handoff §13 单向展示定性）——不要在 CC 旁路上继续填坑。

- **根因 / 现状**：reasoning 透传（landed 2026-07-14）在 GHC 返回**空 summary**时（实测：low effort 即使请求 `summary:"auto"` 也可能无 summary，见 exp/synthetic-reasoning-summary-shape）不产 thinking 块——graceful 缺席正确。但此时 reasoning item 的 `encrypted_content` 非空却**无处承载**（没有 thinking 块可挂 signature），故该轮的 encrypted reasoning 不进跨轮 round-trip。
- **当前行为**：无 summary → 客户端不显示 reasoning（合理）、encrypted_content 被丢（次优）。有 summary → 全链路正常（thinking 块 + encrypted 封进 signature 往返）。
- **理想架构 / 若做需改什么**：若要「即使无 summary 也保 encrypted 跨轮」，可在无 summary 但有 encrypted 时产一个**空文本 thinking 块**只承载 signature 载荷——但需先探针确认 @anthropic-ai/sdk 接受空 thinking 文本 + 非空 signature 的块（probe ① 只证了非空文本），且 Anthropic 协议是否允许空 thinking。或改用独立 sidecar 存 encrypted（不走 thinking 块）。
- **为何暂缓**：仅 low-effort 边角、且 encrypted 本不可显示（丢的是 round-trip 能力非可见内容）；真做需额外探针。发现方：reasoning 透传探针 ②③（2026-07-14）。

## history/telemetry 拆独立持久化服务（架构选项，2026-07-14 优雅重启设计时评估）

- **根因 / 现状**：优雅重启（`docs/lifecycle.md`「优雅重启」节）的 overlap 窗口里新旧两进程同时写 history.db / telemetry.db。当前方案靠**靶向修**消除隐患——① reclaim-orphan 排除 live 前任 ② 旧进程 drain 期停遥测 persist timer ③ WAL + busy_timeout 串行化两写者。持久化仍是**进程内嵌入式**（同进程 await 保证 never-lose-settle）。
- **当前行为**：单进程代际交替下，overlap 写竞争有界（旧进程降级后只剩个位数在途 finalize + 新进程新写）、罕见、可被 SQLite WAL 正确串行化。读侧（`/history/api/*`、`/api/status`、`/metrics`、WS 实时推送）全是进程内同步读。
- **理想架构 / 若做需改什么**：把 history/telemetry 抽成常驻独立服务 → 单写者、跨重启常驻、reclaim-orphan 逻辑作废。但需：给富且演进的 payload（zstd blob / 内容寻址 search_index / 异步两相 finalize / DDSketch）定义 IPC wire 协议；把「同进程 await 的 never-lose-settle 不变量」重做成分布式投递协议（背压 / 缓冲 / at-least-once）；读侧端点全部跨界或端进服务。真走到这步，正确的问法是「是否直接换 client-server DB（Postgres）」。
- **为何暂缓**：本项目是单用户内部工具、并发仅「运维偶尔重启一次」，为有界罕见问题引常驻 sidecar + IPC 是过度工程；靶向修已治根因。**触发条件（满足才值得重做）**：① 转向多进程 / 多 worker 常驻并发 serving（不再是单进程代际交替）；② 持久化延迟 / 背压开始阻塞请求 serving（in-process 写变热路径瓶颈）；③ history/telemetry 体量长出 SQLite、本就要迁 client-server DB——那时顺势做 persistence-as-a-service 才自然。

## SOCKS `session_connect_timeout=0` 跨字段校验只在单次 parse 内生效，跨 YAML 层可漏检（LOW，2026-07-14 记，B8 附带发现）

- **根因 / 现状**：`docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md` Task 3 附加范围新增 `ConfigSchema` 顶层 `.superRefine()`，在同一次 `ConfigSchema.safeParse()` 里检测「`proxy` 是 SOCKS + `session_connect_timeout === 0`」并拒绝。但 `loadBundledDefaultConfig()` 与 `loadRawConfigFile()`（[config.ts:418](../../src/lib/config/config.ts#L418)）各自独立调用 `validateConfig()`，之后才用 `mergeBySchema()` 合并两个已经分别验证过的 `Config` 对象——跨字段校验看不到合并后的 effective config。
- **当前行为**：现实路径（用户在同一个 `config.yaml` 里同时写 `proxy` 和 `upstream_transport.http2.session_connect_timeout`，或经 PUT `/api/config` 一次性提交两者）完全被覆盖，因为两个字段确实在同一次 `safeParse()` 内。只有把 `proxy` 放进一层、把 `session_connect_timeout: 0` 放进另一层（bundled vs user 分裂）才会漏检——且 bundled `config.yaml` 从不出货显式 `0`（默认是正数 10）、`proxy` 又几乎总是用户覆盖层独有，这个组合在实践中概率极低。
- **理想架构 / 若做需改什么**：在 `mergeBySchema()` 产出 effective config 之后，对合并结果**再跑一次** `ConfigSchema` 级别的跨字段校验（或至少重跑本条 superRefine），需要新增一个「合并后二次校验」的调用点，并想清楚二次校验失败时的降级策略（此时已经没有「stripped 用默认值重来」的简单退路，因为两层都已经算"验证通过"）。
- **为何暂缓**：本条是 B8 实现过程中顺带发现的架构缝隙，不是 B8 本身要求的验收范围（B8 只要求"配 SOCKS 时 validation 拒绝 0"，同层内已完整满足）；触发条件是「bundled 与用户配置分裂持有这两个字段」这一现实中基本不出现的组合，为此新增合并后二次校验层是过度工程。**触发条件（满足才值得做）**：项目引入多层配置来源（例如按环境分层的多个 YAML 文件，而不仅是 bundled+单一用户覆盖）、或 schema 上出现更多类似的高价值跨字段约束，值得一次性建「合并后校验」机制而非逐条特殊处理。发现方：本 planner 在 B8（transport-config-reorg plan 修正）落 SOCKS 校验时的架构核实。

## client.outbound 全量 sink-egress 统一化（2026-07-14，RFC symmetric-4-point Phase 6 部分实现）

- **现状**：`client.outbound` hook 已接线在 driver `renderFrames`（S6 render→yield，`driver.ts`），覆盖 `codec.renderResponse` 产出的**渲染帧**——per-frame 改写/丢弃可用（RFC §5，`hooks/types.ts` 有 cardinality + 覆盖注释）。
- **根因 / 当前行为**：`renderFrames` 的 yield 点**看不到 sink 层注入的合成/心跳/anchor 帧**（`client-sink.ts` 的 `writeSynthetic`/`writeAnchor`/heartbeat ping 不经此点），也看不到 Gemini 整流翻译器 / Anthropic timer heartbeat（`renderFrames` 注释是 load-bearing 约束——这些是 byte-critical 风险被历史决策推迟的）。故 client.outbound 有一个**已知、接受**的覆盖缺口：只覆盖渲染帧，不覆盖 sink 合成/心跳帧（继承 `hook-rewrite` 的 §9 forwarded-标记覆盖缺口）。
- **理想架构**：把所有 client 帧（渲染帧 + sink 合成/心跳/anchor 帧）汇聚到单一可挂载的 **sink write 串行层**，让 client.outbound 见全量 client 字节 + 统一 forwarded-轨 provenance 标记。这是 byte-critical 重构（`renderFrames` 注释明言推迟过）。
- **为何暂缓**：需求方拍板「client.outbound 语义/接线首版到位、full sink-egress 统一化晚做」；reviewer MEDIUM-2 标为 byte-critical 风险、须独立谨慎推进。
- **若做需改什么**：统一 sink egress choke point（`client-sink.ts` makeSseSink/makeArraySink 的 write 串行层）+ 把 renderFrames 的 client.outbound 挂载迁到该层 + synthetic/heartbeat 帧的 provenance 标记 + 四格式 render 腿（Gemini 整流/Anthropic heartbeat）的交互复验 + golden 字节等价预捕。

## responses/gemini 无 system/instructions 时 route 层不 reload config（既有行为，verifier LOW，2026-07-15）

- **现状**：四格式 async 入站下沉后（RFC symmetric-4-point Phase 3），config-freshness 前置按「parse 是否读 config 态」分治：cc route 无条件 `applyConfigToState`、anthropic route `if(payload.system)`、responses/gemini route **不加**。
- **根因 / 当前行为**：`processResponsesInstructions`/`processAnthropicSystem` 在 system/instructions 空时**早返回、不触发 applyConfigToState**。而 responses `parseOpenAiResponses` 读 config-managed 态（`state.normalizeResponsesCallIds`、`buildResponsesToolNameMapper`→`state.sanitizeToolNames`），parse 在 translateInbound 之前跑——故**当请求无 instructions 时，本请求的 parse 用的是上次某请求 reload 后的 config 值**（若期间 config.yaml 被编辑则陈旧）。**这是旧代码的精确保真复刻**（旧 `processResponsesInstructions` 同样只在 instructions 存在时 reload），**非本次重构引入的新 bug**——verifier 判 LOW、行为等价、不阻塞合并。
- **理想架构**：config-freshness 是 per-request 的 route lifecycle 关注点，应与「注入是否发生」解耦——route 层**无条件** `await applyConfigToState()`（所有格式统一），使 parse 永远见新鲜 config。**为何暂缓**：responses/gemini 无条件 reload 曾打爆 call-id-normalization/WS 测（它们设 config 态 + 发无 instructions 请求，reload 重置了测试设的态）——统一前须先修那些测试的隔离方式（用 config 文件驱动而非 state setter），是独立工作。
- **若做需改什么**：四 route 统一无条件 `applyConfigToState()` before runRequest（删条件）；修 `tests/responses/*` 里靠 state setter 设 config 态又发无 instructions 请求的测试（改 config 文件驱动 / 或接受 reload）；核 gemini 同理。
## 三层降温归档 · 长跑服务器 tier-1 无界增长（O3，MEDIUM，2026-07-14 记）

- **根因 / 现状**：T1→T2 封存（`tier2-seal.ts` `startTier2Seal`）**仅启动时触发一次**（用户裁定：封存是昂贵的 Parquet-级重编码，不进周期 tick）。若服务长期不重启，`archive.db`（tier-1）撞 `tier1_size_cap`（默认 2GB）后**无运行期封存触发点**，tier-1 会持续增长。
- **当前行为**：由运行期 `consola.warn`（`tier2_warn_count`/`tier2_warn_bytes` 同机制）提示用户重启/手动。数据不丢（只是 tier-1 变大、ATTACH 查询变慢）。
- **理想架构 / 若做需改什么**：把「archive.db > tier1_size_cap」也作为**运行期触发点**——在 reaper tick（`runReaperTick`）里加一个轻量 size 检查，超限时后台 `runTier2SealOnce()`（一次封存一个 session、非阻塞）。需想清楚封存的 CPU/IO 成本在周期 tick 里的节流（不能每 tick 都全量封存）。
- **为何暂缓**：用户明确选「T1→T2 仅启动时」作为初始触发策略；周期封存是 nice-to-have，不阻塞核心「永不真删 + 高压缩」诉求。**触发条件（满足才值得做）**：出现长跑（数周不重启）+ tier-1 实测显著膨胀影响归档视图查询延迟的真实案例。发现方：spec 2026-07-14-history-tiered-archive §8-O3 设计阶段预留。

## 三层降温归档 · tier-2 深度搜索粒度（O4，LOW，2026-07-14 记）

- **根因 / 现状**：归档视图深度搜索（`/history/api/search?tier=archive`）对 **tier-1（archive.entries_v2）** 走完整五 facet 内容寻址搜索；对 **tier-2（封存冷单元）** 只以 `tier2_manifest.preview_text` 粒度参与（封存时未在 manifest 建 msg_blob/req_aux 级搜索文本）。
- **当前行为**：tier-2 条目可按 preview_text 子串命中，但不支持 rewrites/headers 等 facet 的逐字节深搜。
- **理想架构 / 若做需改什么**：封存时在 `tier2_manifest` 旁建一张 tier-2 专用的 flat 搜索文本表（或把 msg_blob/req_aux 文本也冗余进 manifest），使 tier-2 也支持五 facet；或封存单元内保留可搜文本。
- **为何暂缓**：tier-2 是最深冷层、访问罕见，preview_text 粒度对冷数据检索够用；全 facet 冷索引是额外存储 + 复杂度。**触发条件**：出现「需要对已封存冷数据做 header/rewrite 级精确搜索」的真实运维需求。发现方：spec §8-O4。

## 三层降温归档 · archive.db 独立迁移账本追不上 HOT 的时序缝（HIGH，2026-07-14 合并态评审发现，MIGRATIONS 首条前必解）

- **根因 / 现状**：archive.db 跑**独立** `applyForwardMigrations`（自己的 `history_meta.schema_migrations` 账本），且在 `startHistoryBackfills` 里**异步**触发（`migrateArchiveDb()`），而 HOT 侧 `initHistory` 同步 attach archive + 启动 reaper。当前 `MIGRATIONS=[]`（floor 覆盖全列）故两库总同构、无风险。但一旦 `MIGRATIONS` 迎来第一条真实 001+ 迁移：从 initHistory 到 archive `migrateArchiveDb()` resolve 之间有个窗口，reaper 周期 tick 可能在 archive 尚未跑完自己的 001+ 迁移时就触发 move → archive 缺列。
- **当前行为（已缓解，非崩溃）**：`migrateEntriesToTier1` 的**批次级 `archiveSchemaCovers` 前置校验**（2026-07-14 治 reviewer BLOCKER-3 时加）会检测「main 列 ⊄ archive 列」并**整批跳过 + 一次告警**「archive schema behind HOT — migration paused」，fail-closed 不丢数据、可观测。所以时序窗口期间是「搬迁暂停直到 archive 追上」，而非「per-entry 崩溃 / 数据丢失」。
- **理想架构 / 若做需改什么**：要么 `initHistory` 的 `ensureArchiveAttachedToMain` 之后紧跟 `await migrateArchiveDb()`（对齐 HOT 侧「先迁移完成再起 reaper」纪律，`start.ts` 就这么做）；要么给 `isArchiveAttached`/`runTier1MigrationOnce` 前加「archive schema 版本已追上」门控（仿 `search_index_version` 的 history_meta 守卫）。
- **为何暂缓**：当前 `MIGRATIONS=[]` 无风险，且批次前置校验已把最坏情况降级为可观测的「暂停」。**触发条件（必解）**：给 archive 加**第一条真实 001+ 迁移前**必须先接线时序（否则首次迁移期间归档暂停、tier-1 可能短暂膨胀）。发现方：合并态评审 HIGH-1（reviewer 实测确认当前无害、预警将来）。

## via-responses（openai-cc/gemini→responses）reasoning encrypted_content 仍捕 `.added` 中间态而非 `.done` 权威版（LOW，2026-07-16，Phase 5 checkpoint 记）

- **根因 / 现状**：`responses-to-cc-stream.ts:58-64` 的 `response.output_item.added` 分支捕获 reasoning item 的 `encrypted_content` 并塞进 CC-intermediate 的 `delta.reasoning_encrypted_content`。Phase 0 实测（`exp/anthropic-responses-direct/FINDINGS.md` 探针 a）证实同一 reasoning item 的 `encrypted_content` 在 `.added`（中间态）与 `.done`（权威定稿版）之间**不同 blob**（enc_len 1600 vs 1684，不同 id）——`.added` 只是过程中的临时快照。anthropic↔responses 直接桥（Phase 3 `responses-to-anthropic-stream.ts`）已修正为只捕 `.done`；但这个**旧 CC-intermediate 路径**（`createStreamTranslator`/`createResponsesToCcFrameRenderer`，`hub-translate.ts:371`）**仍是活路径**——供 `(openai-cc, /responses)` 与 `(gemini, /responses)` 的 via-responses 转发使用（direct 桥只接管了 `(anthropic, /responses)` 这一对，未触及这两条）。
- **当前行为**：openai-cc/gemini 客户端经 via-responses 拿到的 reasoning encrypted_content 是**中间态快照**而非定稿版——若这个值将来被下游用于跨轮回喂续接（当前 CC-intermediate 路径本身不做 round-trip，只透传展示），可能因非权威版导致续接失败或不一致。
- **理想架构 / 若做需改什么**：参照 anthropic↔responses 直接桥的修法——把 `responses-to-cc-stream.ts` 的捕获点从 `response.output_item.added` 挪到 `response.output_item.done`（同 `responses-to-anthropic-stream.ts:262-267` 的判定逻辑：`event.item.type === "reasoning" && typeof encrypted_content === "string" && length > 0`）。
- **为何暂缓**：出 anthropic↔responses 直接桥 RFC 范围（该 RFC 只覆盖 `(anthropic, responses)` 一对，openai-cc/gemini↔responses 的 CC-intermediate 路径是另一条独立债务）；Phase 5 的任务边界是 anthropic↔responses 的 reasoning round-trip，不含这条旧路径的修复。**触发条件（值得做）**：openai-cc/gemini via-responses 的 reasoning encrypted_content 出现被下游消费用于回喂续接的真实需求（当前它只是展示用途，尚无回喂消费点）；或该债务被合并进未来 gemini/openai-cc↔responses 直接桥项目（RFC §10 提到的推迟债务）时一并解决。发现方：Phase 5 checkpoint 核实（协调者裁定记录，2026-07-16）。

## 反向 server-tool 请求侧透传（openai-responses 客户端声明 web_search → Claude 模型）未做（Phase 6，2026-07-16 记）

- **根因 / 现状**：Phase 6 只做了**前向**（anthropic 客户端 → responses 模型）server-tool 请求侧透传（`SERVER_TOOL_MAPPING`，`anthropic-to-responses-request.ts`）+ 响应侧降级（`web_search_call`→text）。**反向**（openai-responses 客户端声明 `web_search`/`file_search`/`code_interpreter` → Claude `@messages` 模型）的请求侧仍走 `responses-to-anthropic-request.ts:translateTools` 的"非 function 类型一律丢弃+warn"通用逻辑（`tool.type !== "function"` → drop），未做对称映射（Responses builtin tool → Anthropic 对应 server tool 声明）。
- **为何未做（非拖延，是不对称性）**：反向与前向**不对称、不能无脑镜像**——① Phase 0 只探针了前向方向（anthropic web_search 声明 → responses 原生执行），未探反向（responses 客户端声明 web_search → Claude 是否原生执行、返回结果形状是什么）；② 更关键的物理不对称：**Claude 的 `web_search_tool_result` 结果块真带 `encrypted_content`**（真实服务端签名，ADR 2026-07-13 §Part-1 明确指出 server tool 结果通道的签名本质），这与前向方向"Responses `web_search_call` 无 encrypted_content、结果回显必须降级"的物理约束**完全相反**——反向方向理论上**可能有真密文可round-trip**（不像前向那样天然只能降级），但这**必须先实测验证**（Claude 结果格式、Responses 客户端能否/是否愿意携带一个它自己 schema 里没有字段存放的 opaque blob、real round-trip 可行性），不能凭前向经验想当然复制。
- **理想架构 / 若做需改什么**：Phase 0 式新探针——① Responses 客户端声明 `{type:"web_search"}`（或类似）请求 Claude `@messages` 模型，观察 Claude 上游是否原生执行 web_search（Claude 自己的 server tool 机制，与 Copilot Responses 的 web_search 完全是两套后端）；② 若原生执行，探 `server_tool_use`+`web_search_tool_result`（真 encrypted_content）渲染回 Responses `web_search_call` 形状是否可行、是否需要在 Responses 侧开新字段承载真密文（Responses `ResponsesWebSearchCallOutput` 目前无该字位）；③ 若探明可行，对称做请求侧映射表 + 响应侧 round-trip（而非前向那种降级）。
- **触发条件（值得做）**：出现 Responses 客户端（如 Codex）访问 Claude 模型且需要 web_search 能力的真实需求；或用户明确要求反向 server-tool 对等能力。发现方：Phase 6 checkpoint（协调者裁定记录，2026-07-16，明确指示"若可对称轻量落地就做、否则记 backlog，别硬塞、别想当然"）。

## via-responses (openai-cc/gemini→responses) 腿 web_search_call 静默丢弃

- **根因**：`responses-to-cc.ts` / `responses-conversion.ts`（Responses→CC 供 OpenAI-chat 客户端）遇上游 `web_search_call` 输出 item 直接不处理，搜索 query 静默蒸发（不像 anthropic↔responses 直接桥降级为可读 text）。
- **当前行为**：无消费者触发（via-responses 场景暂无 web_search 流量），故不阻断。
- **理想架构**：与直接桥的 `webSearchCallToText` 一致降级，保留 query/status（richest-data-flow）。
- **为何暂缓**：出 anthropic↔responses 直接桥 RFC 范围；属未来 gemini/openai-cc↔responses 直接桥项目的债。
- **若做需改什么**：`responses-to-cc.ts` 的 output-item 翻译补 web_search_call→CC 文本分支；对齐直接桥模板。
- 来源：Phase 6 收官审查建议（2026-07-15）。

## h2 `getSession` 的 `for(;;)` generation-race 重试无迭代上限（LOW，2026-07-14，transport 三轴重组 P4 合并态审查记）

- **根因 / 现状**：`src/lib/transport/http2-client.ts` 的 `getSession()` 用无界 `for(;;)` 做 generation-race 捕获-比较-丢弃-重试（在飞建连若 generation 已过期则关旧、`continue` 重连）。理论上一个每 tick 都触发的 reconcile storm 可让某 caller 永远重试。
- **当前行为**：不现实的饥饿——每次迭代含一次完整 TLS/proxy 建连（数十~数百 ms），且 reconcile 由人工 config 编辑驱动（非高频），自然被建连延迟限流。P4 合并态审查 reviewer 亲验判定「非必须修」。
- **理想架构 / 若做需改什么**：加一个宽松迭代上限（如 8 次）后 reject 一个可诊断错误，避免病态配置下的无限循环。注意会引入新失败模式（病态 config → reject vs 现在的无限 retry），需权衡。
- **为何暂缓**：饥饿不现实（被建连延迟自然限流）、reviewer 判非必须；引入迭代上限会新增「N 次后 reject」的失败语义。**触发条件（值得做）**：出现高频 config reload 或自动化 config 编辑场景使 reconcile storm 变现实。发现方：transport 三轴重组 P4 热重载 reconcile 合并态审查 nit-2（2026-07-14）。

## buffered-merge 的 open-item-at-terminal-failure verbatim 埋点未接（LOW，2026-07-19，buffered-merge 合并态审查记）

- **根因 / 现状**：`buffered-merge-reducer.ts` 的 `BufferedMergeDiag.verbatimFallbacks` 曾在类型里声明 `"open-item-at-terminal-failure"` 但全仓零 push（只 push `"retreat"`）。合并态审查（gpt reviewer）标为 LOW 死类型成员，已删除该未产出成员使类型诚实（`verbatimFallbacks: Array<"retreat">`）。
- **当前行为（正确、不缺失）**：终结失败态下**未闭合 item 的 delta 本就被保留 verbatim**——由构造保证：未闭合 item 从不进 `collected`，故 drop-delta 的 `closed` 判据永远 false、绝不碰它（spec §5.3.2 不变量天然成立）。缺的**只是这个 case 的独立诊断记录**，非行为缺陷。
- **理想架构 / 若做需改什么**：若要把「终结失败态保留了开放 item 的 delta」记成独立诊断值，需在 `BufferedFlushContext` 增一个失败态信号（现 `cause` 只有 `retreat`/`boundary`/`terminal-drain`，无 terminal-failure），并在 driver 失败 flush 点传入、reducer 据此 push。
- **为何暂缓**：纯观测增补、行为已正确；接线牵动 `BufferedFlushContext` 契约（跨 driver↔reducer）。**触发条件（值得做）**：运维需要按「失败态是否保留了半截 open item」审计归并行为时。发现方：buffered-merge 合并态审查 LOW-2（2026-07-19）。

## reaper-cancel history 两阶段协议（2026-07-20，spec 2026-07-20-synthetic-frame-forwarded-track-completeness §1.3）

- **现状（根因）**：reaper scan（`context/manager.ts:runReaperOnce`）对超时 ctx 先 `reapInFlight()` **再同步 `ctx.fail()`**——即 reaper 在 handler 的 delayed-commit catch 运行前已冻结 entry 并发布 `request.failed`。handler catch 的 reaper-cancel 腿（`handler-v4.ts:631-639`）里 `ctx.fail` 被 `settled` guard 去重成 no-op，其后 writeSynthetic 送上 wire 的 reaper error 帧**进不了那个已发布的瞬态 `request.failed` 事件**（durable V3 projection 仍会捕获，故仅瞬态视图缺）。
- **为何 Unit 1 缩减版重排无效**：Unit 1（`301e63b2`）的 `writeTerminalThenSettle` 重排（writeSynthetic→setForwarded→fail）对 handler 自 settle 的 timeout/HTTPError/unknown/reject 腿有效，但 reaper 腿的 entry 早被 reaper 冻结、handler 侧 setForwarded/fail 皆 no-op → 重排不改其瞬态快照。
- **理想架构（两阶段 reaper 协议）**：reaper 采「取消优先、settle 兜底」——reaper 只 `reapInFlight()`（触发取消信号），把 finalize/publish 推迟给 handler 的 catch（handler 收到取消后走正常 writeTerminalThenSettle 完成瞬态快照），仅当 handler 未接管（无 live consumer）时 reaper 才兜底 settle。触及 manager 的 settle 语义（cancel↔settle 解耦），属大重构。
- **为何暂缓**：durable history（getHistory）已完整（V3 generation recorder），仅 reaper-cancel 的**瞬态** `request.failed` 事件缺 error 帧——低频（仅超时被 reaper 收割）× 低价值（瞬态、立即被 durable projection 取代）。非数据丢失。
- **若做需改什么**：manager 的 reaper 从「reapInFlight+同步 fail」改为「reapInFlight + 推迟 settle（等 handler 接管或超时兜底）」；handler catch 的 reaper-cancel 腿改为走 writeTerminalThenSettle 完成快照；加瞬态事件断言测试（getBus 订阅 request.failed，reaper 场景下 entry 含 error 帧）。发现方：spec 2026-07-20 §1.3 + Unit 1 缩减版实施（2026-07-20）。

## ~~3 个既有测试失败（pre-existing）~~ ✅ 已修复（2026-07-20，`c6d3466e`）

- **失败清单**：`tests/pipeline/generation-runtime-baseline.http.test.ts`（P0-T1）、`tests/pipeline/hooks/reactive-retry-leg.it.test.ts`（Task 5.1）、`tests/pipeline/hooks/replay.it.test.ts`（Task 5.2）。
- **根因（两类，已修复）**：① Task 5.1/5.2 的 `getEntry` 返 undefined = V3 finalize 异步（deferred seal → generation finalizer → terminal-bus persist），测试 `finalizeModelOperationDelivery()` 后同步 `getEntry` 撞持久化 race → 补 `await ctx.whenModelOperationFinalized()`（对齐 `generation-recorder-lifecycle.unit` 既有模式）；② P0-T1 的 +3 `type` = `canonicalFrameValue` 对携 SseEventRecord 的 post-loop-flush 帧富化 derived `type`/`synthetic`（`request.ts:501-502`，`a4f4f20f`，V3 projection 消费），使 arena value 有意富于 wire，测试 `value==parseWire(wire)` oracle 过严 → 剥离非-wire 字段后比较。projection 读 `observation.type` 非 `value.type`，富化不影响真实输出（无功能 bug）。
- **归属**：三者在三单元改动前已失败（双方独立基线对照 `64f4d01d`），与 forwarded-track 完整性无关；根因是 History V3 迁移（`a4f4f20f` 等 2026-07-18 V2-removal）后测试未同步。已随本次会话一并修复。


## 测试分档遗留：2 个 flaky perf 测试 + fast 档若干真 SQLite 单元测试（LOW，2026-07-20，测试按速度分档 Task 4）

- **flaky perf 测试（2 个）**：`tests/transport/h2-keepalive-ping.unit.test.ts`（「pings on the given cadence until cleared」）、`tests/history/v3/canonical-performance.unit.test.ts`（「capture cost follows new work rather than growing superlinearly」）。隔离连跑时好时坏（0/1/0、0/1/1 fail），时序/性能型、pre-existing 于 master、且落在活跃 peer 区（V3 有独立 worktree）。与分档正交、非本次引入。
  - **为何暂缓**：属独立的 flaky 稳定化课题（fake timers + 放宽性能阈值/连跑取 median），硬修会与 peer 的 V3/transport worktree 冲突。**触发条件（值得做）**：这两块 landed 稳定后，单独一轮 flaky 稳定化（连跑 25 次确认确定性、fake timers 掉真 setTimeout、perf 阈值改相对 median）。验收 §10 因此改读「fast 档绿 modulo 这 2 个 backlogged flaky」。
- **fast 档若干真 SQLite/fs 单元测试偏慢**：`tests/telemetry/{migrate-json,cumulative-cap-authority,dual-write,backfill-wiring}.unit.test.ts`、`tests/history/state-shutdown.unit.test.ts` 等做真 SQLite/临时文件 I/O（各 ~1.9-5s，但每测快 0.3-0.7s/test）。**未重分类为 .it**——它们是持久化原语的单元测试（临时 db 是被测单元本身，如 `atomic-fs.unit` 测的就是 fs），与全站既有约定一致；「只要慢就改 .it」会与既有 .unit telemetry 测试不一致、属过度应用（reviewer 明训）。
  - **理想架构 / 若做需改什么**：若要进一步压 fast 档，可给「持久化原语单元测试」引入 in-memory SQLite（`:memory:`）替临时文件 db，或抽一个 `.unit` 内的 fake 持久化层。需全站统一（不能只改这几个）。**触发条件（值得做）**：fast 档整体耗时成为痛点、或决定持久化单元测试统一走 in-memory。发现方：测试按速度分档 Task 4 慢离群审查（2026-07-20）。
- **rate-limiter/shutdown 用真 setTimeout**：`tests/shutdown/rate-limiter.unit.test.ts`（2.76s/28t）、`shutdown.unit.test.ts`（1.9s/50t）用真定时器等待。纯逻辑（非 I/O）→ 守真相域留 .unit。可用 fake timers 提速（根因修非症状），但牵动这些测试的时序假设、需谨慎。**触发条件**：同上 fast 档提速专项。

## 上游传输可观测子系统 — 子项目 2：连接/会话级可观测（2026-07-14，transport-observability 分解）

- **根因 / 现状**：`src/lib/transport/` 全树结构化可观测 ≈ 0（仅 2 处 consola）。连接级信号——GOAWAY（lastStreamID/errorCode/debugData，判别「连接级 drain / GHC 边缘回收 A 类」的最强信号）、PING ack RTT / unack 计数（连接健康直接指标）、session 建关/pool 命中/存活时长——**全被丢弃**：`session.on("goaway", removeFromPool)` 不记日志不进 history，`scheduleH2KeepalivePing` 的 ack 是 `NOOP_PING_ACK`。
- **当前行为**：截断/断流只能看到泛型日志，无法从信号判别是 A（连接级/中间设备回收，GOAWAY 在场）还是 B（单流应用层 idle，无 GOAWAY、连接仍活）。
- **理想架构 / 若做需改什么**：把连接/会话生命周期做成一等结构化事件（进 observability bus + 结构化日志 + /metrics）。**承重难题＝多路复用池化 session 的 request 关联**（一条 h2 session 被多并发 request 共享，GOAWAY/PING/session-close 非 1:1 归属某 request）——候选解 A（correlation-id 穿透 + 连接级事件扇出到在途 request）/ B（两级模型读时关联）/ C（全事件上 bus + 投影分发），详见 [docs/todo/upstream-transport-observability.md](upstream-transport-observability.md) §5。
- **为何暂缓**：子项目 1（跨端点流终止归因统一，流级、per-request、不碰关联难题）先行独立交付；本片需先攻克多路复用关联模型（最硬），范围大，用户 2026-07-14 决定拆后做。**触发条件（值得做）**：子项目 1 落地后、需在真实数据上区分 A/B 截断归因时。详细设计草案（范围/维度/关联模型/surface）已冻结在 [upstream-transport-observability.md](upstream-transport-observability.md)。

## Bun HTTP/2 `end + rstCode=0` 能否区分 clean RST 与 END_STREAM（当前任务完成后专项调查，用户保持怀疑）

- **触发时点**：完成 [mandatory block delivery 与 HTTP/2 终止观测规格](../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md) 的实施、验收与文档收尾后，立即作为独立调查执行；不阻塞当前任务，也不得在当前任务内用未证启发式扩大范围。
- **当前已证事实**：应用层在已观察样本中可见 `end`、随后 `close`、`rstCode=0`，且 Responses 协议终止事件缺失。现有 Bun `node:http2` 路径未提供足以在应用层直接裁决“正常 END_STREAM”与“clean RST 被兼容层抹平”的独立信号。因此当前规格只记录原始事实与不可判状态，不把猜测持久化为根因。
- **用户保留意见**：用户对“无法进一步区分”保持怀疑，要求当前任务完成后仔细排查。该怀疑不是已解决结论，也不是允许当前实现猜测；它要求寻找更强 oracle。
- **调查问题**：① Bun runtime 内部是否保留但未暴露 RST／END_STREAM 差异；② `ClientHttp2Stream` 是否存在事件顺序、内部字段、诊断通道或 native handle 可可靠观测；③ Node 对照、TLS／HTTP2 帧级代理、GHC request-id 服务端日志能否提供独立 ground truth；④ 不同 RST code、`stream.close(0)`、`stream.destroy()`、正常 `end()` 在 Bun 各版本／Node 上的可重复行为矩阵；⑤ 若 Bun 是根因，最小上游修复或本项目可维护的 runtime patch 是什么。
- **实验纪律**：使用真 Node HTTP/2 server 与帧级 oracle，不能把 Bun server fixture 当协议真相；每个场景同时保存服务端动作、客户端事件全序、`rstCode`、session GOAWAY、raw frame 或 runtime trace。正反样本必须成对：正常 END_STREAM 与 clean RST 均能稳定复现，oracle 能区分两者后才能接受分类机制。
- **完成判据**：二选一并有实证。A：找到可靠、低开销且在生产 runtime 可用的区分信号，补 transport 分类、回归测试和 History 字段；B：证明当前 Bun 版本在可达 API／native trace 上确实丢失该信息，形成最小上游复现、版本范围与修复路径。只得到“代码看起来无法区分”或只跑单一坏样本不算完成。
- **与当前任务的边界**：当前任务先实现 dispatch-scoped first-terminal snapshot、GOAWAY evidence 与诚实的 `indeterminate` 分类；专项调查若找到新 oracle，再以新增事实升级分类，不回写或伪造旧记录。

## 上游传输可观测子系统 — 子项目 3：history transportTrace 字段 + ui-v4 Transport 段（2026-07-14，transport-observability 分解；2026-07-22 更新：metrics 已归子项目 1）

- **根因 / 现状**：子项目 1/2 产出的传输事件目前无结构化落盘/聚合/展示宿主。history entry 无「传输因果链」字段（connect→session→stream→truncation→retry），/metrics 无传输维度（GOAWAY 速率 / PING RTT histogram / truncation A/B/success 计数 / per-origin session gauge），ui-v4 History 详情无 Transport 段。
- **当前行为**：单请求事后取证只能读散落日志 + 解 blob 反推，无「打开一条 entry 看全传输因果链」。
- **理想架构 / 若做需改什么**：history 新增结构化字段（顶层 `transportTrace` 或 `attempts[].transport`，与 sseEvents 并列、遵 richest-data-flow），新字段「三处必改」见 skill `persistence-async-invariants`、schema 迁移见 `history-sqlite-schema`；ui-v4 详情加 Transport 时间线段。**须与 request-timing-instrumentation（2026-07-14 spec，owns TTFB/7 刻时序）协调字段边界**，避免重复 per-attempt 时序存储。**订阅子项目 1 已产出的 bus 事件**（`request.upstream_stream_disconnect` / `request.upstream_connect_timeout`，见 spec `docs/spec/2026-07-14-upstream-disconnect-attribution.md` v3(B)）持久化到 history——子项目 1 已把 producer（共享收口函数发事件）+ console + metrics（bus-counter→/metrics，B 路）做完，本片是同一 bus 事件的**history/ui 消费者**。注：`/metrics` 传输聚合**已归子项目 1**（B 路 counter）、**不在本片**；`/api/stats` 维度聚合按 ADR `2026-07-22-metrics-via-prometheus-grafana` 退役方向、不做。
- **为何暂缓**：依赖子项目 1/2 先产出事件源；是「沉淀 + 展示」层，落在采集之后。用户 2026-07-14 决定拆后做。**触发条件（值得做）**：子项目 1/2 的事件已产出、需持久化因果链 + fleet 指标 + UI 展示时。详细 surface 设计见 [upstream-transport-observability.md](upstream-transport-observability.md) §6。

## retry 策略可插拔化 / 声明式 registry —— 入站侧剥离的下一独立项（2026-07-21 定为下一项）

**背景**：「把更多功能从核心剥离成 hook/可插拔单元」的探索（spec `docs/spec/2026-07-20-async-request-rewrite-extraction.md`）盘点发现：请求/入站侧（system-prompt、preprocess）**本就基本已提取成 per-format 纯函数**、pipeline 响应侧已有 `rewrite-registry`；**真正「核心承担大量逻辑、尚未插件化」的最大一块是接缝② 的 16 个 reactive retry 策略**（`src/lib/request/strategies/*`：tool-field / server-tool / cache-control / unsupported-beta / context-management / adaptive-thinking / legacy-thinking / structured-outputs / deferred-tool / system-reject / web-search-not-found / effort-learning / network / server-error / token-refresh）。

**根因（为何它不像 rewrite-registry 那样已插件化）**：retry 策略是**跨 attempt 决策**（判上游错误 → 改 body → 重试），与 `RequestRewrite`（单次 transform）/ `exchange` hook（包一次调用）形状根本不同；现由 codec cell `buildLegStrategies`（`cc-family-strategies.ts` 等）per-leg 组装，无统一声明式 registry / 无逐项开关 / 无统一可观测入口。

**理想架构**：为 retry 策略引入声明式 registry（类似 `RESPONSE_REWRITE_ORDER` 的 named + order + appliesTo），或引入新的 retry-strategy hook 类型；须处理反应式学习状态（negotiation_learning TTL）、per-attempt 信号记录、body-shape baseline（Responses vs CC）等承重耦合。

**为何暂缓**：用户 2026-07-21 决策 —— 先做入站侧薄增量（格式分发 hook），把 retry 可插拔化作为**下一个独立项**、另起 spec。这是最大价值、也最重（风险/工作量高）。

**若做需改什么**：`src/lib/request/strategies/*`（16 策略）、`src/lib/codec/cc-family-strategies.ts` + 各 `*/strategies.ts` 的 `buildLegStrategies`、`src/lib/pipeline/cell-assembly.ts` 的 `n`/RetrySemanticsSpec、反应式学习生命周期（`negotiation_learning`）、per-attempt 信号记录（[[methodology-record-signals-at-committed-outcome-not-per-attempt]]）。先盘点 16 策略的共性接口再抽象，别过早统一。

## anthropic route 无条件 config reload（sanitizeToolNames 新鲜度对齐 CC）—— 实测后延后（2026-07-21）

**根因**：`src/routes/messages/handler-v4.ts` 的 config reload 是 `if(payload.system) await applyConfigToState()`——**system-less anthropic 请求永不 reload**，parse 阶段读的 `state.sanitizeToolNames`（`codec.ts` → `tool-name-sanitize.ts:41`）可能陈旧一拍。CC 路由（`chat-completions/handler-v4.ts:169`）是**无条件** reload，无此不对称。

**当前行为**：system-less anthropic 请求的 tool-name sanitize 用上一拍 config 态（实践中 config 极少热改，影响小；但语义上是既有 freshness 隐患）。

**理想架构**：route reload 改无条件、对齐 CC。

**实测爆炸半径（为何延后）**：改无条件后 `bun test tests/anthropic tests/config tests/routes` **打爆 20+ 测试**（immediate-keepalive / keepalive buffered-anchor / L2 buffered-retry / live-pump 等），revert 后同套件 2150 pass/0 fail、归因确证。根因：大量 keepalive/buffered-retry 测试**直接设 `state`（非 config 文件）**，每请求无条件 reload 冲掉其 setup。硬修需把这 20+ 测试逐个迁成 config-file-driven（对齐 CC 路由做法）——与「入站 system-prompt 分发 hook」主体不成比例、tangential 高风险。该不对称是**既有状况**、非分发 hook 引入，故独立延后。

**若做需改什么**：`handler-v4.ts:341` 去 `if(payload.system)` 条件；把受影响的 ~20 个 keepalive/buffered-retry/live-pump 测试从「直接改 `state`」迁成「config 文件驱动」（`useIsolatedRuntime` + config fixture，对齐 CC 路由既有测试）。先枚举全受影响测试再动。关联 spec `docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md` §3.3。

## monorepo 测试同置（Phase-2）+ core 内部解环排序清单（2026-07-22，monorepo workspace split spec）

- **根因 / 现状**：monorepo 拆分 spec（[../spec/2026-07-22-monorepo-workspace-split.md](../spec/2026-07-22-monorepo-workspace-split.md)）粗粒度先切阶段只把包边界立起来，**654 个测试仍集中在根 `tests/`**（不在各包 `src` 旁），`bunfig.toml` 单一 `[test].preload`（sandbox-paths 地板）、`RESETTERS` 全仓单例表、`useIsolatedRuntime` fixture 都按「单进程跑全套件」设计。
- **当前行为**：测试与被测包不同置——拆分后「每包 src/tests 内聚」这个目标在测试侧尚未兑现（day-1 有意不搬，654 文件位移是仅次于 core 主体搬迁的高危撞行面）。
- **理想架构 / 若做需改什么**：测试随 core 内部模块剥离（spec 阶段 4+）逐包物理下沉到 `packages/*/src` 旁；若走每包各自 `bun test`，各包 `bunfig` 各自 `[test].preload` 但**指向同一份共享 sandbox-paths**（放 foundation 或新建 `packages/test-harness`、各包 re-export、绝不各包复制）；`RESETTERS` 表随单例分包、L1 守卫 `resetters-complete.unit.test.ts` 改成每包各自枚举本包 `*ForTests`；同步改 `tests/architecture/*.unit.test.ts` 内硬编码 `import.meta.dir`+`../../src/lib/...` 路径。
- **为何暂缓**：巨量撞行面、依赖 core 内部先解环到位；是「同置收尾」层、落在结构搬迁之后。**触发条件（值得做）**：core 已剥出真子包、需把对应测试随之下沉时。
- **关联：core 内部解环排序清单**（spec §6 措施 3，随剥离长期存活）：~~**state 第一**~~ ✅ **已完成（2026-07-28）**——state 不是「解耦」而是**整体降为 foundation 叶子**并迁出 core（`packages/foundation/src/{state,state-defaults,state-vocabulary}.ts`），叶子无出边故谁依赖它都不成环，`~83 个 importer` 从来不是障碍。下一个是 **anthropic/openai/gemini**（现在可以提 core 层 vendor 纵切了）、再下一个 **pipeline/codec 局部环**（cell-assembly 三方环）。每次只剥一个、land 后重评 SCC + madge 环快照只减不增。
  - **✅ 已落地（2026-07-28）**：S1–S7 全部完成，权威记录 [docs/plan/2026-07-28-state-to-foundation/HANDOVER.md](../plan/2026-07-28-state-to-foundation/HANDOVER.md)（每步的验收 oracle、变异实验与踩过的坑）。**spec §5 的 reader seam 方案与 §7.2 阶段 0d 均已作废，`core/state/reader-*.ts` 不要建**——削环已由「state 成为叶子」这个拓扑事实解决。窄读接口本身的封装收益若仍想要，是一条独立的、尚未立项的条目。

## 聚合指标迁 Prometheus/Grafana、退役 /api/stats 自建聚合（2026-07-22，ADR 2026-07-22-metrics-via-prometheus-grafana）

- **根因 / 现状**：`/api/stats` + telemetry.db 长窗 rollup（5min/hourly/daily）+ DDSketch 存 + ui stats 页，是自建的迷你时序聚合库；与 `/metrics` 同源（`getDimensionBreakdown`），多出的多窗口/分位/top-N 恰是 Prometheus/Grafana 原生本职。对有 Prometheus 的部署冗余。
- **当前行为**：聚合可视化靠自建 stats API + UI；无 Grafana/告警。
- **理想架构 / 若做需改什么（三阶段，破坏性最后做）**：① `/metrics` label/histogram 补齐——把 /api/stats 现有维度 breakdown + 分布以 Prometheus 原生形态铺全（enabling，非破坏）；② 增 Grafana 支持——`docs/GRAFANA.md` + 示例 dashboard JSON + scrape 配置 + README（新增，非破坏）；③ 退役——删 `/api/stats` 路由（`src/routes/stats/`）+ telemetry.db 长窗 rollup/DDSketch（`src/lib/telemetry/read.ts` 30d/90d/lifetime + sketch）+ ui stats 页（`ui/src/composables/useOperationalStats.ts`）；保留 `/metrics`+registry+`getDimensionBreakdown`(sinceStart)、History（per-request 取证）、`/api/status`（健康）、实时面板。telemetry.db 最终形态按「/metrics 实际依赖」在专项 spec 精确裁决。
- **为何暂缓**：破坏性方向；telemetry 区正被并发会话热改（2026-07-17 起 retry-fire telemetry / generation topology / V2-removal），须待其落定；且第③步须先完成①的 /metrics 无损覆盖。**触发条件（值得做）**：并发 telemetry 工作落定 + 决定正式采用 Grafana 时。第①步（/metrics 补齐）可较早独立启动。发现方：disconnect metrics B/A 取舍追问 → 用户 2026-07-22 决定聚合交 Prometheus/Grafana。

## 前端 remap 箭头判定用 strict `!==`，与后端/TUI 的 isSameModelName 语义漂移风险（2026-07-23，codec model-resolution 重构合并态 review 建议）

- **根因 / 现状**：TUI 与 console log 用 `modelRemapParts`（即 `isSameModelName`，[resolver.ts:59](../../src/lib/models/resolver.ts#L59)）判定「是否真重映射」——拼写变体（`claude-opus-4-8` vs `claude-opus-4.8`）被抑制、不显示箭头；前端两处 LiveGroup（[LiveGroup.tsx:16](../../ui-v4/src/components/requests/LiveGroup.tsx#L16)、[LiveGroupShadcn.tsx:16](../../ui-v4/src/components/shell/shadcn/LiveGroupShadcn.tsx#L16)）却用 strict `row.resolvedModel !== row.clientModel` 决定是否显示 `client→resolved` 箭头。两套判定语义不同。
- **当前行为**：**当前无语义冲突**——2026-07-23 的 codec model-resolution 重构（commit `f926427a`）已让后端把 `isSameModelName` 作为**单一抑制权**，拼写变体一律不写入 `ctx.clientModel`（前端拿到的 `clientModel` 只在真重映射时才有值），所以前端的 strict `!==` 此刻永远不会命中拼写变体。前端与 TUI 显示一致。
- **理想架构 / 若做需改什么**：让两套显示逻辑复用同一判定权威，杜绝未来漂移。两条路线：① 前端复用一个 `isSameModelName` 的等价实现（前端已有 `~backend/*` re-export 通道，可考虑 re-export 该纯函数）；或 ② 后端在 wire contract 里直接提供已判定好的 `isRemap` 布尔或 display-ready 的 model 字段，前端只渲染、不再自行比较（更符合 richest-data-flow 的「决策交给产生方、末端只呈现」）。若走 ②，需在活动快照 wire（[active-request-wire.ts](../../src/lib/observability/active-request-wire.ts)）加字段 + 前端两处 LiveGroup 改读该字段。
- **为何暂缓**：非当前缺陷（后端抑制权已收敛，生产数据无冲突），是**防御未来漂移**的一致性加固——若将来任一 API / 旧记录 / 手工数据给出拼写变体的 `clientModel`，前端会重新显示与 TUI/日志不一致的无意义箭头。**触发条件（值得做）**：前端需消费可能含拼写变体 `clientModel` 的数据源（如导入旧 History 记录），或做前端显示逻辑重构时顺带收编。发现方：codec model-resolution 重构合并态 review（gpt-souls:reviewer，2026-07-23）主观建议。

## bundled-config 能力矩阵集成测试（config-vs-code false-green 缝）

- **根因 / 现状**：`model_capabilities` 的匹配测试（[model-pattern.unit.test.ts](../../tests/models/model-pattern.unit.test.ts)、[anthropic-features.unit.test.ts](../../tests/anthropic/anthropic-features.unit.test.ts)）与热重载测试（[config-hot-reload.it.test.ts](../../tests/config/config-hot-reload.it.test.ts)）都直接读初始 `state` 默认或临时自定义 YAML，**没有**测试加载真实 shipped `config.yaml`（`loadBundledDefaultConfig` → `applyConfigToState`）后的五项能力最终矩阵。而生产启动会用 bundled `config.yaml` 覆盖 state 默认（[config.ts:328](../../src/lib/config/config.ts#L328)、[config.ts:672](../../src/lib/config/config.ts#L672)）。
- **当前行为**：primitive 与 state 默认测试全绿，但 shipped `config.yaml` 里的配置错误**不会**使任何测试失败——典型「primitive 绿、生产入口配置错」的假绿缝。2026-07-23「去前缀匹配」重构合并态审（gpt-souls:reviewer）实测发现当时在飞的 `config.yaml` 有 `extended_cache_ttl: ["claude-*"]`（错误放宽、该能力本应比 context/memory 窄）与 `adaptive_thinking: {}`（schema 要求 `string[]`、`validateConfig` 只 warn+strip 不 fail-fast），均未被任何测试捕捉。
- **理想架构 / 若做需改什么**：新增一条 bundled-config 集成测试：`loadBundledDefaultConfig()` + `applyConfigToState()` 后，对 12 个真实 Claude 模型（opus-4/4.1/4.5/4.6/4.7/4.8、sonnet-4/4.5/4.6、sonnet-5、haiku-4.5、fable-5）断言五项能力的完整矩阵；并显式断言 `extended_cache_ttl` 不为 `claude-opus-4`/`claude-opus-4.1`/`claude-sonnet-4` 开启（守窄契约）、bundled config 通过 schema 校验无 warning。
- **为何暂缓**：加此测试须先让 shipped `config.yaml` 迁移到位（`E → E*` 等价 + `adaptive_thinking` 删 key 或 `[]`），而 `config.yaml` 正由并发会话（peer）迁移中、处于半途破损态——此刻加会红。**触发条件（值得做）**：config.yaml glob 迁移落定后由收尾方补上，作为该迁移的验收 oracle。发现方：去前缀匹配重构合并态 review（gpt-souls:reviewer，2026-07-23）。

## `recordOpened` 的 `upstreamHeadersAt` 捕获走完整 dispatch-open 路径无 .it 覆盖（Q5 复审 MED-1，2026-07-23）

- **根因 / 现状**：`upstreamHeadersAt` 的真实捕获在 [driver.ts:642](../../src/lib/pipeline/driver.ts#L642) 的 `recordOpened`（由 [dispatch-scheduler.ts:211](../../src/lib/pipeline/generation/dispatch-scheduler.ts#L211) 在 `await input.open()` resolve 后调用）。现有 timing/History 的 .it 测试 harness 走 `runResponse` 喂**已开流**、**绕过 dispatch-open**，故 `recordOpened→setGenerationDispatchTimingEpoch→setDispatchTiming` 这条真实捕获链无端到端测试覆盖。接线已 code-read 验证正确（Q5 直读实测也间接证实四刻确实被写出、见 [spec/2026-07-23-upstream-silence-commit-timing.md](../spec/2026-07-23-upstream-silence-commit-timing.md) §0）。
- **当前行为**：功能正确（生产 History 已能读到 `upstreamHeadersAt`），但无守卫防未来重构悄悄断开 dispatch-open→timing 接线。
- **理想架构 / 若做需改什么**：补一个走完整 dispatch-open 路径（真 `input.open()` → `recordOpened`）的 .it 测试，断言 `attempts[].timing.upstreamHeadersAt` 被写入且 `>= startedAt`。可**并入 B2 实施的 dispatch-open 回归矩阵**（B2 大量新建 pre-ready/dispatch-open 路径测试，见 upstream-silence recovery plan），不必独立造 harness。
- **为何暂缓**：非阻断（功能正确、Q5 实测间接背书），且最经济的做法是折进 B2 的 dispatch-open 测试面。**触发条件**：B2 实施，或任何触碰 dispatch-open→timing 接线的重构。发现方：Q5 timing 埋点复审（2026-07-23）。

## B2 fresh recovery 在 cancel/seal 后的 candidate lifecycle quiescence join 待 P4/P5 owner 接线（Task 0.6 余项，2026-07-28）

- **根因 / 现状**：Task 0.6 已把整个 `recordOpened` 及其 timing setter 改为 sealed-safe，修掉 late deferred-header 的 post-seal 写入/抛错；但当前 [recovery-sink-supervisor.ts](../../src/lib/pipeline/generation/recovery-sink-supervisor.ts) 只包装 `ClientSink`，既不启动也不持有 primary/fresh recovery candidate lifecycle。master 漂移后 primary `exchangePromise` 已由 [driver.ts](../../src/lib/pipeline/driver.ts) 注册进 operation scope，`startGenerationFinalizerIfReady()` 会先 `await operationScope.whenOperationQuiesced()`，`candidate.cancel()` 与 scheduler cleanup 也会 await `runPromise`/`lifecycle.quiesced`。因此主线 production primary 腿今天已被 operation scope 结构性护住：`open()` 挂起期间 finalizer 不会 seal。`runPreContentRecovery()` 的 fresh recovery 尚未注册进 operation scope，且 P4/P5 之前没有拥有“本轮 primary + fresh recovery + 最终 sink settlement”的 recovery owner。
- **当前行为 / 风险**：① 已使 late open 不再因 History timing/header 观测越过 seal 而抛错，主 crash 链已被切断；该守卫当前覆盖 mock/legacy ctx、candidate-discard/supersede，以及 P4/P5 将新增的未注册 fresh recovery 腿，不夸大为 production primary 当前可达；② 仍缺显式的跨候选 join 契约。未来 P4/P5 接入 fresh recovery 后，若 owner 在 cancel/seal 后先最终收口 sink、却未等待它启动过的所有 candidate quiesce，迟到 reject/cleanup 仍可能脱离 owner 作用域，且 terminal 与物理传输生命周期次序不再由单一 owner 保证。
- **理想架构 / 若做需改什么**：P4/P5 的 recovery owner 启动 primary/fresh recovery 时登记 candidate completion/lifecycle 句柄；最终成功、耗尽、gate 拒绝或 cancel 后，先 cancel 必要候选并 `await` 全部 quiescence，再调用 `RecoverySinkSupervisor.settleFinal()`。不要把 candidate ownership 反向塞进纯 `ClientSink` decorator。补 mutation-positive-controlled 测试：去掉 owner 的 await 后，late reject/late cleanup 用例必须变红。
- **为何暂缓**：P0-P3 当前没有 recovery owner，也没有 production 接线；在 sink supervisor 中伪造 candidate registry 会制造错误分层。**触发条件**：B2 P4/P5 挂载 fresh pre-content recovery 时必须同 Task 完成，不能继续后延。

## L2 strip-all 兜底可能留下 `content: []` 的 assistant 消息（2026-07-26，thinking 终端块修复期间发现）

- **根因 / 现状**：L2 反应式兜底 [poisoned-thinking-retry.ts](../../src/lib/codec/anthropic/poisoned-thinking-retry.ts) 的 `handle` 直接 `env.with({ body: { ...payload, messages } })` 重试，**不走 `resanitize`**（不像 truncation 等策略会重跑 sanitize 链）。而 [stripAllThinking](../../src/lib/anthropic/strip-all-thinking.ts#L54) 只做 `filter`，不会丢弃被清空的消息。因此一条**只含 thinking（+ L1 合成分隔符）**的 assistant 消息被 strip 后会变成 `content: []`，原样发往上游。
- **当前行为**：未观测到实际 incident（L2 本身是罕见兜底腿；且这种「assistant turn 只有 thinking、没有 text/tool_use」的形态本就少见——主要来自 thinking 阶段被 `max_tokens` 截断的轮次与 thinking-only refusal）。风险是兜底腿在最需要它的时候被上游以另一个 400（空 content）挡回，使 L2 失效。**为 code-read 定性、未实测复现**（诚实标注）。
- **理想架构 / 若做需改什么**：两条路线——① 让 `stripAllThinking` 顺带丢弃被清空的 assistant 消息（须确认不会造成相邻同 role 消息 / 破坏 tool_use↔tool_result 配对，故更稳的是走 ②）；② L2 `handle` 在重试前跑一遍 `codec.getResanitize()`，复用既有的空消息清理与配对校验（`processToolBlocks` 已有「content.length === 0 → drop the whole message」逻辑）。倾向 ②：单一权威、不新增一处「哪些消息该丢」的判断。需同步核对 L3 主动 quarantine 过滤腿（同样调用 `stripAllThinking`）是否有相同缺口。
- **为何暂缓**：非当前事故根因（本次 400 由 L1 布局修复解决，L2 只是没能兜住）；修法涉及 retry 路径的 payload 重建顺序，值得单独立案 + 实测（构造一条纯 thinking 的 assistant 消息走 L2 腿，验证上游对空 content 的实际反应，再决定 ① / ②）。**触发条件（值得做）**：观测到 L2 重试后仍 400、或实施 `max_tokens` 续传（C 型 thinking 零产出轮次会显著提高纯 thinking 消息的出现率）。发现方：thinking 终端块布局修复期间的邻域审查（2026-07-26）。
- **2026-07-27 更新（触发面略微变宽）**：L2 现在还认领 C3 的 prefill 措辞（`classifyLayoutRejection` → `"tool-terminal-prefill"`，仅当 thinking 正是把 tool_use 挤离末尾的原因才重试）。多出的这条腿同样不走 `resanitize`。**违规消息本身**必然还含 `tool_use`（否则不构成 C3 违规），不会被清空；但 strip-all 是**整 payload** 作用的，同一 payload 里别处的纯 thinking 消息照样会被清空——即缺口性质不变，只是更多流量经过这条腿。

## startup-order 守卫是可达性的语法近似，不是控制流分析（2026-07-27，telemetry 抽包合并态审第六轮）

- **根因 / 现状**：[tests/architecture/telemetry-startup-order.unit.test.ts](../../tests/architecture/telemetry-startup-order.unit.test.ts) 用 AST 断言 `initialize() → listen → runJsonBackfill()` 三个 milestone 的存在、顺序、被 `await`、在 `runServer` 自身执行流内、且不在会跳过它的构造里（`catch` / `if`/loop/`switch` / `&&`/三元 / label / 可选链 / `return`·`throw` 之后）。这是**可达性的语法近似**——它证明不了真可达。仍能骗过它的形态：上一行调用了一个必抛的 helper、`process.exit()`、以及任意非局部控制流。
- **当前行为**：生产接线正确且被守住常见回归（挪动调用、去掉 `await`、塞进死分支/死 helper、注释掉——全部实测转红）。残余缺口需要刻意构造才能触发，未观测到真实风险。
- **理想架构 / 若做需改什么**：两条候选，都换判据而非继续扩「跳过构造」名单——① **窄 sequencing helper + runtime spy**：抽一个只拥有这三个动作、依赖回调注入的薄编排函数，`runServer` 调它；测试注入 spy 断言**真实执行顺序与 await 语义**（initialize 的 promise 未 resolve 前 listen 不得被调用）。代价：`runServer` 里三个 milestone 相隔约 200 行其它启动逻辑，helper 要吞掉中间段，可读性变差——需先设计好形状。② **booted-server e2e**：让 telemetry runtime 记录自身相位跃迁，起真实服务器（非 4141 端口）后断言记录到的顺序。代价：进 `test:e2e` 档、不在默认 `test:backend` 里。
- ~~**为何暂缓**~~ → **✅ 已解决（2026-07-27，`e170566c`），但走的是第三条路**：既没做 ① 也没做 ②，而是**把不变量搬进 runtime 自己**——`markServerListening()` 在 `initialize()` 未完成时 fail-fast，`runJsonBackfill()` 在标记之前被**延迟到标记时**而不是提前执行。于是「调用写反了」不再能破坏契约（延迟保证了它仍在 listen 之后吸收），oracle 退化成一个普通 runtime 单测。教训：**当守卫追不上的时候，正解往往是换不变量的存放位置，而不是造更强的守卫**——`docs/plan/monorepo-split/plan-telemetry-package.md` 与 `tests/architecture/telemetry-startup-order.unit.test.ts` 的注释记录了完整推导。
- **残余（已知且刻意）**：source 守卫仍保留一个窄职责——断言 `markServerListening()` 真的接在 listen 与 backfill 之间（runtime 自己证不了「有没有人调我」），这一条仍是语法层判断。真实回归形态（挪调用、删 hook、去 await、死分支、死 helper、注释掉）均已实测转红。


## delivery owner 合同抽成无依赖 `pipeline/wire-contracts.ts`（2026-07-28，allocator 第二轮实现审查）

- **根因 / 当前行为**：为避免 `pipeline/types.ts → delivery/types.ts → stream/frame-envelope.ts` 把 delivery 文件拉进核心 SCC，`OwnerResult` / `WireBlockAllocationPort` / `WireWriteSpec` 当前定义在 `pipeline/types.ts`，`delivery/types.ts` 反向 re-export。SCC 正确、类型只有一个定义，但“delivery owner 合同”在职责命名上更接近 delivery 域，归属仍不够干净。
- **理想架构**：抽一个不依赖 `delivery/*`、`stream/*` 的 `src/lib/pipeline/wire-contracts.ts`，只拥有纯 owner/wire 类型；`pipeline/types.ts` 与 `delivery/types.ts` 都从它 import/re-export。迁移必须保持 SCC ratchet 与 package boundary 守卫不增边。
- **为何暂缓**：这是纯结构归位，不改变本轮 P1/P2 行为，且后续 P3M M1-M4 会持续修改同一批合同；现在搬一次、M4 后再搬一次只制造无语义 churn。**触发条件**：P3M M4 三条 real-block 路径收敛、owner 合同稳定后同 commit 或紧随其后提取。

## remap allowlist 的能力轴升级（2026-07-28，allocator 第二轮实现审查）

- **根因 / 当前行为**：AST allowlist 已覆盖直接 `.remap(...)` 与 `remapAnthropicBlockIndex(...)` 调用，能抓 literal/变量 offset/直接 primitive，注释不误伤；但别名提取（`const r=hooks.remap; r(...)`）、计算属性（`hooks["remap"](...)`）、import rename 仍是合法绕法。
- **理想架构**：不要继续枚举拼写。P3M 收敛后把 offset 计算能力从公开类型上拿走：生产调用方只提交 `WireBlockMapping`/block identity，由 owner 内部完成 remap；外部不再拿到任意 offset primitive。守卫改问“目标能力是否只由 owner 持有”，而不是 callee 怎么拼。
- **为何暂缓**：当前合法 legacy S1/S2/S3/continuation 站点仍需要旧 remap 形状，能力尚不能移除。**触发条件**：M4 清空 `REMAP_CALL_ALLOWLIST` 的 `legacy:*` 条目时同步实施；若此前再发现一种绕法，立即停止补 AST 形态，提前执行能力轴迁移。
## 代理侧 refusal fallback 重试（换模型重发）—— 未采纳，非「不值得」而是本轮范围外（2026-07-28，contentless refusal 抑制期间）

- **根因 / 现状**：上游 contentless refusal 时，代理目前只能**抑制**（合成一个说明性的正常完成轮，见 [docs/refusal-recovery.md](../refusal-recovery.md)）。抑制达成了首要目标——客户端对话轮次不被中断——但**本轮没有产出任何真实内容**：agent 读到的是一句「上游拒绝了」，得自己决定下一步。真正「轮次不中断**且**真的有产出」的做法是换一个模型重发。
- **不是我们凭空想出来的方案**：上游自己在 `stop_details.explanation` 的样板句里建议的正是这条——`"API integrators: you can reduce refusals for your users by configuring a fallback model"`（三个一手样本里 3/3 都带这句）。Claude Code 也**内建了它**：`stop_reason==="refusal"` 且备有 `refusalFallbackModel` 时 `yield {type:"fallback_request", trigger:"refusal", apiRefusalCategory, ...}` 自动换模型重发（`~/.claude/refs/claude-code-2.1.207/app.pretty.js:298050-298063`，本会话逐行核实）。
- **当前行为**：我们的抑制**恰恰挡住了 CC 自己的这条腿**——客户端再也看不到 `stop_reason:"refusal"`，所以它的 fallback 永远不会触发。这是抑制的**已知代价**，不是缺陷：CC 的 fallback 依赖用户已配置 `refusalFallbackModel`，且其失败终点仍是结束当前轮（`refusal_no_fallback`），不满足首要目标。
- **理想架构 / 若做需改什么**：一条新的反应式 retry 腿（参考 `src/lib/request/strategies/` 既有诸腿）。要点：① **循环安全**——refusal 可能对所有模型复发，须有 attempt cap 且不与既有 buffered-retry / continuation 预算打架；② **换模型的选择**依据（配置显式指定 vs 按 catalog 降级）；③ **计费**——多烧一次真实请求，需在 History/遥测里可辨识（该 attempt 打标记，别混进正常重试统计）；④ 与抑制的**优先级**：fallback 成功则不需要抑制，失败才落到抑制兜底——即抑制从「唯一手段」降级为「最后兜底」。
- **为何暂缓**：用户在范围选择中选了 B 档（诊断忠实化 + 分型，不含自动重试），随后又把焦点收敛到「抑制」。**不是判定它没价值——恰恰相反，它比抑制更接近真正的目标**。**触发条件（值得做）**：观测到 refusal 频次上升（当前极罕见：全部保留数据里仅 3 次，2026-06-23 / 07-13 / 07-27），或用户希望被拒的轮次能自动产出真实内容而非一句说明。
- **做之前必须先做的实验**（当前**全部未验证**，别当事实用）：同 payload 换模型重发的**恢复率**；同 payload 同模型重发是否必然再拒（官方文档只说 "usually"）；`category` 是否能预测可恢复性（`cyber`/`bio`/`null` 三类已观测，但**无任何**行为差异证据——`bio` 那次是烧了 25,636 thinking token 之后才拒的，不是推理前拦截）。取证基线见 [exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md)。
## pre-ready recovery 的分类 reason 未进入 attempt diagnostics（B2 Task 0.4，2026-07-23）

- **根因 / 现状**：`driver.runPreContentRecovery(reason)` 将调用方的分类原因传给 `GenerationCoordinator.runRecoveryFromPreReadyFailure(reason, env)`，但 coordinator 仅用 `_reason` 满足接口、接着 `start({ role: "recovery", env })`；primary 的 pre-ready failed-open attempt 已在 scheduler/candidate 内被 settle 为 `failed`，没有 `retryNextStrategy` 或任意 metadata 字段承载后续 fresh dispatch 的触发原因。现有 `recordAttemptFailure` 只能记录 `willRetry`、`nextStrategy`、`waitMs`、`learning`，而 `CoordinatorCandidateInput` / `beginCandidate` 也没有 recovery metadata。
- **当前行为**：fresh recovery 的 candidate role、wire 与 success/failure 会被记录，但例如 `"upstream-rst"` 的分类原因在 coordinator 边界被丢弃；History 和 telemetry 无法从单次 operation 还原为何启动该 replacement dispatch。
- **理想架构 / 若做需改什么**：扩 `CoordinatorCandidateInput` 与 `DispatchRecordingPort.beginCandidate` 的 generation-candidate record，加入可选、结构化的 `recoveryReason`（或通用 `trigger` metadata），使 coordinator 将 reason 传入、`RequestContext` 持久化到 History V3 candidate / attempt diagnostics，并在 API 投影中完整暴露。不要挪用 `retryNextStrategy`：它描述已完成 dispatch 的 retry 结局，无法无损承载 replacement 的分类原因。
- **为何暂缓**：本 Task 的自然 driver 落点只有 `recordAttemptFailure(nextStrategy)`，把 reason 拼接进该枚举状字段会混淆语义并丢失结构；正确方案需要扩跨 coordinator、context、History schema/projection 的公开诊断契约，超出已定 Task 0.4 的接口变化范围。**触发条件（值得做）**：B2 P4/P5 接入 handler 的 pre-content recovery 时，或下一次扩 generation candidate diagnostics 时，连同其 History/API 回归测试一并实施。发现方：Task 0.3 review，Task 0.4 代码实证（2026-07-23）。

## pre-content recovery 用 afterHook 而非 preflight env dispatch（B2 Task 0.4 review，2026-07-23）

- **根因 / 现状**：`driver.runRequest` 在 pre-ready 失败时把 `{coordinator, env: afterHook}` 存进 `lastPreReadyFailure`（`driver.ts:410` 附近，`afterHook` = S3 rewrite-in 之后、**S4-pre `runGenerationPreflight`/`preSend` 之前**的 env）；而 primary 实际发起用的是 `preflight`（`const preflight = await runGenerationPreflight(deps, afterHook)`，`driver.ts:401`）。`runPreContentRecovery` 用 `failure.env`（即 afterHook）重走 `outboundPrepareWire` 做 gate 判定与 recovery dispatch——**没有经过 preSend**。
- **当前行为**：**今天字节等价、无实际影响**——三条 leg（anthropic/openai-cc/openai-responses）都明确「No preSend」（auto-truncate 已移除），故 recovery wire 与 primary wire 一致。
- **理想架构 / 若做需改什么**：把 `rememberPreReadyFailure` 存的 env 改为 `preflight`（primary 实际 dispatch 用的那份，已 transform、无需重跑 preflight 副作用），使 recovery wire 与 primary wire 恒等；或在 recovery 路径显式对齐 preflight。这样任何 leg 未来重新引入 `preSend`（如 truncation 类前置处理）时 recovery 不会悄悄绕过它。
- **为何暂缓**：今天无可观测差异；正确的 env 选择在 P4/P5 接 handler 时语境更清晰（届时 recovery env 的实际使用具体化）。**触发条件（值得做）**：B2 P4/P5 接线 `runPreContentRecovery`（届时一并核实/对齐 env），或任何 leg 重新引入 `preSend`。发现方：Task 0.4 review（reviewer，2026-07-23）。**姊妹 nit**：gate 探测的 `outboundPrepareWire` 非纯（`recordFeature` 双发），可控无正确性影响；若精确处理参照 `inspectRequest` 的 `withCapturingManagerAsync` 隔离写法。

## `parallel-test.ts` 的用例汇总仍系统性欠计（2026-07-28，紧随 ANSI 修复）

- **根因 / 现状**：`scripts/parallel-test.ts` 汇总各 shard 的 `N pass` / `N fail` 时曾因 bun **即使输出到管道也上色**（`\x1b[0m\x1b[32m 26 pass\x1b[0m`）而恒报 `0 tests`，已修（`5454616b`，strip SGR 后正样本对照 0 → 4243）。但修复后**数字仍与直接命令不一致**：同一棵树上 `bun run test:backend`（= `parallel-test.ts unit it http`）报 **4749 tests**，而 `bun test --parallel .unit.test .it.test .http.test` 报 **6614 tests / 644 files**；单 `unit` 档同样差（4007 vs 4304）。已排除的假设：① 不是发现缺口——`tests/` 内 `.unit.test.ts` 计 414、全仓同样 414，`tests/` 之外只有一个 `exp/` 实验文件（本就不该进门）；② 不是别的 CSI 序列——实测 bun 输出的 CSI final byte 只有 `m`。
- **当前行为**：**门本身（退出码）是对的**——它由各 shard 自己的 exit code 决定，真失败照样红；坏的是**汇总证据行**：交付报告引用的「N pass」系统性偏小约 25%，且无法与直接命令对账。
- **理想架构 / 若做需改什么**：给 parallel-test 加一条自检——把各 shard 的 `pass+fail+skip` 之和与「预期用例总数」对账，不一致就**显式告警而非静默出数**；或直接改用 `--reporter=junit`（脚本 `refreshTimings` 已经在用 junit XML，逐 `<testcase>` 计数是精确的）取代脆弱的 stdout 文本解析。后者更根治：文本汇总格式随 bun 版本变化的历史已经踩过两次。
- **为何暂缓**：门的正确性不受影响（exit code 正确），属证据可信度问题；且正确修法（改 junit 计数）值得单独一个改动 + 正样本对照，不该塞进特性分支。**触发条件**：下次有人需要引用精确用例数做交付证据，或第三次被 bun 输出格式变化咬到。**发现方**：upstream-silence 特性分支第二次合并 master 时的对账（2026-07-28）。

## Step 1 还有两个「停后台服务」可能同样饿死 drain 期的在途请求（2026-07-28，h2 池 teardown 修复的邻域审查）

- **根因 / 现状**：关机 Step 1 的 `closeHttp2Sessions()` 已被证明会秒杀正在建连的在途请求（本轮修掉，见 [docs/lifecycle.md](../lifecycle.md) Step 1 注）。**同一行代码的邻居没查**：`stopRefresh()`（= `peekTokenRuntime()?.dispose()`，停 token 刷新）与 `peekUpstreamWsManager()?.stopNew()`（停新建上游 WS）都在 Step 1 执行，而 Step 2/3 还要给在途请求 60s+120s 自然完成。若某个在途请求在 drain 期**需要**刷新 token（长 drain + 短 token 有效期）或**需要**新建一条上游 WS（Responses 腿），它会在 Step 1 之后的窗口里失败——与 h2 那条完全同构。
- **当前行为**：未观测到 incident。WS 侧有 `ws-before-first-event` → HTTP fallback 兜底，风险较低；token 侧取决于 `dispose()` 是否只停周期刷新（无害）还是也拒绝按需刷新（有害）——**未核实，别当已知**。
- **理想架构 / 若做需改什么**：逐个回答「这个 stop 会不会让一条已被接纳的在途请求失败？」——会的就照 h2 的办法挪到 Step 4/finalize，只保留真正的「停止**新增**工作」语义。`stopRefresh` 需要读 `packages/token/src/runtime.ts` 的 `dispose()` 判断是停 timer 还是关整个 runtime。
- **为何暂缓**：本轮范围是 h2 那条已被 incident 证实的路径；把两个未证实的同构猜想一起改会让本次改动的因果链变糊，且 token 侧要先做事实核查而不是改代码。**触发条件（值得做）**：观测到关机窗口内的 token 刷新失败 / WS 建连失败 incident，或下次触碰 shutdown Step 1。**发现方**：h2 池 teardown 修复的 `learn-by-analogy` 邻域审查（2026-07-28）。

## driver 的 `No retry strategy claimed this <type>` 对 `aborted` 是噪声（2026-07-28）

- **根因 / 现状**：[driver.ts:562-566](../../src/lib/pipeline/driver.ts#L562-L566) 在没有任何 retry 策略认领错误时打一条 `consola.warn` + 计数器。它的**本职**是抓「我们的 400 matcher 与上游实际措辞漂移了」（注释写明两次 illegal-thinking-layout incident 就藏在这里）。但 `type: "aborted"` 也会走到这里——而中止**本来就不该有 retry 策略**（客户端走了 / 关机 / reaper 取消，重试毫无意义）。于是每一次正常的取消都在这条本该稀有的 warn 上刷一次，稀释它的信号价值。
- **当前行为**：功能无影响，纯观测噪声；本轮修复后关机造成的那部分已经消失（在 send 层就变成 529 了），剩下的主要是 client-abort。
- **理想架构 / 若做需改什么**：按 `error.type` 分级——`aborted` 走 `consola.debug` + 单独的计数维度（仍然可观测、但不占用「matcher 漂移」这条告警通道），其余保持 warn。须同时确认 `recordRetryGiveUp("unclaimed", type)` 的消费方（`/api/stats`）不会因为分级而丢维度。
- **为何暂缓**：与本轮的因果链无关（本轮改的是归因，不是日志分级），值得单独一个小改动 + 确认 stats 消费面。**触发条件**：这条 warn 的噪声影响到实际排障，或下次触碰 driver 的 give-up 路径。**发现方**：incident `req_1785234916721_3573` 的日志正是这条 warn（2026-07-28）。

## `FormatCodec.formatError` 是与已冻结架构相反的死契约（2026-07-28，共享映射表收敛的邻域审查）

- **根因 / 现状**：`FormatCodec` 仍要求四个 codec 实现 `formatError(err, env): ClientFrame`，全仓**零生产调用**（只有 4 处测试调用）。这不是「P2.3 还没接线」的普通债项——finalize-stream 重设计**已裁决不要这样接线**，理由写在 [archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md §③](../archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md)：WS 的错误/截断走传输级 `sendErrorAndClose`+1011，表达不成 `ClientFrame`；codec 只拿得到 kind、拿不到上游 raw message，接线会逐字节回归。而 `docs/v4/05-progress.md` 顶部已声明 v4 P0–P3 整体完成。
- **当前行为**：**不再有映射正确性危害**——2026-07-28 的收敛让它与活路径读同一张共享表（`~/lib/anthropic/error-shaping` / `~/lib/gemini/stream-error` / `~/lib/openai/stream-error`），所以它即使被调用也不会说出与 wire 不同的话。剩下的纯粹是**契约撒谎**：接口方法看起来像架构入口、注释还写着「driver S7 callers」，实际架构已决定不走它。`docs/v4/01-architecture.md` 的 S7 行本轮已改正（原写 `codec.formatError`，与 `docs/DESIGN.md:53` 的「handler 写回」自相矛盾）。
- **理想架构 / 若做需改什么**：① 从 `FormatCodec`（`src/lib/pipeline/types.ts:919-920`）删 `formatError`；② 删四个 codec 的实现（各自的 `formatXxxError` + `formatError` 成员）；③ 删 4 处测试调用（`anthropic-codec.unit.test.ts:69`、`openai-cc-codec.unit.test.ts:300/309/315`）。**它们不是删除的前置障碍**（我原本这么写，经复审核实说错了）：它们是「codec 这个方法本身」的唯一调用测试，但**不是共享表的唯一覆盖**——共享表已由 `error-shaping.unit.test.ts`（Anthropic 逐 kind 全 taxonomy 对账）、`post-commit-error.unit.test.ts`（delayed-commit 扩展 taxonomy 对照共享表）和 `stream-error-wire-provenance.http.test.ts`（三协议真实 wire）覆盖。反过来这 4 处自己也不完整：只测 Anthropic 4 种 + OpenAI CC 3 种，Gemini 与 OpenAI Responses 的 `formatError` 根本没测。要保留的是**共享 mapper 全 taxonomy 单测 + 三协议 production wire oracle**；若想验证 codec 引用了共享表，用静态 import / 架构守卫，别继续调用一个已裁决删除的死方法；④ `docs/v4/03-spec/codec.md` 与 `05-progress.md` 把 P2.2-D4 标为「已被最终架构裁决 superseded」，而非继续写「P2.3 接线时复核」。
- **为何暂缓**：**不是因为「无消费者所以删」**——本项目明确禁止以清理死代码为名擅自删（CLAUDE.md `no-destructive-workspace-loss`）。理由是这属于**接口契约变更**，超出本轮「abort 归因」的因果链，且需要用户拍板：删掉意味着 `FormatCodec` 不再为「终态错误成形」保留任何位置，未来若真要收进 driver 得重新开这个口子。**触发条件（值得做）**：用户认可删除、或下次触碰 `FormatCodec` 接口 / v4 codec spec 时顺手做掉。**发现方**：第三轮异模型复审（2026-07-28），我核实其引用的每处 `file:line` 与归档裁决后确认属实。

## `applyConfigToState()` 不是两阶段：校验抛错会留下部分应用的配置（2026-07-28，state→foundation 复审的邻域发现）

- **根因 / 现状**：[config.ts:680](../../src/lib/config/config.ts#L680) 的 `applyConfigToState()` 是**边解析边写 state** 的一趟流程：19 个 config-managed 域按源码顺序逐个 `set*()`，而 generation 段的三条跨字段校验（`max_total_candidates >= max_active_candidates` 等）夹在中间**抛错**。于是一份 generation 段非法的配置，会把它**之前**的所有域（`anthropic.*`、`model_mappings`、`disabled_models`、`model_translation`…）写进运行时，把它**之后**的域（retry、timeouts、transport、history、telemetry…）留在旧值。热重载与 `PUT /api/config` 都走这条路径。
- **当前行为**：**目录/禁用列表这一对已经在本轮修好并有回归测试**（`applyDisabledModels()` 把「设列表」与「重推导视图」焊成一步，见 [tests/config/config-apply-catalog-consistency.it.test.ts](../../tests/config/config-apply-catalog-consistency.it.test.ts)）。剩下的是**跨域**的半应用：没有任何机制保证「域 A 的新值」与「域 B 的旧值」放在一起是有意义的配置。**未观测到 incident**，也**没有做过**跨域矛盾的普查——别把「没听说过」当成「不会发生」。
- **理想架构 / 若做需改什么**：改成**先全量校验、后原子 commit** 两阶段——第一阶段把整份 config 解析成一个「待应用的 patch 集合」并跑完所有跨字段校验（纯函数，不碰 state），第二阶段无条件把 patch 集合刷进 state。落地要点：① 那三条 generation 校验必须挪进 schema 层或一个独立的 `validateConfig(config)`，不能继续留在写 state 的路径上；② 19 个 `set*()` 调用点需要能被收集成 patch 而不是立即执行——最小改法是让第一阶段构造一个 `Array<() => void>` 的 thunk 列表，第二阶段依次执行；③ 需要一条测试断言「任何一条校验失败 ⇒ state 与调用前逐字段全等」，而不只是本轮那条目录一致性。
- **状态**：**确定要做的待实施项**，不是「等出事再说」——两位独立评审都确认了边界划分（本分支只需消除自己引入的目录自相矛盾，含 reset→throw 那条反向路径，已完成），但都认为全量两阶段本身该做。**为何不在本轮做**：本轮范围是 state 降 foundation 叶子，而这个形状**早于本分支就存在**（master 上同样如此，`git show master:src/lib/config/config.ts` 可核）——本轮只是因为拆分 `setDisabledModels` 差点让它多长出一个新实例，那个实例已修。把 19 个域的写入路径改成两阶段是独立的结构性改动，塞进特性分支会让本轮的因果链无法审查。**触发条件（值得做）**：观测到一次「配置改坏后服务处于半新半旧状态」的排障，或下次触碰 `applyConfigToState` 的结构。**发现方**：state→foundation 分支的异模型对抗性复审（2026-07-28）——它报的是我引入的那个新实例，我核实后确认底层形状是既有的。

## 另外两个架构守卫仍按「specifier 拼写」而非「解析后目标」判边界（2026-07-29，state→foundation 复审的邻域发现）

- **根因 / 现状**：`~/lib/x` 与 `../../lib/x` 是**同一个模块**，但按前缀/正则匹配拼写的守卫只认得其中一种写法。本轮已在三个消费者上修掉这个形状（state 闭包 containment、core→server ratchet、state 出边 ratchet 的 edge identity），**剩下两个守卫仍是旧形状**：
    - [tests/architecture/telemetry-domain-surface.unit.test.ts](../../tests/architecture/telemetry-domain-surface.unit.test.ts)：deep-import 判据是 `specifier.startsWith("@hsupu/ghc-proxy-telemetry")`。**实测**：`import type { RequestTelemetrySnapshot } from "../../packages/telemetry/src/request-telemetry"` 放进 `src/lib/telemetry-assembly.ts`，typecheck 0 error，telemetry + package 两个守卫合计 **26 pass / 0 fail**——它绕过包名拼写直接摸到包内部文件。附带：该守卫的生产扫描仍只覆盖 `.ts/.tsx`，`.mts` deep import 同样全绿。
    - [tests/architecture/generation-engine-boundaries.unit.test.ts](../../tests/architecture/generation-engine-boundaries.unit.test.ts)：六条边界全部是**对源码文本跑正则**、逐条枚举路径拼写（`/from ["'](?:~\/lib\/pipeline\/generation|\.\.\/generation|…)/`），且 `sourceFiles()` 只收 `.ts`。任何等价但未被枚举的拼法（多一段 `./`、相对深度不同、`.mts`）都能穿过去。
- **当前行为**：**没有已知的实际违规**——两个守卫今天都是绿的，且各自领域的边界目前确实成立。坏的是**保证强度**：它们声称「某某不依赖某某」，实际检查的是「源码里没出现我列举的那几种拼法」。
- **理想架构 / 若做需改什么**：本轮已经把工具做好了——`tests/architecture/source-ast.ts` 的 `createSpecifierResolver(repoRoot)`（用项目自己的 compilerOptions 解析）+ `allModuleSpecifiers()`（AST 枚举全部 import 形态）。两个守卫改成：AST 取 specifier → 解析 → 判断规范化目标是否落在目标目录内；扫描面同时扩到 `.ts/.tsx/.mts/.cts` + `.js` 家族（参考 `package-boundaries` 的 `SOURCE_EXTENSIONS` 与 core ratchet 的 `SOURCE_GLOB`，两处都已有持久 oracle 可抄）。telemetry 那条还要把「只允许 `index.ts` / `types.ts`」表达成解析后的目标文件判断。**每改一条都要配一个 live oracle**：把判据 mutation 回拼写匹配后必须变红——本轮的教训是「primitive 有测试 ≠ 守卫接了线」，而这两个守卫的等价拼法探针此前全绿。
- **为何暂缓**：这两个守卫**不属于本分支的因果链**（state 降 foundation 叶子），覆盖的是 telemetry 包边界与 generation/delivery/transport 分层，各有六条以上独立边界规则，改判据后每一条都需要重新确认仍然成立并重新冻结——那是一次独立的、需要自己的评审的改动。把它塞进本分支会让「state 搬迁做了什么」变得无法审查，这与本轮把「config 两阶段」留在 backlog 的判断同源（两位评审均认可那个边界）。**触发条件（值得做）**：下次触碰这两个守卫、或 telemetry/generation 领域出现一次「守卫全绿但边界实际被破坏」的事故。**发现方**：state→foundation 分支第十轮复审（2026-07-29），我逐条复现确认属实。
## `stream-error` outcome 的唯一产出点靠测试守卫、而非类型系统（2026-07-28，abort 归因收口）

- **根因 / 现状**：post-header 的 abort-provenance gap 计数只在 `src/lib/pipeline/driver.ts:streamErrorOutcome()` 里打。任何别处 mint 一个 `{ kind: "stream-error", … }` 都会绕过它，而**绕过是不可见的**——outcome 照样正确，只有计数静默少报，于是「零」被读成「没有 gap」。这不是假想：该计数器的第一版放在 `dispatch-lifecycle`，完整漏掉了 Responses upstream-WS 腿，读出确定性的零。当前的护栏是 `tests/architecture/package-boundaries.unit.test.ts` 的 AST 扫描。
- **当前行为**：守卫遍历 `src/**/*.ts` 的对象字面量，识别 identifier / string-literal / computed 三种属性名，值侧解包 `as` / 括号 / `satisfies`，并解析指向**同文件** `const` 的 identifier 与 shorthand。四种绕过形态各有 mutation 实测变红。**已知盲区**（注释里点名、不外推）：从别的模块 import 来的值、函数返回值，以及由这两者派生的 spread / `Object.assign` / 多级别名——都需要跨表达式常量求值才能判定。
- **理想架构 / 若做需改什么**：给 `ResponseOutcome` 的 stream-error variant 加一个**只有 `streamErrorOutcome()` 能构造**的 opaque brand/token（例如模块私有 symbol 或 unique-symbol 品牌字段），让类型系统直接拒绝其它构造点。做完之后 AST 守卫可以降级为冗余或删除。需改：`src/lib/pipeline/types.ts` 的 outcome union、driver 内 8 处产出点（已全部走 helper，故改动集中）、以及所有以结构化字面量断言该 outcome 的测试。
- **为何暂缓**：直接静态 mint 已被守卫覆盖，剩余盲区都需要有人**刻意**绕道才会踩到；而 brand 是一次公开类型契约变更，值得单独一个改动 + 正样本对照，不该塞进 abort 归因这条因果链。**在测试里手写半个 TypeScript 常量求值器是明确不采纳的选项**（异模型复审建议，我同意：那会把守卫变成新的维护负担与新的假绿来源）。**触发条件（值得做）**：观测到 gap 计数与实际 incident 数对不上、或有人真的在别处 mint 了这个 outcome、或下次触碰 `ResponseOutcome` 的类型定义。**发现方**：第八轮异模型复审（2026-07-28），它同时指出「一个宣称覆盖面大于实际覆盖面的守卫本身就是假绿」。

## `test:backend` 并发档位存在低频污染型 flaky（2026-07-28，abort 归因收尾期间六次全量的观测）

- **根因 / 现状**：**未定位**。现象是 `bun run test:backend`（`scripts/parallel-test.ts`，16 分片）偶发挂 1 条，**每次挂的是不同的测试**，且**单跑必过**。这是典型的跨文件状态污染或分片间资源竞争，不是被测代码的缺陷。
- **当前行为（六次全量的原始数据，同一棵树、同一 sha）**：run1 ✅ / run2 ✅ / run3 ❌ `tests/pipeline/hooks/loader.unit.test.ts` 的 4 条 `loadUpstreamHook` / run4 ✅ / run5 ❌ 架构测试「legacy Vue `ui/` stays detached from the main chain」/ run6 ✅。`loader.unit.test.ts` 单跑连过 **5/5**。更早在本轮中段还观测到一次 `tests/diagnostics/multiprocess-rotation.it.test.ts`（单跑 3/3 过、全量重跑绿）。**三个互不相关的文件**，指向档位机制而非某个测试。
- **理想架构 / 若做需改什么**：先用 `test:fast:isolated`（已存在，退回非分片）对照确认「污染只在分片模式下发生」；再按 skill `debugging-test-pollution` 的 playbook 二分定位——嫌疑面是**分片间共享的进程级单例**（`loadUpstreamHook` 正是单例 + 版本号语义、`ui/` 那条读文件系统），以及 `scripts/parallel-test.ts` 的**片内共享缓存**是否让同片内的文件互相看见彼此的模块态。修好后应有一条守卫：同一分片内连跑 N 次仍绿。
- **2026-07-30 新数据点（fast 档也中招，扩大了嫌疑面）**：`tests/infra/atomic-fs.unit.test.ts` 的 `atomicWriteJson > crash during writeFile leaves the previous target intact` 在 `bun run test`（**fast 档**，`unit http`）下 6 次跑红 2 次（4757 pass / 1 fail），**单文件隔离连跑 8 次全绿**。此前记录的三例都在 `test:backend`（16 分片）下——现在 fast 档同样复现，说明嫌疑面是**分片机制本身**（片内共享缓存 / 进程级单例），不是 backend 档特有的资源竞争。该文件末次改动 `85937f27`，与 B2 系列无关。发现方：Task 4.2 评审的邻域观测。
- **为何暂缓**：与本轮（abort 归因）因果链无关，且**门本身仍是可信的**——失败是真失败、退出码正确，坏的只是「一次全绿不等于确定性全绿」。定位它需要独立的二分实验，塞进本轮会让本轮的因果链变糊。**触发条件（值得做）**：频率上升到影响交付判断、或某次真回归被当成 flaky 挥手放过（**这正是最危险的失效形态**——本轮就差点把一次环境性红当成「既有失败」）。**发现方**：abort 归因收尾期间连跑六次全量的对照观测（2026-07-28）。

## `parallel-test.ts` 的汇总用例数在同一 commit 上逐次漂移（2026-07-30，B2 Task 4.3a 收口复评）

- **根因 / 现状**：**未定位**。同一棵树、同一 HEAD、同一条 `bun run test:backend` 连跑四次，汇总行的总数为 **6631 / 5741 / 6164 / 5810**，全部 `0 fail`；而不经分片脚本的直接发现稳定在 `Ran 6642 tests across 649 files`。此前 2026-07-28 已记过「系统性欠计 ~25%」（ANSI 修复之后仍欠），本条是新信息：**欠计量不是常数，逐次随机漂移**，说明各分片汇总存在丢失或竞争，而非某类文件被稳定漏读。
- **当前行为**：**门本身仍可信**——退出码由各 shard 决定，真失败照样红（本轮多次实测）。坏的只是「跑了多少条」这个仪表。
- **危害（本轮实际踩到）**：把汇总数当作「用例数不减」的验收证据是**用会漂的尺子量 2 毫米**。B2 系列多轮用过 `6630 → 6631 → 6633` 这类差值，结论碰巧都对（另有运行时名字枚举佐证），但推理不成立。
- **理想架构 / 若做需改什么**：让分片脚本汇总 **junit reporter 的用例名集合**而非解析 stdout 数字；或至少在汇总行标注「计数不可靠，验收请用 `--reporter=junit` 枚举」。修好后应有守卫：同一 commit 连跑 3 次汇总数必须一致。
- **为何暂缓**：与 B2 因果链无关；且**验收有可靠替代**（junit 名字集合枚举，本轮已在用）。**触发条件（值得做）**：① 有人再次用汇总数做增减验收；② 排查分片污染时需要可信基数；③ 顺手修 `parallel-test.ts` 时。
- **发现方**：Task 4.3a 收口复评的邻域实测（连跑四次对照）。**配套纪律**：凡「用例数增减」类验收，一律用 junit 枚举或名字集合 diff，**别用分片汇总数**——与记忆 `methodology-test-name-audit-must-enumerate-at-runtime` 同一族（那条讲别用 grep，这条讲别用汇总数）。

## 仓库内 worktree 里，裸包名 `@hsupu/ghc-proxy-{token,cli}` 解析到**主树**源码（2026-07-29，worktree 委派 gate 评审的邻域实测）

- **根因 / 现状**：`.worktrees/<name>/node_modules` 是指向**主树** `node_modules` 的软链，而其中 `@hsupu/ghc-proxy-*` 又软链回**主树**的 `packages/*`。是否逃逸取决于 tsconfig `paths` 有没有把该 specifier 拦下来：`@hsupu/ghc-proxy-foundation` 与 `@hsupu/ghc-proxy-telemetry` 有裸包名别名（`tsconfig.json:21-22`/`:51-52`）→ 解析回 worktree ✅；`token` / `cli` **只有树内形式的别名**（`~/lib/token`、`~/main` 等）、没有裸包名别名 → 裸名解析到**主树** ❌。逐包实测（worktree 内 `Bun.resolveSync`）：foundation → worktree、telemetry → worktree、token → **主树** `packages/token/src/index.ts`、cli → **主树** `packages/cli/src/main.ts`。
- **当前行为**：**今天没有实际危害**——全仓没有任何真实导入使用 `@hsupu/ghc-proxy-token` / `@hsupu/ghc-proxy-cli` 裸名（`rg` 命中的全是 `tests/architecture/package-boundaries.unit.test.ts` 与 `telemetry-domain-surface.unit.test.ts` 里的**字符串字面量**，用于断言边界规则本身）；生产消费者走 `~/lib/token` / `~/main`，解析在树内。所以这是**潜伏**缺口，不是活的缺陷。
- **理想架构 / 若做需改什么**：给 `token` / `cli` 补裸包名 `paths` 别名（与 foundation/telemetry 对称，两行一个包）；更根本的是加一条守卫——**每个 workspace 包的裸包名都必须在 tsconfig `paths` 里有别名**，否则新拆的包天然带着这个逃逸。守卫应有正样本对照（删掉某个别名要变红）。注意别名只解决 tsc/bun 的 specifier 解析，**不解决** worktree 缺 gitignored 构建产物那一类问题（见记忆 `reference-worktree-bun-add-needs-main-tree-install-after-merge` 前三向）。
- **为何暂缓**：当前零消费者 → 改了也无可观测差异，且它与本轮（B2 上游静默恢复）因果链无关；补别名本身很小，但**配套的守卫**才是真正值钱的部分，值得单独一个改动 + 正样本对照，不该塞进特性分支。**触发条件（值得做）**：① monorepo 拆包推进到「用裸包名消费 token/cli」（`package-boundaries.unit.test.ts:111` 的注释已经预告了这个方向）；② 任何新 workspace 包落地时；③ 在 worktree 里出现「改了包源码但测试行为不变」的诡异症状——那正是这个逃逸的典型表征。
- **发现方**：给用户级 skill `git-preference:isolating-from-a-shared-git-worktree` 补「委派命令树向 gate」时，评审实测出「gate 全绿 + 测试全绿 + 加载的是主树源码」这条通用逃逸（依赖解析向上逃出嵌套 worktree），随后在本仓库逐包复核得到上述不对称。**教训本身**（gate 证 cwd/树/commit，**不证解析根**）已写进该 skill 与记忆第四方向。

## delivery identity 继承已被 explicit allocation-port 架构取代（2026-08-06 渐进合并时关闭）

- **原问题**：B2 分支曾用模块级 `inheritDownstreamDeliverySession(source, decorator, contract)` 把 wrapper 注册进 `deliveryBySink`；改写型 decorator 一旦继承身份，hedge winner 会绕过 reconcile，产生重复 `message_start`、anchor index 冲突与 close-off 丢失。
- **关闭方式**：master 已把 owner 能力改成显式 `wireAllocationPort`，driver 从 `RunResponseOpts.wireAllocationPort` 找 owner，并通过 `getDeliverySessionForAllocationPort()` 取 session；wrapper 不再需要、也不应继承 identity。渐进合并时保留 master 架构，删除旧 workaround 及其 allowlist 守卫。
- **长期形状**：owner 能力通过端口显式穿参，rewriting decorator 只改写 public frame port；这已达成原 backlog 的「让违规不可表达」目标，无剩余待办。原事故与判据保留在 git 历史和 Task 4.1′ plan 注解中。

## shutdown drain source 仍由协调器手工枚举（2026-08-08，无损排空评审整改期间发现）

- **根因 / 现状**：`src/lib/shutdown.ts` 的 production `ShutdownDrainSource.getActive()` 手工拼接 `RequestContextManager.getTrackedOperations()` 与 `listInFlightLightweightModelOperations()`。本轮正是因为旧实现只枚举前者，才漏掉 count_tokens／embeddings；修复后当前两类 operation 已闭合，但模式本身仍要求每新增一种不建 `RequestContext` 的旁路 operation 都记得回来改 shutdown 协调器。
- **结构怪味**：职责错位 + 开放集合手工枚举。operation producer 决定“什么算已接纳”，shutdown 却在外部维护第二份成员清单；下一位复用者仍会踩同类漏接。
- **理想架构 / 若做需改什么**：建立单一 accepted-operation registry／registration port，让 generation 与 lightweight producer 都向同一个只读 drain view 注册；shutdown 只消费该 view，不知道 operation 种类。迁移时保留每类日志投影，补“新增第三种测试 operation 不改 shutdown 也会被 drain”的正控，并保留本轮两个 omission mutation。
- **为何暂缓**：当前只有两类 producer，现有 union 已由真实 HTTP 测试与双 mutation 锁住；抽统一 registry 会改动 `RequestContextManager` 所有权、test bootstrap 与日志类型，是独立架构重构，不影响本轮无损关闭正确性。
- **触发条件**：新增第三种不建 `RequestContext` 的模型 operation，或下一次需要改 `ShutdownActiveOperation` 联合类型时，先做该收敛，禁止继续追加第三个 spread。

## ~~native `list-search` 在过滤前物化全部全文命中~~（A3 review finding 4 — 已关闭，2026-08-08）

- **原问题**：`list_search_blocking` 先 `TopDocs::with_limit(searcher.num_docs()).order_by_score()` 拿到**全部**全文命中，再逐条 `searcher.doc(address)` 解压 stored document，**之后**才套结构 filter、排序、分页。每次列表请求的代价随「命中数」而非「结果数」线性增长。实测坐实：100k 合成语料下，命中率 1% 的 session 过滤与完全不过滤都是 254 ms——过滤器一毫秒都没省下来。
- **关闭方式**：读路径改为 `Query::weight(EnableScoring::disabled_from_searcher(…))` + `Weight::for_each_no_score` 逐段遍历，所有谓词改在列式 fast field 上求值；等值维**在每段解析成一个 term ordinal**，逐文档退化为一次列式 `u64` 读；`model` 子串每段流式扫一遍该字段词典得到 ordinal 集合；幸存者的 `operation_id` 用 `sorted_ords_to_term_cb` **每段一次**批量解析。等值维同时下推进 `BooleanQuery`（`Occur::Must`）收窄 docset，但**下推只允许比逐文档过滤更松**，语义权威仍是后者。`schema()` 给列表路径读的字段全部加 `FAST`、`pid` 加 `INDEXED`，故 `FORMAT_MARKER` v3→v4，走既有的 wipe-and-rebuild 自愈路径（tail cursor 就在该目录内，一并重建，不会有陈旧游标幸存）。
- **冻结契约保持不变**：精确 `total`、`(created_at desc, operation_id desc)` 顺序、keyset 语义、`hasOlder`/`hasNewer`、`invalidCursor` 全部未变——遍历所有命中仍是精确计数的前提，被消除的是评分堆与 stored-doc 物化这两个常数项。
- **实测结果**：20k 语料无过滤列表页 42.8 → 7.0 ms，state+endpoint 过滤 42.8 → 3.1 ms；100k 无过滤 254 → 54 ms，session 过滤 254 → 9 ms，**所有场景无一变慢**。基线工具、逐场景数字、运行间抖动与「它没有证明什么」见 [exp/history-search-list-perf/](../../exp/history-search-list-perf/README.md)。
- **过程中被实测推翻的一版**：只把读取换成 fast field、但逐文档 `ord_to_str` 的第一版，让无过滤列表页**劣化 16 倍**（42.8 → 694.8 ms）——`Dictionary::ord_to_term` 每次调用都从所在 sstable block 首个 ordinal 重新解码。「按段批量解析」不是优化细节，而是这条路径成立与否的分界。
- **未被测试覆盖的一处**：`alive_bitset` 分支。探针实测 tantivy 0.26.1 在本项目写法下 commit 时即物化删除（存活 segment 均为 `deletes: null`），故不可达、禁用它不会让任何测试变红；保留原因与判据写在代码注释与 `daemon.it.test.ts` 对应用例里。

## `pipelineInfo.responseHeaderTimeoutMs` 声明了但从无生产写点（2026-08-08，客户端连接 skill 事实订正的邻域发现）

- **根因 / 现状**：`src/lib/history/types.ts:233` 声明了 `responseHeaderTimeoutMs`，`ctx.setStreamTimeouts()` 的签名（`src/lib/context/types.ts:538`、`src/lib/context/request.ts:1304`）也收这个 patch 键，但**六处生产调用点全都只传 `streamIdleTimeoutMs`**：`src/routes/messages/handler-v4.ts:811,1155`、`src/routes/chat-completions/handler-v4.ts:250`、`src/routes/responses/handler-v4.ts:204`、`src/routes/responses/ws.ts:347`、`src/routes/gemini/handler-v4.ts:221`。唯一写过它的是单测 `tests/context/request-context.unit.test.ts:1225`。
- **当前行为**：功能无缺陷——这是纯诊断字段，缺失不影响请求处理。代价落在**事后归因**：一条 header-timeout 事故的 entry 里没有任何结构化的阈值快照，而 `stale_request_max_age` / `request_deadline` 反倒能从终端 error 文案里取回嵌入秒数（`src/lib/context/manager.ts:329,440` → `_index.derived.failureReason`，`src/lib/history/v3/projection.ts:437`）。于是**四个 wall-clock terminator 里，最像超时的那一个反而最没有证据**，最容易被凭记忆的默认值补上——正是 2026-07-28 那次「609ms 请求被报成 900s header 超时」的同族陷阱。
- **理想架构 / 若做需改什么**：在已经调 `resolveStreamIdleTimeoutMs(...)` 的同六处，一并传 `responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(resolvedName)`（该 resolver 已存在，见 `src/lib/transport/send.ts:222`、`src/lib/anthropic/client.ts:164` 等调用点）。`setStreamTimeouts` 本就是 merge 语义（单测 `:1222` 守着「两次调用累加」），无需改契约、无需 schema 变更。**注意 per-model override 与 `0`=禁用两种情形都要能忠实落盘**，否则字段存在却撒谎，比缺失更糟。
- **为何暂缓**：本轮任务是订正 skill 的陈旧事实，不是补产品接线；且这条要做就该**四个 terminator 一起走结构化字段**（现在 stale/deadline 靠解析错误文案取值，是同一个缺陷的另一面），那是一次独立的可观测性改动，值得自己的判据与 mutation 对照。skill `debugging-claude-client-connection` 已按**当前真实接线**写明取证表（哪一格有值、哪一格必须判「未决」），归因不会因此走错。
- **触发条件（值得做）**：① 又出现一次 header-timeout 归因争议；② 因别的原因要动 `pipelineInfo` 或 `setStreamTimeouts` 时顺手补全；③ 有人打算把 `failureReason` 文案解析写成正式 oracle 时——那说明结构化字段的缺口已经在制造成本。
- **发现方**：`debugging-claude-client-connection` skill 事实订正的独立评审（复评轮 major 1，`docs/tmp/2026-08-08-batch1-client-connection-skill-review.md`），主会话逐个调用点复核确认。

## History persistence registry 的两个 test-seam 生命周期缺口（2026-08-08，`owned-singleton-lifecycle` skill 独立评审的邻域发现）

- **根因 / 现状**：`src/lib/history/worker/registry.ts` 的两个 test seam 各缺一半合同。① `setHistoryPersistenceRuntimeForTests`（`:58-60`）**无条件覆盖** `runtime`，既不处置被顶掉的旧实例、也不把它返还调用方——往一个**已持有 Worker runtime** 的 slot 里 inject，owner 从此永久够不到旧实例，`resetHistoryPersistenceRuntimeForTests` 之后只作用于 replacement，旧 Worker 泄漏且无声。当前安全性靠**调用方纪律**（现有测试先自行 `shutdown()`），不是 setter 自身保证。② `resetHistoryPersistenceRuntimeForTests`（`:63-68`）没有**显式的失败策略**：`await current.shutdown()` reject 时异常直接抛出，而 `runtime` 仍挂着那个已死的旧实例——这正是 skill `owned-singleton-lifecycle` 点名的「三种选择里最糟的组合」（失败可见但状态不可用）。
- **当前行为**：没有已观测的失败。现有调用点都遵守了那条不成文的纪律，`shutdown()` 在现有实现下也不抛。代价是**下一个人照抄它就会中招**——skill 已把它限定为「compare-and-clear 与角色分离的示例，不是完整正例」，并明写「别照抄它的失败处理」，但这是文档层的缓解，不是机制层的。
- **理想架构 / 若做需改什么**：① setter 改为**非空即抛**（slot 已有实例时拒绝，逼调用方先走 owner reset）——这是最强也最省事的一档，本 registry 无真实并发需求，够用；若确需安全替换非空 slot 才上 owner 级 async `replace(next)`，**注意「写在同一函数里」不会让跨 `await` 的替换原子**，须显式指定线性化点并让**所有读写（含 getter 与 lazy-init）参加同一协议**，否则 dispose 期间普通 getter 会拿到正在关闭的实例（详见 skill `owned-singleton-lifecycle`）。**「返回被顶掉的值」只是辅助接缝、不构成保证**——JS/TS 调用方可以无声忽略返回值，拿到了也可以不 dispose。② reset 显式选一条失败策略并写进注释——推荐「先 compare-and-clear 再把错误抛出去」，这样失败可见**且**状态可用；改完补一条测试：`shutdown()` reject 后 `runtime` 已被清、且异常仍传播。③ 顺带补上 skill 里那条本仓尚无的反向测试：在 `shutdown()` 暂停期装入 replacement，断言它幸存（现有 `tests/history/worker/registry.unit.test.ts:42-62` 只暂停 shutdown、断言旧值仍在与完成后清空，**没有**在暂停期装新实例）。**三项的验收 oracle 统一为「落败实例持有的资源可观测地停了」**，不是「引用换了」。
- **为何暂缓**：本轮任务是把这套生命周期合同写成 skill，不是改产品代码；且这两处是 **test seam**，误用后果落在测试可信度而非线上行为，与本轮已闭合的其他项不同档。改动虽小但要新增三条测试并选定失败策略，值得自己的一次验证链。
- **触发条件（值得做）**：① 又有人往非空 slot 直接 inject，或 `shutdown()` 开始会抛（例如 Worker 关闭超时）；② 因别的原因要动这个 registry 时顺手补齐；③ 有第二个域（telemetry / archive / 连接池）要照这个形状写 owner reset 时——那时它就从「一个实例的小瑕疵」变成「被复制的模板」，按 `fix-at-the-shared-base-not-where-you-noticed` 应先修好模板。
- **发现方**：`owned-singleton-lifecycle` skill 独立评审 major 4、5（`docs/tmp/2026-08-08-batch34-test-isolation-and-singleton-review.md`），主会话逐行复核确认（行号亦由该评审纠正）。
