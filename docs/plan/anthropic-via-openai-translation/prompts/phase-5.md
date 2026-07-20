# Phase 5 Kickoff：反向格子接线（cc/responses/gemini → messages 出站）

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。**Phase 0（router）+ 1（路由骨架+二维门控）+ 2（hub+请求翻译）+ 3（非流式响应两向）+ 4（流式两向+handler 缝合）已 landed master**，你建其上。

## 背景与为什么

copilot-api-js 正建通用「入站×出站」翻译矩阵（4 入站 anthropic/openai-cc/openai-responses/gemini × 3 出站 `/v1/messages`、`/chat/completions`、`/responses`），让任意客户端 SDK 用任意 GHC 模型。**前向腿全通**（Phase 0-4）：Anthropic `/v1/messages` 客户端可 `@cc`/`@responses` 用 OpenAI 协议腿的模型（请求 + 非流式响应 + 流式响应都翻译好了）。

**Phase 5 补最后一块：反向格子**——cc/responses/gemini 客户端 `@messages` 用 direct-Anthropic 腿的模型（如 OpenAI 客户端想用 claude-opus-4.8 经 `/v1/messages` 上游）。方向：

```
客户端 CC/Responses/Gemini body ─(请求翻译 CC→Anthropic)─► 上游 /v1/messages
上游 Anthropic 响应 ─(响应翻译 Anthropic→CC)─► 客户端 CC/Responses/Gemini
```

请求侧翻译器（`cc-to-anthropic-request.ts`）已在 Phase 2 建好、非流式响应翻译器（`anthropic-to-cc.ts`）已在 Phase 3 建好——但**都未接进 cc/responses/gemini codec**（它们的 `translateOut` 是 identity、`prepareWire` 对 MESSAGES 腿显式 throw、`renderResponse*` 不识别 MESSAGES 腿）。**反向流式响应翻译器（`anthropic-to-cc-stream.ts`）还没建**。Phase 5 = 建反向流式 translator + 把三个客户端 codec/handler 接到 direct-Anthropic 上游腿。

## ⚠️ 反向腿与前向腿的关键差异（别照抄前向）

| 维度 | 前向腿（anthropic→cc，Phase 4）| 反向腿（cc→messages，Phase 5）|
|---|---|---|
| 客户端 | Claude Code（`@anthropic-ai/sdk`）| cc/responses/gemini SDK |
| 上游 | CC/Responses SSE | **Anthropic SSE** |
| 出站给客户端 | Anthropic SSE（byte-critical）| **CC/Responses/Gemini SSE**（各自 byte-critical）|
| **心跳** | **复用 Anthropic anchored sink**（300s 断连）| **无心跳**（客户端非 Claude Code；cc/responses/gemini 现状 pump 就无心跳，别加 anchor）|
| render 方向 | CC→Anthropic（`cc-to-anthropic-stream.ts`）| **Anthropic→CC**（新 `anthropic-to-cc-stream.ts`）+ responses/gemini 再 CC→其格式 |
| translateOut | anthropic codec CC-化 body | **cc/responses/gemini codec Anthropic-化 body**（经 hub `translateRequestVia(fmt, MESSAGES, body)`）|
| prepareWire | cc delegate 产 CC wire | **codec 产 Anthropic wire**（`prepareAnthropicRequest`）|
| 上游改写/策略 | targetEndpoint=CC/Responses | **targetEndpoint=MESSAGES → Anthropic sanitize + Anthropic strategies**（`assembleStrategiesForEndpoint(MESSAGES, {anthropic})` 已备好机制，从翻译后 Anthropic body 供料，非从 anthropic codec）|

**核心洞察（RFC §3.1 二维门控）**：反向腿 clientFormat=cc/responses/gemini（定 render/无心跳）、targetEndpoint=MESSAGES（定 Anthropic 上游改写/策略/wire）。**上游 Anthropic wire 处理该 fire**（与 anthropic-direct 同 targetEndpoint）。

## 必读

