# 02 — 现状精确盘点

> ✅ **v4 已完成**：本文件是**重构前**（2026-06）的 `src/` 现状快照，描述的巨型 handler / 手动散点已被 driver / codec / registry 取代。**当前架构见 [docs/DESIGN.md](../DESIGN.md)**；本文件作历史盘点参照读，file:line 已大幅漂移。

本文件固化重构前的现状，基于对 `src/` 的逐文件盘点。所有 `file:line` 为绝对引用。新会话实现时以此为"现状真相"，但**实现前务必复核行号**（代码会漂移）。

> **总纲发现**：你想要的"数据流驱动 + event bus + 横切 subscriber"**事件分发层已落地**（`src/lib/observability/`），但**数据采集仍是 handler 手动散点**。重构 = 提升编排 + 下沉采集，而非重建总线。

---

## 1. 重试策略系统

### 1.1 策略全集（`src/lib/request/strategies/`）

均实现 `RetryStrategy<TPayload>`（`src/lib/request/pipeline.ts:143`）。`handle` 返回 `{action:"retry", payload, waitMs?, prepareHints?, meta?, learning?}` 或 `{action:"abort", error}`。

| 策略 name | 文件 | canHandle 触发 | handle 修复 | 重入语义 | learning? | onResolved 提交 |
|---|---|---|---|---|---|---|
| `network-retry` | network-retry.ts:32 | `network_error` ∧ 未重试过 | wait 1000ms | **同 payload 重发** | 否 | — |
| `token-refresh` | token-refresh.ts:40 | `auth_expired`(401/403) ∧ 未刷新过 | 刷新 token（副作用） | **同 payload 重发** | 否 | — |
| `body-field-rejection`(别名 context-management-retry) | context-management-retry.ts:69 | `bad_request` 400 ∧ `<field>: Extra inputs are not permitted` | 删被拒 body 字段 + `prepareHints.rejectFields` | **改 payload 重发** | 否 | 即时 `markAnthropicFeatureUnsupported` |
| `legacy-thinking-retry` | legacy-thinking-retry.ts:57 | `bad_request` 400 ∧ `thinking.type.enabled`+不支持 | 改写 thinking→adaptive | **改 payload 重发**（一次性） | 否 | — |
| `unsupported-beta-retry` | unsupported-beta-retry.ts:122 | `bad_request` 400 ∧ `unsupported beta`/`invalid beta flag` | 显式：剥 betas；laconic：子集枚举探测 | **改 header 重发** / **迭代收窄循环** | 仅 laconic | `markAnthropicBetaUnsupported`（探测确认后） |
| `deferred-tool-retry` | deferred-tool-retry.ts:66 | `bad_request` 400 ∧ `Tool reference 'X' not found` | `defer_loading:false` | **改 payload 重发** | 否 | 即时 `markToolUndeferred` |
| `auto-truncate` | auto-truncate.ts:50 | `state.autoTruncate` ∧ (`payload_too_large`413 ∨ `token_limit`) | 学 limit + 截断 messages + 重 sanitize | **专用反复裁剪**（每次从 originalPayload 新鲜截断） | 否 | — |

### 1.2 策略组装（顺序有语义：pipeline 取首个 `canHandle` 为 true）

| 格式 | builder | 列表（顺序） |
|---|---|---|
| Anthropic | `buildAnthropicStrategies` `anthropic/pipeline.ts:163` | network → token-refresh → body-field → legacy-thinking → unsupported-beta → deferred-tool → auto-truncate |
| chat-completions | `createChatCompletionsStrategies` `chat-completions/handler.ts:468` | network → token-refresh → auto-truncate |
| Responses | `createResponsesStrategies` `responses/pipeline.ts:78` | network → token-refresh **only** |

400-class（body-field / legacy-thinking / unsupported-beta / deferred-tool）都 gate 400 但用**互斥消息模式**，故相对顺序当前无冲突。

### 1.3 错误分类（`classifyError` → `src/lib/error/classify.ts:49`）

`ApiErrorType` 全集（classify.ts:15）：`rate_limited`(429/body code) / `payload_too_large`(413) / `token_limit`(400 token 消息) / `content_filtered`(422) / `quota_exceeded`(402) / `auth_expired`(401,403) / `network_error`(socket/ECONNRESET/TLS/fetch failed) / `aborted`(AbortError/TimeoutError，先于 network 故不重试) / `server_error`(≥500) / `upstream_rate_limited`(503 rate body) / `bad_request`(400 兜底 + 非 HTTP 未知)。

Retry-After：`extractRetryAfterFromBody`(parsing.ts:25) + `parseRetryAfterHeader`(error/utils.ts)。**注意**：`apiError.retryAfter` 被分类但无策略消费——429 完全由 pipeline 之下的 rate limiter 处理。

### 1.4 PrepareHints + negotiation cache

- `PrepareHints{excludeBetas?, rejectFields?}`（pipeline.ts:91）**replace 语义**（非 merge），attempt 0 清空。流向：strategy `handle` → pipeline `pendingPrepareHints` → `adapter.execute(payload, hints)` → `prepareAnthropicRequest`。**仅 Anthropic adapter 消费**。
- negotiation cache = `src/lib/anthropic/feature-negotiation.ts`，4 个永久 per-`(baseUrl|model)` map：`features`(拒绝字段) / `betas` / `efforts` / `deferredTools`。持久化 `negotiation-states.json`，debounce 1s。**cache = 跨请求记忆；hints = 单请求重试意图**，二者解耦。

### 1.5 双重试预算 + rate limiter

- normal 预算 = `maxRetries`(默认 3)，learning 预算 = `MAX_LEARNING_RETRIES`=32（pipeline.ts:167）。当前仅 unsupported-beta laconic 用 learning。budget gate 在 `handle()` **之后**，故一次性策略靠实例 flag 自守。
- `AdaptiveRateLimiter`（adaptive-rate-limiter.ts）**在 pipeline 之下**：`adapter.execute` 内 `executeWithAdaptiveRateLimit` 包裹，429 在其内部队列重试，**不冒泡到 pipeline**。stateful singleton，3 模式（Normal/Rate-limited/Recovering）。

**边界总结**：通用机制 = pipeline 核心 + `RetryStrategy`/`FormatAdapter` 接口 + `classifyError` + hints + cache memo 模式 + rate limiter。真正格式无关的策略只有 network-retry / token-refresh / auto-truncate-shell（注入 truncate/countTokens）。body-field / legacy-thinking / unsupported-beta / deferred-tool **全是 Anthropic 专属**（gate Anthropic 400 消息、改 Anthropic 字段、读写 Anthropic-only cache）。

---

## 2. 请求侧改写（出站到上游前）

> 40+ 改写动作，**大多已是独立纯函数**，但串联顺序靠 handler 注释维系。作用对象：H=header、Msg=消息块、Txt=文本、T=tools、Sys=system。

### 2.1 Anthropic sanitize 管道（`src/lib/anthropic/sanitize.ts`，两阶段）

**Phase 1 一次性预处理**（`preprocessAnthropicMessages` sanitize.ts:38）：
- **A1** strip Read tool_result 的 `<system-reminder>` — `state.stripReadToolResultTags` — `sanitize/read-tool-result-tags.ts:17`
- **A2** tool_use/result 去重 + 相邻同角色合并 — `state.dedupToolCalls` — `sanitize/deduplicate-tool-calls.ts:13`

**Phase 2 可重复清洗**（`sanitizeAnthropicMessages` sanitize.ts:76，顺序固定）：
- **A3** system prompt 去 reminder — 始终 — `sanitize/system-prompt.ts:15`
- **A4** messages 去 reminder — 始终（标签策略 `state.rewriteSystemReminders`） — `sanitize/system-reminders.ts:92`
- **A5** 内联 `role:"system"` 消息处理 — `state.systemDefaultMode` — `sanitize/system-messages.ts:102`
- **A6** 历史 server-tool 块降级 — `state.rewriteServerTools` — `sanitize/rewrite-server-tool-blocks.ts:123`（**必须先于 A8**）
- **A7** 丢损坏 thinking 块 — `state.thinkingBlockSanitizeCheck` — `sanitize/content-blocks.ts:70`（**先于 A8**）
- **A8** tool 块统一处理（名称修正 + input 解析 + 孤儿过滤 + 空消息丢弃） — 始终 — `sanitize/tool-blocks.ts:32`
- **A9** 终末空 text 块清理 — 始终 — `sanitize/content-blocks.ts:11,30`

### 2.2 Anthropic tool 预处理（`message-tools.ts`，**必须先于 sanitize**）