- [RFC](../../rfc/2026-07-11-anthropic-via-openai-translation.md) **§8.2（反向 Anthropic→CC 流式状态机 + 完整帧集下沉）、§9（WARN-E 反向硬约束清单）、§7.1（策略/改写 registry 全格式装配 + 供料按 targetEndpoint）、§7.3（上游截断保护归属 + 反向不享 L2 buffered-retry）、§3.1（二维门控轴）、§4.2（hub 共享层）**。
- [master plan Phase 5](../plan.md#phase-5反向格子接线ccresponsesgemini--messages-出站)（T5.1-T5.4 + 前置门控 W2/W3/W4）+ Phase 0/1/2/3/4 实施记录（尤其 codec 接线范式）。
- [探针 PROBE-FINDINGS](../../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md) **Probe 3（W2 已实测 CLEARED：GHC Anthropic 腿接受任意前缀入站 tool_use.id，`call_*`/`fc_*` verbatim 透传成立，无需 id 归一）**。
- **真实反向帧集**（逐帧表锚点）：[stream-accumulator.ts:150-360](../../../src/lib/anthropic/stream-accumulator.ts#L150)——顶层 8 类事件 + block start 6 类 + delta 4 类的权威真实处理。
- 现有镜像参照：
  - [cc-to-anthropic-stream.ts](../../../src/lib/openai/translate/cc-to-anthropic-stream.ts)（正向流式 translator——**反向是它的镜像**：renderFrame/flush/getMeta 自供、单调 index、event-line 全合成点、多 choices，但方向相反）。
  - [anthropic-to-cc.ts](../../../src/lib/openai/translate/anthropic-to-cc.ts)（反向**非流式** translator——block→CC 折叠、thinking/server-tool 丢弃、stop_reason/usage 映射，流式版复用同一映射语义）。
  - [responses-to-cc-stream.ts](../../../src/lib/openai/translate/responses-to-cc-stream.ts) / [cc-to-responses 流式](../../../src/lib/openai/translate/responses-to-cc-request.ts)（`createCCToResponsesStreamTranslator`，responses 二跳的第二段）。
  - [codec/anthropic/codec.ts](../../../src/lib/codec/anthropic/codec.ts)（前向腿持 cc delegate + translateOut/prepareWire/renderResponse/createResponseAccumulator 按腿分派的**范式**，反向镜像它）。
  - [codec/openai-cc/codec.ts:369-400](../../../src/lib/codec/openai-cc/codec.ts#L369)（`prepareOpenAiCcWire` 对非-CC/Responses 腿现状 throw，你把 MESSAGES 腿接上）。
- skill `ghc-anthropic-upstream`（thinking signature 400/反向红线）、`debugging-frontend-tests`（非前端但 codec 单测隔离）、`large-refactor`（§4 golden 预捕获、§5 逐帧穷举表、§7 byte-critical 校准）、`empirical-verification`、`verifying-authoritative-claims`（别继承注释当已验证事实）。

## 目标

反向格子端到端打通，**现状 6 格 + 前向翻译腿逐字节零回归 + cc/responses/gemini `@messages` 反向腿（请求 + 非流式 + 流式）全通**。

## Task（每个一 commit，每 commit 现状零回归 + typecheck 绿 + Phase 0 router golden 52 全过 + 新单测过）

### T5.0 前置门控 W3 + W4（先做，小改动打底）

- **W3 反向 empty/占位守卫**（[cc-to-anthropic-request.ts](../../../src/lib/openai/translate/cc-to-anthropic-request.ts)）：反向请求翻译器接上游前须补守卫（空串/空 content 撞 GHC 400 风险）——
  - `toolMessageToResultBlock`：`tool_call_id` 缺失时现产 `tool_use_id:""`（空串失配 assistant 的 tool_use → GHC 400）。加守卫（缺失时 warn + 跳过该 tool_result 或用可辨识占位，**别静默产空串**，never-swallow）。
  - `translateUserMessage`：空 content 数组现产 `content:[]`（正向 `translateAssistantBlocks` 已用 undefined 守卫、反向未对称）。加对称守卫。
  - 单测逐项：缺失 tool_call_id、空 content、混合。
- **W4 @responses 前向腿端到端 IT**（Phase 2 遗留，Phase 3 IT 只覆盖 @cc 腿到 CC wire）：`@responses` 前向腿产 Responses-shaped wire（input[] 非 messages[]）补端到端 IT（走真 codec+driver+router、mock transport、`strategies:[]` 注入绕过 A1）。这是**前向腿的补测**，非反向；放这里因它是 Phase 5 前置账（plan W4）。

### T5.1 反向流式 translator `anthropic-to-cc-stream.ts`（byte-critical，最难）

建 `src/lib/openai/translate/anthropic-to-cc-stream.ts`：`createAnthropicToCcStreamTranslator(modelId)`（`renderFrame/flush/getMeta` 自供，结构镜像 `cc-to-anthropic-stream.ts`）。**产 CC SSE 帧（canonical）**——responses/gemini 客户端再由各自 codec 二段 CC→其格式（对齐非流式 `renderResponseNonStreamingVia(MESSAGES)` 返 CC-canonical 让客户端 codec 二跳的做法）。

**逐帧穷举表（§8.2 FAIL-A' 收口，锚定真实帧集 [stream-accumulator.ts](../../../src/lib/anthropic/stream-accumulator.ts#L150)）**——反向 translator 是 byte-critical，须给每类上游 Anthropic 帧 → CC 映射/丢弃/swallow 的穷尽处理：

| 上游 Anthropic 帧 | 反向 CC 处理 |
|---|---|
| `message_start` | 记 message id/model/input usage（占位）；**不直发 CC chunk**（CC 首 chunk 是 role delta）。首个内容帧时发 CC role chunk（`delta:{role:"assistant"}`）。|
| `content_block_start` type=`text` | 开 text 块（记 index→CC 无 block 概念，text 直接进 `delta.content`）|
| `content_block_start` type=`tool_use` | 开 tool_use 块 → CC `delta.tool_calls[{index, id, type:"function", function:{name, arguments:""}}]`（W1：Anthropic block index → CC tool_calls[].index 需**独立 tool 计数器**，text 块不占 CC tool index）|
| `content_block_start` type=`thinking`/`redacted_thinking` | **丢弃**（CC 无 thinking 通道，`hasThinking:false`；**绝不反向合成**——§9 红线，但这是响应侧丢弃非请求侧合成，安全）|
| `content_block_start` type=`server_tool_use` | **剥离/降级**（CC 无对应，drop——主干非边角）|
| `content_block_start` 其它（`*_tool_result` server 块 / generic）| **丢弃**（CC 无对应）|
| `content_block_delta` `text_delta` | → CC `delta.content` 增量 chunk（仅当目标块是 text 块）|
| `content_block_delta` `input_json_delta` | → CC `delta.tool_calls[{index, function:{arguments: partial_json}}]`（对应已开 tool 块的 CC index）**——但仅当目标块在保留集（tool_use）**；若目标块在**丢弃集**（server_tool_use / thinking / server_tool_result / generic）则 **swallow**（reviewer MEDIUM：`input_json_delta` 在累加器里同服务 tool_use + server_tool_use，[stream-accumulator.ts:333](../../../src/lib/anthropic/stream-accumulator.ts#L333)；无条件映射会造幻影 CC tool_call/撞未映射 index）。**实现须按 `block index → 处置` map 判定每个 delta 的目标块是否已被丢弃。**|
| `content_block_delta` `thinking_delta`/`signature_delta` | **丢弃**（thinking 通道）|
| `content_block_stop` | **无 CC 对应帧**，靠 message_delta 的 finish_reason 收尾（状态机核心转换——只关内部块状态，不发帧）|
| `message_delta`（`stop_reason` + `usage`）| `stop_reason`→CC `finish_reason`（映射复用 `anthropic-to-cc.ts` 的 `mapStopReason` 语义：tool_use→tool_calls、max_tokens→length、refusal→content_filter、余→stop）；`usage`→CC usage chunk（**净值约定**：Anthropic input_tokens 是净 uncached、CC prompt_tokens 是含 cache 总量，须加回 cache legs——复用 `anthropic-to-cc.ts` 的 `mapUsage` gross-up 逻辑，别重犯 W-rev 少计）|

**usage 接线两细节（reviewer MEDIUM 疑点 6）**：
- `mapUsage` / `mapStopReason` 现是 [anthropic-to-cc.ts](../../../src/lib/openai/translate/anthropic-to-cc.ts) 的 **file-local**（barrel 只导出 `translateAnthropicResponseToCC`）——反向流式复用须先 **export 这两个 helper**（或抽共享模块，对齐 `fix-all-comparison-sites` 单一事实源），别复制粘贴逻辑。
- **流式 usage 不是单个现成对象**：Anthropic 流式 input+cache 来自 `message_start`（[stream-accumulator.ts:209-218](../../../src/lib/anthropic/stream-accumulator.ts#L209)）、output 来自 `message_delta`——反向 translator 内部累进（用 `createAnthropicStreamAccumulator` 或等价字段），flush/getMeta 时组装 `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` **再过 gross-up**，不能像非流式那样直接拿 `response.usage`。
| `message_stop` | 无 CC 对应（CC 靠 `[DONE]` + finish_reason 收尾）；记 sawMessageStop=true（截断检测：干净 EOF 无 message_stop = 上游截断，F2 反向侧）|
| `ping` | **swallow**（无 CC 对应）|
| `error` | → CC error frame 映射（OQ4 反向侧，复用 `openAIStreamErrorFrame` 或等价；getMeta 供 finish 给 handler 截断检测）|

- **getStreamMeta 自供**：finish_reason（未置位=截断信号，F2）+ 净 usage。信号链：上游 Anthropic 帧→本 translator 累积→getMeta。
- **多 choices**：反向是**逆折叠**——Anthropic 一个 turn 的 text+tool_use 折成 CC **单** choice（`choices[0]`，content + tool_calls 共存，CC 允许），非多 choices 分裂（前向 fold 的逆）。
- **CC 帧非 event-line 苛刻**：CC SSE 客户端不像 Anthropic SDK 按 event 行分发；但仍须 `data: {json}` + 结尾 `[DONE]`（各 handler pump 现状收尾 `[DONE]`，别在 translator 里发）。参照 `responses-to-cc-stream.ts` 的 CC chunk 形状。
- **golden 预捕获 + 独立 oracle**：合成的 CC SSE 流喂**真 CC 消费者**（`accumulateOpenAIStreamEvent` 累加器重建 completion + 断言 text/tool_calls/finish/usage 幸存）；**含正样本对照**（构造已知坏的 translator 变异证 oracle 非 no-op）。反向逐帧 golden（真实 Anthropic 帧序列 → CC 帧断言）。

### T5.2 hub 反向流式分派 + cc→messages 接线

> ⚠️ **对抗审查抓到 3 个 BLOCK,已并入下方。别照抄「复用现状 pump」的天真镜像。**

- **hub** [hub-translate.ts](../../../src/lib/pipeline/hub-translate.ts)：加 `createReverseStreamTranslator(clientFormat, modelId, exchangeCtx?): ReverseStreamTranslator`（镜像 `createForwardStreamTranslator`）——产**客户端格式**帧:
  - cc → 单跳 Anthropic→CC。
  - gemini → 单跳 Anthropic→CC（gemini codec 再 CC→Gemini,见 T5.4；hub 层只到 CC,让 gemini codec 二跳,对齐非流式 `renderResponseNonStreamingVia` 返 CC-canonical）。
  - responses → 二跳 Anthropic→CC→Responses。**⚠️ BLOCK(疑点 5)**:第二段 `createCCToResponsesStreamTranslator` 的真实签名是 **`(ctx: TranslateExchangeContext)`**（`{responseId, itemId, clientModel}`,[responses-to-cc-request.ts:59-69/248](../../../src/lib/openai/translate/responses-to-cc-request.ts#L59)),**不是 `(modelId)`**,且 `translate(ccData: string)` 吃字符串。故 `createReverseStreamTranslator` **签名必须能携 responses exchange ctx**（responseId/itemId/clientModel）——responses handler 为 MESSAGES 腿建 reverse-exchange（镜像 responses codec 前向 fallback 的 `{responseId,itemId,clientModel}`,但门控 `targetEndpoint===MESSAGES`,[openai-responses/codec.ts:208-218](../../../src/lib/codec/openai-responses/codec.ts#L208)),穿进 hub。cc/gemini 腿不需 exchange ctx（第二段是 CC/Gemini,不吃它）。
  - 现有 `createForwardStreamTranslator` 对 MESSAGES 腿的 throw 移除/改反向分派。`renderResponseNonStreamingVia(MESSAGES)` 已在 Phase 3 处理反向非流式（返 CC-canonical）——responses/gemini 客户端 codec 二跳它;**responses 二跳非流式 `translateCCToResponsesResponse` 也吃 `TranslateExchangeContext`([:156](../../../src/lib/openai/translate/responses-to-cc-request.ts#L156))**,同样要 reverse-exchange。
- **cc codec** [openai-cc/codec.ts](../../../src/lib/codec/openai-cc/codec.ts)：MESSAGES 腿接线（镜像 anthropic codec 前向腿的 `isForwardTranslateLeg` 分派,反向判据 `targetEndpoint===MESSAGES`）——
  - `translateOut`：MESSAGES 腿 → `translateRequestVia("openai-cc", MESSAGES, env.body)` 产 Anthropic body（现 identity）。**S4 起 env.body 是 Anthropic 形**。
  - `prepareWire`：MESSAGES 腿 → 产 Anthropic wire（`prepareAnthropicRequest`,纯函数;clientAnthropicBeta=undefined、无 client anthropic-beta;betaProbe 由 handler 供 recordOutbound）（现 throw）。
  - `renderResponse`（流式）：MESSAGES 腿 → 驱动 per-request `createReverseStreamTranslator("openai-cc", modelId)`（现 identity/via-responses 二分）。
  - `renderResponseNonStreaming`：MESSAGES 腿 → `renderResponseNonStreamingVia(MESSAGES, upstream)`.rendered（返 CC,现只 CC/Responses 二分）。
  - `flushResponse`/`getStreamMeta`：反向 translator 的 flush/getMeta（cc codec 现无这俩方法,若需加镜像 anthropic codec）。**flush 语义(疑点 7b)**:反向 cc translator 的 finish/usage 由 message_delta **内联**产出,可能不需专门 flush 吐终帧（对比 gemini/responses 二跳第二段**必 flush**,见 T5.3/T5.4)——但 pump 仍须调 `codec.flushResponse`(空实现也要有,统一接口)。
  - `createResponseAccumulator`：**⚠️ reviewer 疑点 3 实测:此方法全仓无生产消费者**（`types.ts` 定义 + 4 codec + gemini 委托,无 handler/driver 调用点;pump 各自内联建累加器）。**改它无用**——反向 outbound 累加器在 pump 里建（见下）。加 MESSAGES 分支返 `createAnthropicStreamAccumulator()` 保接口一致即可,别指望它生效。
  - `sampleRequest`：MESSAGES 腿 wire+effective 都 Anthropic-shaped——采 Anthropic wire（format 标签 `anthropic-messages`）。
- **cc handler** [chat-completions/handler-v4.ts](../../../src/routes/chat-completions/handler-v4.ts)：
  - **⚠️ BLOCK(疑点 1+2) Anthropic strategy 供料 + sanitize mapper**:反向 handler 无 anthropic codec,`ctx.toolNameMapper` 是 **CC mapper**([openai-cc/codec.ts:308](../../../src/lib/codec/openai-cc/codec.ts#L308))。故:
    - **不能直接复用 `createAnthropicSanitizeRewrite`**——它 `apply` 读 `ctx.toolNameMapper`([request-rewrite-adapter.ts:74](../../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L74))会灌进 CC mapper,语义错乱。须**建反向专属 sanitize rewrite**(appliesTo=MESSAGES),显式喂 **Anthropic** mapper（`buildAnthropicToolNameMapper(翻译后 Anthropic body.tools, resolvedName, model?.vendor)`）+ 空 preprocessInfo(`{dedupedToolCallCount:0, strippedReadTagCount:0}`,反向确无 Anthropic preprocess)。**Anthropic sanitize 是必需的**（RFC §3.1/§7.1:反向腿 targetEndpoint=MESSAGES 该 fire Anthropic 上游改写;CC→Anthropic 翻译器可能产 orphan tool_result/system-reminder,`prepareAnthropicRequest` 只做 B1-B12 wire prep 不做 orphan/reminder 清理,GHC 会 400)。
    - `strategies`：MESSAGES 腿 → `assembleStrategiesForEndpoint(MESSAGES, {anthropic: supply})`,supply.`resanitize` **内联构造**:`(p) => runAnthropicPayloadRewrites(p, {toolNameMapper: <上面同源 Anthropic mapper>}).sanitizeResult`（**与 sanitize rewrite 同源一个 mapper,别各建**）;`originalPayload`=翻译后 Anthropic body(S4 时 env.body 已 Anthropic);`betaProbe`=handler 建的 `createBetaProbe(undefined)`;`model`/`maxRetries`。非-MESSAGES 腿 → 现 `buildOpenAiCcStrategies`。
    - `requestRewrites`：driver 传含反向专属 sanitize rewrite 的数组（现 cc handler 未传 → 用 BUILTIN 空）。
    - `betaProbe`：`createBetaProbe(undefined)` 注入 codec(prepareWire recordOutbound)+ strategies supply。
  - **⚠️ BLOCK(疑点 3+7a) 专属反向 pump**（**不是复用现状 `pumpStreamingV4`**）:现状 `pumpStreamingV4`([:330](../../../src/routes/chat-completions/handler-v4.ts#L330)) 硬编 `createOpenAIStreamAccumulator`([:332])、只用 `onRenderedFrame`([:387])、`ctx.complete(buildOpenAIResponseData(acc))`([:435]) 把 **CC 形**记成 outboundResponse。反向腿上游是 **Anthropic**——直接复用会把 rendered CC 当上游腿形记 history,违 richest-data-flow「后端存储必须完整」。**须建专属反向 pump（镜像 messages 的 `pumpTranslateLegStreamingV4`,[handler-v4.ts:1447](../../../src/routes/messages/handler-v4.ts#L1447),但无心跳/无 anchor)**:`onUpstreamFrame`→`createAnthropicStreamAccumulator` 累积上游供 `outboundResponse`(honest Anthropic 形)、sink 采样 rendered CC 供 `forwarded`/`inboundResponse`、`ctx.complete` 用 **Anthropic outbound** 数据、截断检测读反向 translator 的 `getStreamMeta().finishReason`(F2)。`driver.runResponseSink` 支持 `onUpstreamFrame`([driver.ts:446](../../../src/lib/pipeline/driver.ts#L446))+`onRenderedFrame`,format-agnostic。**dispatch 按 targetEndpoint:MESSAGES 腿走反向 pump,其余走现状 pump（direct CC/via-responses byte-critical 完全不动）。**

### T5.3 responses→messages 接线（二跳 Anthropic→CC→Responses）

- **responses codec** [openai-responses/codec.ts](../../../src/lib/codec/openai-responses/codec.ts)：MESSAGES 腿五方法接线,镜像 T5.2 cc——但 render 二跳:
  - **⚠️ BLOCK(疑点 5) reverse-exchange**:responses 二跳第二段（`createCCToResponsesStreamTranslator` 流式 + `translateCCToResponsesResponse` 非流式）都吃 `TranslateExchangeContext`={responseId,itemId,clientModel}。前向 fallback 只在 `translateOut` 且 `targetEndpoint===CHAT_COMPLETIONS` 时建([openai-responses/codec.ts:208-218](../../../src/lib/codec/openai-responses/codec.ts#L208))——反向 MESSAGES 腿**须新建 reverse-exchange**（门控 `targetEndpoint===MESSAGES`,建 responseId/itemId/clientModel），穿进 hub 反向 translator + 非流式 `translateCCToResponsesResponse`。
  - `renderResponse` 流式 = `createReverseStreamTranslator("openai-responses", modelId, reverseExchange)`（hub 内 Anthropic→CC→Responses）;`renderResponseNonStreaming` = `renderResponseNonStreamingVia(MESSAGES)` 返 CC → `translateCCToResponsesResponse(cc, reverseExchange)`。
  - **flush 必调(疑点 7b)**:`createCCToResponsesStreamTranslator.flush()` 吐 `response.completed`([responses-to-cc-request.ts:382](../../../src/lib/openai/translate/responses-to-cc-request.ts#L382))——反向 pump **必调** `codec.flushResponse`,否则 Responses 客户端收不到终帧。
- **responses handler** [responses/handler-v4.ts](../../../src/routes/responses/handler-v4.ts)：Anthropic strategy supply + 反向专属 sanitize rewrite（Anthropic mapper）+ betaProbe,镜像 T5.2 cc handler。**⚠️ BLOCK(疑点 7a) 专属反向 pump**:现状 responses `pumpStreamingV4`([:283](../../../src/routes/responses/handler-v4.ts#L283)) 建 `createResponsesStreamAccumulator`、`runResponseSink(...,{onRenderedFrame})` 无 onUpstreamFrame → outbound 记 Responses 形（反向上游是 Anthropic,错）。须专属反向 pump:`onUpstreamFrame`→Anthropic 累加器记 outbound、rendered Responses 帧给客户端、`ctx.complete` 用 Anthropic outbound。
- 单测 + 反向 tool-name oracle（W-mapper-format,反向用 Anthropic mapper）。

### T5.4 gemini→messages 接线（经 cc delegate + CC→Gemini wrap）

- **gemini codec** [openai-gemini/codec.ts](../../../src/lib/codec/openai-gemini/codec.ts)：现持内部 cc delegate、renderResponse 走 `cc.renderResponse` 出 CC → 再 CC→Gemini。**T5.2 修好 cc codec 的 MESSAGES 腿后,gemini 的 cc delegate 自动继承 Anthropic→CC**（hub-and-spoke 优雅）——gemini codec 只需确认:① CC→Gemini wrap（`geminiTranslator.renderFrame`）对反向 CC 帧成立;② `translateOut`/`prepareWire` 经 cc delegate 传导 MESSAGES 腿（`cc.translateOut`/`cc.prepareWire` 已在 T5.2 支持）;③ **flush 必调(疑点 7b)**:gemini 第二跳 `geminiTranslator` 累积 tool calls 到 flush 才吐终帧([openai-gemini/codec.ts:185-187](../../../src/lib/codec/openai-gemini/codec.ts#L185)),pump 须调 `codec.flushResponse`。**依赖 hub 组合契约,T5.4 依赖 T5.2 完成,非纯并行**（W-gemini-hub-composition）。
- **gemini handler** [gemini/handler-v4.ts](../../../src/routes/gemini/handler-v4.ts)：Anthropic strategy supply + 反向专属 sanitize rewrite + betaProbe,镜像 T5.2 cc handler。**⚠️ BLOCK(疑点 7a) 专属反向 pump**:gemini `pumpGeminiStreamingV4`([:305](../../../src/routes/gemini/handler-v4.ts#L305)) `runResponseSink(upstream, env, sink)` **连 opts 都没有** → 反向上游 Anthropic 轨完全不累积。须专属反向 pump 加 `onUpstreamFrame`→Anthropic 累加器记 outbound。
- 单测 + gemini→messages 最长链 oracle（N-gemini-messages-oracle）。

## 验收 gate

- 每 commit：`bun run typecheck` 绿 + `bun test` 全套件通过（预存在 UI 404 除外）+ **Phase 0 router golden 52 全过** + **前向流式/非流式腿零回归**（Phase 4 golden 仍过）。
- 反向流式 translator：逐帧穷举表全类型 + 逆折叠单 choice + 净 usage gross-up + 独立 CC 消费者 oracle（正样本对照）。
- 反向请求侧红线（§9 WARN-E）：**零合成 thinking 块** + tool_use.id verbatim（W2 已实测 GHC 接受）+ 无 cache_control 注入 + server tools 剥离——逐项 oracle。
- 三反向格子（cc/responses/gemini `@messages`）：请求翻译 + 非流式 + 流式端到端。
- 二维门控：反向腿 targetEndpoint=MESSAGES → Anthropic sanitize/strategies fire、render/无心跳按 clientFormat。

## 提交指引

`git commit -F <msgfile> -- <精确路径>`，conventional commits（feat/fix/test），无模型署名。每 task 一 commit（T5.1/T5.2 大可再拆）。共享 worktree 用 pathspec 免疫 peer index race。

## 红线（见 [README](README.md) 通用红线 1-9，尤其）

- **反向红线（WARN-B/§9）**：反向**请求侧**（cc/responses/gemini→messages）**绝不合成 Anthropic thinking content block**（无 signature 撞 GHC "cannot be modified" 400/毒化）。客户端 reasoning 只经 `reasoning_effort` 参数或丢弃。（响应侧丢弃 thinking 是安全的，非合成。）
- **byte-critical**：反向 CC/Responses/Gemini SSE 逐帧 golden + 独立消费者 oracle（自洽 golden 抓不到消费者丢帧）。前向腿 + 6 现状格 golden 逐字节零回归。
- **二维门控别钉错轴**：反向腿改写/策略按 targetEndpoint=MESSAGES（Anthropic 上游 wire），render/心跳按 clientFormat（无心跳）。
- **净 usage gross-up**（复用 `anthropic-to-cc.ts` mapUsage，别重犯 W-rev 少计 / B1 双计）。
- **no-auto-server**；empirical-verification（W2 已实测；流式反向帧连跑 10-25× 确认时序确定性）。
- **绝不 kill 4141 主服务器**（用户实时使用）；可另端口起测试服务器（用后按 PID 精确 kill，绝不 pkill/killall）。

## 若撞硬阻塞（别硬编、别放宽 byte-critical）

> 下方 ②③⑤ 曾是对抗审查的 BLOCK,**已在 T5.2/T5.3/T5.4 给出确定接线,不再是开放疑点**。stop-and-report 留给**真正新出现**的障碍:

① 反向流式 translator 的 CC tool index 分配与 Anthropic block index 映射 off-by-one 无法在 golden 下收敛 ② ~~反向 handler 的 Anthropic strategy 供料~~（已定:内联构造 resanitize + Anthropic mapper,见 T5.2）③ ~~反向 pump 双累加器~~（已定:专属反向 pump 镜像 pumpTranslateLegStreamingV4,见 T5.2）④ responses 二跳 getStreamMeta 信号链断 / reverse-exchange id 穿不通 ⑤ ~~responses 二跳 translator 签名~~（已定:携 TranslateExchangeContext,见 T5.3）⑥ gemini cc-delegate 继承 Anthropic→CC 后 CC→Gemini wrap 对反向 CC 帧产畸形——**停下报告**,附具体 golden diff / oracle 失败 / 帧序列 / 牵连文件清单,别自行改设计。

## 前置门控状态（plan 记录）

- **W2 OQ3 inbound 接受性**：✅ **CLEARED**（2026-07-12 探针实测,PROBE-FINDINGS Probe 3——GHC Anthropic 腿接受任意前缀入站 tool_use.id,`call_*` verbatim 透传成立,无需 id 归一/改写）。
- **W3 反向 empty/占位守卫**：本 phase T5.0（未做,接上游前必补）。
- **W4 @responses 前向腿端到端 IT**：本 phase T5.0（Phase 2 遗留补测）。

## Kickoff 对抗审查记录（2026-07-12,全采纳,record-not-adopted）

本 kickoff 定稿前经一轮对抗性 subagent 审查（裁判轴:长远正确+完整,非 ROI/YAGNI）,抓到 4 BLOCK + 2 HIGH/MEDIUM,**全部采纳并入 task**（均属"补全接线"非"砍范围",与项目"完整>最小"一致;无驳回项）:
- BLOCK 疑点 3+7a（反向 pump 双累加器）:「复用现状 pump 就够」是错的——三反向腿都需专属反向 pump（镜像 `pumpTranslateLegStreamingV4`,无心跳,`onUpstreamFrame`→Anthropic 累加器记 outbound）;`createResponseAccumulator` 实测无生产消费者、改它无用。→ 并入 T5.2/T5.3/T5.4。
- BLOCK 疑点 5（responses 二跳签名）:第二段 `createCCToResponsesStreamTranslator` 吃 `TranslateExchangeContext`（responseId/itemId/clientModel）非 modelId;反向须建 reverse-exchange 穿进流式+非流式。→ 并入 T5.2/T5.3。
- BLOCK 疑点 2（反向 sanitize mapper）:不能直接复用 `createAnthropicSanitizeRewrite`（闭包 CC mapper）;须建反向专属 sanitize rewrite 显式喂 Anthropic mapper。→ 并入 T5.2。
- HIGH 疑点 1（反向 resanitize 供料）:内联构造 + Anthropic tool-name mapper 来源（与 sanitize rewrite 同源）。→ 并入 T5.2。
- MEDIUM 疑点 4（帧表 swallow）:delta 目标为丢弃块（尤其 server_tool_use 的 input_json_delta）须 swallow。→ 并入 T5.1 帧表。
- MEDIUM 疑点 6（usage）:`mapUsage`/`mapStopReason` 需 export;流式 usage 从 message_start+message_delta 组装再 gross-up。→ 并入 T5.1。
- 主会话独立复证:#2（sanitize 读 ctx.toolNameMapper）、#3（pump 累加器 + createResponseAccumulator 无消费者）、#5（TranslateExchangeContext 字段）均亲手读代码核实无误。