- **T1** 补 input_schema — 始终 — `:178`
- **T2** 注入 tool_search + 标 defer_loading — `state.toolSearchEnabled` ∧ 模型支持 — `:166,182`
- **T3** 注入 Claude Code 官方 tool stub — `state.injectClaudeCodeOfficialTools` — `:208`
- **T4** 为历史引用注入缺失 tool stub — 隐式 — `:226,280`
- **T5** 应用 sticky un-defer（negotiation 学到） — cache — `:294`
- **T6** 剥离 server tools — `state.stripServerTools` — `:340`（实际在 request-preparation 的 buildWirePayload 调）
- **T7** tool-name sanitize — `state.sanitizeToolNames` — `sanitize/tool-name-sanitize.ts:83`（mapper 在 preprocess 前构建，应用在 preprocess 后、sanitize 前）

### 2.3 Anthropic 请求准备（`request-preparation.ts:134`，每 attempt 调，固定顺序）

- **B1** buildWirePayload 裁剪 body 字段 — `state.rejectBodyFields`+cache+hints — `:197`
- **B2** stripServerTools（=T6） — `state.stripServerTools` — `:232`
- **B3** coerceAdaptiveThinking — `state.coerceAdaptiveThinking` — `:285`
- **B4** adjustThinkingBudget（clamp） — model metadata — `:309`
- **B5** clampEffortLevel — `state.effortsOverrides`+cache+metadata — `:470`
- **B6** applyCacheControlMode — `state.cacheControlMode` — `:517`
- **B7** 删 context_management（不支持时） — cache — `:162`
- **B8** buildAnthropicBetaHeaders — model 能力 — `features.ts:178`
- **B9** mergeAnthropicBeta — client header — `features.ts:214`
- **B10** filterUnsupportedBetas — `state.stripBetaHeaders`+cache+hints — `:113`
- **B11** 固定 header（X-Initiator/version/vision/intent） — 内容推断 — `:174`
- **B12** buildContextManagement — `state.contextEditingMode`+trigger/keep — `features.ts:256`

驱动：`features.ts`（能力检测+beta+context_mgmt 构造）、`feature-negotiation.ts`（运行期学习 cache）、`per-model-config.ts`（per-model 匹配）。

### 2.4 OpenAI 侧

**CC sanitize**（`openai/sanitize.ts:123`）：O1 拆 system/developer / O2 去 reminder / O3 孤儿 tool_result / O4 孤儿 tool_calls / O5 保证首条 user / O6 终末去空 / O7 tool-name sanitize。
**CC prepare**（`openai/request-preparation.ts`）：O8 max_tokens→max_completion_tokens / O9 固定 header / **O10 无 max_tokens 时填充（内联 handler.ts:206）**。
**Responses**：O11 stripImageGenerationTool（`state.stripImageGenerationTool`）/ O12 normalizeCallIds（`state.normalizeResponsesCallIds`，**请求侧**）/ O13 Responses tool-name / O14 prepareResponsesRequest（header，wire 透传）。
**Responses→CC 回退**：O15 translateResponsesToChatCompletions（单向，不可重复）。

### 2.5 system prompt（`src/lib/system-prompt/`）

S1 processAnthropicSystem / S2 processOpenAIMessages / S3 processResponsesInstructions（overrides+prepend+append，`state.systemPromptOverrides`，**非幂等**故只在 handler 入口调一次）；S4 reminder 规则引擎（`state.rewriteSystemReminders`，被 A1/A3/A4/O2 复用）。

### 2.6 散点结论

**已模块化（可直接抽 transform）**：A1–A9 / T1–T7 / B1–B12 / O1–O15 / S1–S4 全是导出纯函数。
**当前内联在 handler / 私有的（重构重点）**：
1. Anthropic sanitize 闭包（`messages/handler.ts:264` 把 preprocessTools→toolNameSanitize→sanitize 串成内联 `directSanitize`，`:324` 又重复一遍）。
2. CC max_completion_tokens 填充（O10，handler.ts:206 内联）。
3. mapper 构建时机（T7/O7/O13 隐式时序耦合）。
4. **prepare 子步骤（B3→B4→B5→B6、B8→…→B12）由 `prepareAnthropicRequest` 函数体顺序硬编码，子步骤 file-local 私有未导出，外部无法重排**。
5. O12/normalizeCallIds 多路径重复调用。
6. web_search 双跳用裁剪版 sanitize（`orchestrator.ts:283` 只跑 Phase 2，故意不跑 preprocessTools/T7）。

---

## 3. 响应侧改写（上游 SSE 收到后、转发客户端前）

三类角色：**R=改写**（改转发字节，原始入 sseEvents、改写后入 forwardedSseEvents）/ **T=翻译回客户端**（换协议外壳，S6）/ **O=旁路观测**（accumulator 记录不改流）。

### 3.1 Anthropic（`messages/handler.ts`）

- **A1** createServerToolBlockFilter（server-tool 过滤+工具名还原 A1b） — 逐帧 — 始终 — `server-tool-filter.ts:102` — **R**
- **A2** createToolInputStreamDecoder — 整体累积后改写 — `state.decodeToolInputFields` — `decode-tool-input.ts:83` — **R**
- **A3** applyThinkingSignatureCompat — 逐帧（单→多帧） — `state.thinkingSignatureCompat` — `thinking-signature-compat.ts:69`（短路 return） — **R**
- **A4** startForwardedSseHeartbeat — 合成注入 — `state.anthropicFakeSseHeartbeat` — `handler.ts:873` — **R**

非流式按序：truncation marker → filterServerToolBlocksFromResponse → restoreToolNamesInResponse → decodeToolInputBlocksInResponse（handler.ts:949-961）。

### 3.2 OpenAI CC（`chat-completions/handler.ts`）

- **C1** restoreStreamToolNames — 逐帧 — tool-name sanitization — `:702` — **R**
- **C2** truncation marker chunk — 合成注入 — `state.verbose ∧ wasTruncated` — `:646` — **R**

### 3.3 OpenAI Responses（`responses/handler.ts`）

- **P1** createStreamIdTracker+fixStreamEventIds — 逐帧（跨帧 id 映射） — `state.fixResponsesStreamIds` — `stream-id-sync.ts:37` — **R**
- **P2** restoreResponsesEventToolNames — 逐帧 — tool-name sanitization — `:355` — **R**

### 3.4 累积器（全部 O=旁路观测）

三个 `accumulateXStreamEvent(event, acc)` 只 mutate acc，**不改转发帧**。完成后 `recording.ts` 的 `buildXResponseData` 读 acc 重建 history response。**例外**：Anthropic `acc.streamError`（上游中途 error 事件）被 handler:609 读来决定 fail vs complete——唯一对控制流有影响的累积输出。

### 3.5 错误帧格式化（中途错误 → 各协议 error 帧）

共享 `classifyStreamError`（`stream.ts:63`，归一为 idle-timeout/shutdown/client-abort/other）：
- Anthropic `anthropicStreamErrorType`（`handler.ts:474`）→ `event: error`
- OpenAI CC+Responses `streamErrorToOpenAIErrorType`（`openai/stream-error.ts:22`）
- Gemini `geminiStreamErrorStatus`（`gemini/handler.ts:363`）→ data-only candidates + sidecar error

### 3.6 stream guard（最外层生命周期容器）

`guardSseIterable`（`stream.ts:212`）包裹上游 iterable，每 `.next()` race idle-timeout + shutdown + client-abort。**使用不对称**：CC/Responses/Gemini 用 `guardSseIterable`，**Anthropic 不用**（用 `processAnthropicStream` `anthropic/stream.ts:58`，逻辑等价但代码分叉）——这是统一时首要对齐对象。

### 3.7 交织结论

Anthropic handler 把所有角色塞进一个手写 pump（`processOneStreamEvent` handler.ts:692 顺序穿插 raw 记录→计数→repetition→A3→A2→A1）。三协议转发链各自手写、顺序语义不同（Anthropic decoder→filter，CC 仅 restoreNames，Responses fixIds→restoreNames），无统一 transform 列表。`sseEvents`/`forwardedSseEvents` 写入点分散。

---

## 4. codec 翻译层 + 透传判断

### 4.1 判断原语（`src/lib/models/endpoint.ts`）

`isEndpointSupported`(endpoint.ts:47) — **缺 supported_endpoints 一律 true**（legacy 假设）；`isResponsesSupported`(56)；`isWsResponsesSupported`(67) — **缺则 false**（不隐式启用，与前者默认相反）。

### 4.2 透传/翻译决策矩阵

| 接入格式 | 模型 supported_endpoints | 动作 | 上游端点 | 判断点 |
|---|---|---|---|---|
| Anthropic `/v1/messages` | vendor=Anthropic ∧ `/v1/messages` | 透传 | `/v1/messages` | features.ts:35 + messages/handler.ts:165 |
| Anthropic | vendor≠Anthropic 或无端点 | **400**（无降级） | — | messages/handler.ts:166 |
| CC `/chat/completions` | `/chat/completions` | 透传 | `/chat/completions` | cc/handler.ts:305 |
| CC | 仅 `/responses` | **翻译 CC→Responses** | `/responses` | cc/handler.ts:309 |
| CC | 都不支持 | **400** | — | cc/handler.ts:316 |
| Responses `/responses` | `/responses`, vendor≠Google | 透传（HTTP 或 ws） | `/responses`/`ws:` | responses/handler.ts:139 + responses-client.ts:112 |
| Responses | vendor=Google(force) | **翻译 Responses→CC** | `/chat/completions` | fallback.ts:85 |
| Responses | 无 `/responses`，有 `/chat/completions` | **翻译 Responses→CC** | `/chat/completions` | handler.ts:139 |
| Responses | 都不支持（非 force） | **400** | — | handler.ts:145 |
| Gemini `:generateContent` | **不检查端点** | **总是翻译 Gemini→CC** → 复用 CC 管线 | （CC 二次判断） | gemini/handler.ts:77,93 |

### 4.3 翻译拓扑（星型 + 旁路，中枢 = OpenAI CC）

| 翻译边 | 方向 | 触发 | 无损? | 代码 |
|---|---|---|---|---|
| Gemini ↔ CC | 双向 | Gemini 接入（无条件） | **有损**（LOSSY_TOP_LEVEL_KEYS；tool-finish→STOP） | `gemini/convert-*` |
| Responses ↔ CC (fallback) | 双向 | Responses 接入 ∧（无 /responses ∨ Google） | 有损（call_id 重写） | `translate/responses-to-cc-request.ts` |
| CC ↔ Responses (via-responses) | 双向 | CC 接入 ∧ 仅支持 /responses | 有损（DROPPED_PARAMS: stop/n/penalties/logit_bias/logprobs/seed） | `translate/cc-to-responses.ts` |
| Anthropic | 旁路直连 | vendor=Anthropic | **N/A 不翻译** | `messages/handler.ts` |

**透传判断散落在 4 处**（messages:165 / cc:305 / responses:138 / responses/ws:202）+ 1 旁路传输点（responses-client:112 HTTP vs WS）。形态各异（Anthropic vendor+endpoint 双门 / CC 三分支 / Responses useFallback 布尔+force-list / Gemini 无 gate）。**统一时注意 3 个非一致默认**：isEndpointSupported 缺=true、isWsResponsesSupported 缺=false、Gemini 无 gate、Responses force-list 绕过 CC 检查。

### 4.4 model 解析（`models/resolver.ts:203`）

`resolveModelName`：bracket 归一 → 整名 override → modifier 后缀 → core 别名 → 再 override。**严格先于端点判断**（所有 handler 先 resolve → 取 selectedModel → 再透传判断）。

### 4.5 Azure 注入（`azure-openai/route.ts:46`）

`injectDeploymentModel` 从 path `:deployment` 注入 `injectedPayload`+`azureModelOverride`，**不变异 body**，复用 CC/Responses/Embeddings handler。

---

## 5. context + history + 原始数据记录

### 5.1 现状定性

**事件分发已驱动化**（`HistorySink` 订阅 bus，`consumers.ts` 已删），但**数据采集未驱动化**（bus 上的值靠 handler 手动调 setter 填充）。

### 5.2 RequestContext（`src/lib/context/request.ts`）

状态机（`RequestLifecycleState` types.ts:31）：`pending`→`executing`→`streaming`→终态`completed`/`failed`/`aborted`（+reaper 写 `interrupted`）。无转移白名单。

公开方法全集见 types.ts:225-385 / request.ts:259-674。关键：`setOriginalRequest` / `setInboundRequestHeaders` / `setAttemptEffectiveRequest`(pipeline 自动) / `setAttemptWireRequest` / `setSseEvents` / `setForwardedResponse` / `setHttpHeaders` / `setPipelineInfo` / `beginAttempt`(pipeline 自动) / `recordAttemptFailure`(pipeline 自动) / `setResolvedModel`/`recordFeature`/`recordStreamProgress`（**仅新 bus**） / `complete`/`fail`/`abort` / `toHistoryEntry`。

**双轨发射并存**：legacy `emit()`→manager `onEvent`，新 `publisher.publish()`→bus。manager `handleContextEvent`(manager.ts:244) 把 legacy 事件翻成两份（旧 emit + 新 publish）——新旧桥接核心。

### 5.3 记录注入点（自动 vs 手动散点）

**pipeline 自动**：beginAttempt / setAttemptEffectiveRequest / transition("executing") / setAttemptError / recordAttemptFailure（pipeline.ts:237-363）。
**handler 手动散点**：setOriginalRequest / setInboundRequestHeaders / setResolvedModel / **setAttemptWireRequest** / setHttpHeaders / recordStreamProgress / recordFeature / **setSseEvents** / setForwardedResponse / setPipelineInfo。

### 5.4 原始数据双轨字段（`HistoryEntry` types.ts:211）

| 字段 | 语义 | 轨 |
|---|---|---|
| `inboundRequest` | 客户端原始 payload | 原始入 |
| `httpHeaders.inboundRequest` | 客户端原始头 | 原始入 |
| `effectiveRequest` | 改写后逻辑请求（final attempt） | 改写后 |
| `outboundRequest` | **实发上游 wire**（final attempt） | wire |
| `outboundResponse` | **上游原始响应** | 上游原始 |
| `sseEvents` | **上游原始 SSE 帧**（offsetMs/type/raw verbatim） | 上游原始 |
| `inboundResponse`(ForwardedResponse) | **客户端实收**（post-rewrite） | 改写后/客户端侧 |
| `attempts[]` | 每 attempt 全量（effective+wire+response+error+sanitization+truncation） | 双轨/每尝试 |
| `warningMessages`/`pipelineInfo`/`truncation`/timing/`process` | 诊断/计时/进程身份 | — |

**双轨核心**：请求 `inboundRequest`→`effectiveRequest`→`outboundRequest`；响应 `outboundResponse`+`sseEvents`(上游原始) ↔ `inboundResponse`(客户端实收)。
**最大缺口**：`sseEvents`(上游原始帧) 和 `pipelineInfo` **仅 Anthropic messages 写入**；CC/Responses/Gemini/ws 流式**只记 forwardedResponse.sseEvents（客户端侧），不记上游原始**。这是 driver 自动采样要补的首要项。

### 5.5 history 存储层

`store.ts`(barrel) / `entries.ts`（CRUD + `finalizeEntry`(122 显式终态写库) + 增量持久化 persistEntryEager/Status/Stages） / `in-flight.ts`(内存映射 WS 源) / `sqlite/`（schema `entries_v2` head〔含 `session_id`/`agent_id` 列〕 + `entry_stages` 按 stage/attempt 拆 blob；serialize/write/read/compression/reaper）。生命周期：insertEntry→updateEntry/persistStages→finalizeEntry。**注**：`entry_lineage`/`entry_produced_tool_ids`/`sessions` 物化表已退役（lineage 删除 + sessions 改 entries-derived `GROUP BY session_id`，connection 启动期 DROP 旧表）。

### 5.6 三大能力提供方（稳定契约不可破）

| 能力 | 提供方 | 契约 |
|---|---|---|
| ① 全面 API | `routes/history/route.ts` REST（`/history/api/entries`(:24)、`/entries/:id`(:49 全量)、`/stats`、`/export`…）+ `routes/stats/route.ts`（`/api/stats` 运营维度 breakdown） | `/entries/:id` 返回全量双轨 HistoryEntry；`/lineage`·`/conversations`·`/sessions` 已退役 |
| ② 日志访问 | `/api/logs`(logs/route.ts:19)、`/api/status`(status/route.ts:35)、`ConsoleSink`、`request-telemetry`、WS topic history/status | getHistorySummaries 形状、WS wire 协议 |
| ③ 原始数据记录 | `HistoryEntryData`+`toHistoryEntry()`+`HistorySink`+sqlite `entry_stages` | 双轨字段集 + per-attempt 全量 |

其它调试端点：`POST /api/debug/dry-run-truncate`(debug/route.ts:103)、`/api/config`+`/api/config/yaml`、`POST /api/event_logging/batch`(吞遥测)。

### 5.7 observability（`src/lib/observability/`）

`bus.ts`(createBus/scope/subscribe/publish，命名空间 request/history/system 由 template-literal 强制隔离) / `events.ts`(`ObservabilityEvent` 判别联合 + `assertNever`) / 4 sink（history/ws/telemetry/console，`start.ts:353` 装配） / `middleware.ts`(observabilityMiddleware，server.ts:73 挂载，`await next()` 后 `completeFromHttpStatus` 兜底终态)。第二层兜底 = manager stale reaper。

---

## 6. client + 上游收发 + WS + rate limit

### 6.1 三 client（无状态单次 fetch，prepare+fetch 强绑定）

| client | 文件 | 端点 | prepare | 内循环 | rate-limit 包裹处 |
|---|---|---|---|---|---|
| createAnthropicMessages | anthropic/client.ts:93 | /v1/messages | prepareAnthropicRequest（**每 attempt**） | **2-attempt invalid_reasoning_effort 循环**(:100) | anthropic/pipeline.ts:124 |
| createChatCompletions | openai/chat-completions-client.ts:52 | /chat/completions | prepareChatCompletionsRequest（单次） | 无 | cc/handler.ts:345、fallback:168 |
| createResponses | openai/responses-client.ts:80 | /responses 或上游 WS | prepareResponsesRequest（单次） | 无 | responses/pipeline.ts:52、cc:398 |

共性骨架：token 检查 → prepare → `onPrepared`(history 快照) → `combineAbortSignals` → `fetch(DISABLE_BUILTIN_FETCH_TIMEOUT)` → captureHttpHeaders → `!ok` 抛 HTTPError → `stream ? events(response) : json()`。

### 6.2 通用收发机制（格式无关，可作共享传输层）

`fetch-utils.ts`(超时信号/`DISABLE_BUILTIN_FETCH_TIMEOUT`/header 捕获脱敏) / `copilot-api.ts`(base+ws URL/copilotHeaders) / `proxy.ts`(undici dispatcher/SOCKS/keepalive/超时映射，Node 路径；Bun 仅 env) / `adaptive-rate-limiter.ts`(singleton，对 fn 透明) / `stream.ts`(combineAbortSignals/raceIteratorNext/guardSseIterable/iterateSseEvents)。SSE 解析靠第三方 `fetch-event-stream` 的 `events(response)`。

### 6.3 上游 WS（Responses 专用，`openai/upstream-ws.ts`）

manager singleton + 半开熔断（MAX_CONSECUTIVE_WS_FALLBACKS=3，DISABLE_RECOVERY_WINDOW=5min）+ 连接池（DEFAULT_MAX=32，`state.maxUpstreamWsConnections`，超 cap 驱逐最旧 idle）+ 复用 key（statefulMarker=previous_response_id 强 / conversationId 弱）。何时用：`wire.stream && state.upstreamWebSocket && !disabled && isWsResponsesSupported(model)`。失败回退 HTTP。`/api/status.upstream_ws` 暴露状态。

### 6.4 客户端侧 Responses WS（`routes/responses/ws.ts`，代理对下游）

复用 HTTP 同套 pipeline。`client_ws_keep_open`(完成后是否关) / `max_ws_frame_bytes`(默认 1MiB) / `max_client_ws_connections`(默认 256)。

### 6.5 路由注册（`routes/index.ts:41`）

每格式注册多前缀（无前缀/v1/openai/v1/anthropic）。`route.ts` 薄包装（try/catch+forwardError）vs `handler.ts` 真逻辑。WS 路由在 `start.ts:471` 经 `createWebSocketAdapter` 单一共享 adapter 注入。**embeddings 不走 pipeline/history**（直接 createEmbeddings，无快照/重试需求）。

### 6.6 client ↔ prepare 耦合点（重构关键）

每 client 在**每 attempt 内**调 `prepare*Request(payload, opts)`，`opts` 携带 per-attempt 改写指令（Anthropic 的 excludeBetas/rejectFields 由 PrepareHints 注入）。即"请求改写嵌在收发函数内部"。**解耦方向**：把 prepare 提到"请求改写"阶段，纯收发层只接 `{wire, headers}`，退化为 `fetch(wire)→SSE|JSON`。Anthropic 的 `learnEffortsFromError` 2-attempt 内循环是最该被提升为 pipeline strategy 的点。
