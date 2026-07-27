# Plan-M: terminal ownership matrix（两轮审查共同点名的 plan 首要交付物）

> **修订记录（2026-07-23，据 GPT plan-review [major] 全 leg 枚举意见修订）**：原版本只列了 4 个同格式直连格（Anthropic direct / CC direct / Responses HTTP direct / Responses WS），被审查指出遗漏运行时真实存在的 translate/fallback/reverse legs（`handler-v4.ts:1123-1137` 的 `@cc`/`@responses` translate、`:1501-1505` 明文注释该 translate leg 不可复用 buffered 判据、`responses/handler-v4.ts:194-235` 的 `viaFallback`/`reverseMessages`）。本版本**从路由决策代码逐条枚举全部运行时可达的 `(inbound × outbound)` 格**，非凭空猜测组合——每格标注该 leg 是否走 `runResponseBufferedSink`（本特性可挂载）还是 `runResponseSink`（当前无缓冲、本特性在该 leg 上只能是「本版本不支持，强制透传」）。
>
> **修订记录三（2026-07-27，planner 亲自读码核实，master `db1cb775`）**：本轮对全部「待核实（M.1）」格逐一读码核实，补全四要素，发现两处此前假设的核实缺口已被并发会话的 P0 落地实质关闭：① `incomplete_details.reason` 捕获——`src/lib/openai/responses-stream-accumulator.ts:140`（`accumulateResponsesStreamEvent` 的 `response.incomplete` 分支）**已捕获**（`acc.incompleteReason = event.response.incomplete_details?.reason`，提交 `b8b5e7c2 fix(responses): retain incomplete terminal reason`，属 `f0bd5f73 docs(plan): complete max_tokens continuation P0` 一部分）——原表格 M.2 交叉确认里"当前未被捕获"的表述已过时，本次同步更正为"已捕获"；② P0 的 Anthropic-only observer 分档决策（`plan-0-classifier-and-observability.md`）已按计划落地并标注"P0 已完成"，与本文件 Task M.2 的分工假设一致，无需改动。**结论不变，但依据从"计划假设"升级为"读码确认"**——下述各格的④要素、CC/Responses 交叉场景判据来源、WS 依赖状态均已逐条重新核实（细节见各小节，未核实到的角落已诚实标注 + 给出具体核实方法）。
>
> **修订记录四（2026-07-27，据 GPT 异模型设计复审 1 blocker + 2 major + 1 minor 修订）**：复审报告 `design-review-gpt.md`（同目录）逐条核实成立。① **[blocker] 修正**——原表把"条件选择 buffered"写成"该 leg 无条件走 buffered"：`handler-v4.ts:1105-1113` 的 `resolveBufferedAndHeartbeat` 里 `buffered` **只由** `state.protectStreamingGeneration`（默认 `false`）决定，`max_tokens_continuation.enabled` 完全不参与该判定；且 ledger 喂养（`driver.ts:1279/1300`）与续写触发（`:1415` `canContinue`）**全部在 `runResponseBufferedSink` 内部**，`runResponseSink`（live 路径，`:912-988`）结构性地没有这些 hook（`RunResponseOpts` 类型上不携带）。故默认配置下（`protectStreamingGeneration:false`）Anthropic 走 live，本特性的截获分支永不可达。**用户已裁决（2026-07-27，见 spec `2026-07-22-max-tokens-continuation.md` §5.3 同步）**：本项目基于块级 buffered 工作与设计、完全放弃流式；解法不是「需要缝合时才有条件强切 buffered」的耦合补丁，而是完成姊妹 spec `2026-07-22-continuation-retry-and-sequential-anchor.md` §6.3 早已定下的默认翻转——Anthropic `protect_streaming_generation` → 块级默认 on。翻转后 buffered 是真实前提，零条件耦合、零双轨。翻转的前置门 G2（>300s client↔proxy keepalive）根因已由并发 worktree `.worktrees/keepalive-300s` 查明（`recoverToolCallText` marker lookahead 静默吞掉空 `text_delta`，非 CC 死线本身或代理 stall 检测）并正在收口（commit `131ea3b2` + WIP 的按需升级保活机制，尚未合并 master）。下方每个「可挂载」格已按「当前选择条件」+「翻转后的唯一挂载契约」两栏重写。② **[major] 修正**——Responses HTTP direct/fallback 的③要素判定错误：`isResponsesCommitBoundary` 把 `response.completed/.failed/.incomplete` 三个 lifecycle terminal 也算 commit boundary，故 `driver.ts:1240` 的块级 boundary 分支会在到达 `:1336` terminal drain **之前**就把 `response.incomplete` flush 给客户端——等 `:1336` 再截获已经太晚（双终局）。HTTP 与 WS 因 `commitBoundaries` 传入与否不同，**不能写成同一结论**（WS 因未传 `commitBoundaries`，`:1336` 结论仍成立）。下方 Responses HTTP 小节已重画，给出两个候选修法 + producer oracle。③ **[major] 修正**——leg 枚举须按客户端 transport（HTTP SSE / WS）穷尽，不能止步于 12 个 router 逻辑 cell：补全 Responses WS fallback（**已实测锁定 stays LIVE**，`tests/responses/ws-buffered.it.test.ts:487-515`，本次独立复跑 5 pass）+ Responses WS `@messages` reverse（路由可达但 `ws.ts` 无 `reverseMessages` 分派，会在 `responsesCandidateSnapshot` 处抛错）。下方新增「客户端 transport leg 展开表」区分 router cell 与实际 handler/pump。④ **[minor] 修正**——Q5 的 anchor 公式已在 `plan-Q5-three-way-overlap.md` 同步改为分段形式（`anchorShift` 条件量，非无条件常量），且用户已裁决保活载体走「按需升级」（平时 ping、静默逼近死线才注入内容帧），本文件不受此影响（本文件只关心 buffered/live 路由选择，不关心保活载体形状），仅记录该并发变更以便交叉核对。

> **地位不变：** 这不是可选文档任务——没有它 CC/Responses/WS 的 wire 拦截点无法唯一确定，P3 不能只靠 per-format PoC 蒙混过关（spec §5.3）。

## 枚举方法（从 `src/lib/pipeline/router.ts` 的 `decideRouteFromInput` + 各 handler 的 leg 分派代码逐条读出，非猜测）

**四种 `clientFormat`（`src/lib/pipeline/envelope.ts:21`）× 各自可达的 `targetEndpoint`：**

| clientFormat | 无后缀默认 leg（`DEFAULT_LEG`，`router.ts:112-117`） | 可达的非默认 leg（forward-translate / fallback / reverse） |
|---|---|---|
| `anthropic` | `/v1/messages`（direct，Anthropic vendor 支持时） | forward-translate → `/chat/completions`（`@cc`）、`/responses`（`@responses`，HTTP+WS） |
| `openai-cc` | `/chat/completions`（direct） | reverse → `/v1/messages`（upstream 是 Anthropic，`env.targetEndpoint===MESSAGES` 分支）；via-responses → `/responses` |
| `openai-responses` | `/responses`（direct，HTTP+WS） | reverse → `/v1/messages`；fallback → `/chat/completions`（`viaFallback`） |
| `gemini` | `/chat/completions`（委托内部 openai-cc codec） | reverse → `/v1/messages`；via-responses → `/responses` |

**N1 排除（spec 明确）：** `gemini` 作为**入站格式**（`GET /v1beta/.../generateContent`）本特性不覆盖——其 pump（`pumpGeminiStreamingV4`/`pumpReverseGeminiStreamingV4`，`src/routes/gemini/handler-v4.ts`）**只调用 `runResponseSink`，从不调用 `runResponseBufferedSink`**（本 planning 期已核实：全文 grep 该文件无 buffered 调用），故 Gemini 入站的任何 leg 天然不可挂载本特性，无需在矩阵中重复论证，直接标「不适用（N1）」。**Gemini 作为出站目标是可达的**（其他格式可 forward-translate 到 CC/Responses，上游 vendor 可能是 Gemini 模型），但这与「Gemini 作入站格式」是两回事——矩阵按 `(clientFormat × targetEndpoint)` 分格，与上游 vendor 无关，不影响本矩阵结构。

**每格是否走 buffered 路径（本特性可挂载的前提）——按「当前选择条件」与「本特性的唯一挂载契约」两栏拆分（2026-07-27 blocker 修订）：**

**⚠️ 核心澄清（blocker 根因，适用全部三个可独立配置 buffered 的格式，非 Anthropic 独有）**：`buffered` 从来不是 leg 的静态属性，而是**运行时读一个独立配置项**的结果——`resolveBufferedAndHeartbeat()`（Anthropic，`handler-v4.ts:1105`）、`resolveCcBufferedAndHeartbeat()`（CC，`chat-completions/buffered-config.ts`）、`resolveResponsesBufferedAndHeartbeat()`（Responses，`responses/buffered-config.ts`）分别只读 `state.protectStreamingGeneration`（Anthropic，默认 `false`）、`state.chatCompletionsBufferedRetry`（CC，默认 `true`）、`state.responsesBufferedRetry`（Responses，默认 `true`）——`max_tokens_continuation.enabled` **在任何一个判据里都不参与**。下表「当前选择条件」列写这个独立开关的**当前 bundled 默认值**；「挂载契约」列写**本特性实际依赖的前提**（与该独立开关是否为 `true` 无关——本特性的正确性不应该偶然搭便车在"CC/Responses 当前默认恰好是 true"上，操作员单独关闭它们时同一功能会静默失效，必须显式记录依赖，而非利用当前默认值蒙混过关）。

| clientFormat × targetEndpoint | Handler pump 函数 | 当前选择条件（独立配置项 + bundled 默认值） | 翻转后/本特性的唯一挂载契约 | 本特性可挂载？ |
|---|---|---|---|---|
| `anthropic` × `/v1/messages`（direct） | `pumpAnthropicStreamingV4`（`messages/handler-v4.ts:1176`） | `state.protectStreamingGeneration`（`state-defaults.ts:78`，默认 **`false`**）→ 默认走 **live**（`runResponseSink`），本特性截获分支**不可达** | **依赖姊妹 spec §6.3 默认翻转**（`protect_streaming_generation` → 块级默认 on，卡在 G1+G2 门；G2 根因已查明【`.worktrees/keepalive-300s` commit `131ea3b2` + WIP，未合并 master】，正在收口）。翻转后 `buffered` 恒为 `true`，截获点（`driver.ts:1336`）才可达。**这是本特性 P1 的硬前置，非可选优化** | **是——但当前默认配置下不可达，依赖上述翻转先落地** |
| `anthropic` × `/chat/completions`（`@cc` translate） | `pumpTranslateLegStreamingV4`（`messages/handler-v4.ts:1508`） | 无条件走 live（`:1525` 调用 `driver.runResponseSink`，非 buffered；`:1501-1505` 明文注释 buffered 在 translate leg 是 deferred backlog——**该 leg 结构性不支持 buffered，非配置可调**） | 无（结构性无 buffered 路径可挂） | **本版本不支持**——强制透传，登记 backlog（与既有 `docs/todo/deferred-backlog.md` "buffered-retry on translate leg deferred" 条目共享同一根因） |
| `anthropic` × `/responses`（`@responses` translate，HTTP+WS） | 同上 `pumpTranslateLegStreamingV4` | 同上（结构性无 buffered） | 无 | **本版本不支持**——同上 |
| `openai-cc` × `/chat/completions`（direct） | `pumpStreamingV4`（`chat-completions/handler-v4.ts:494`，非 reverse 分支） | `state.chatCompletionsBufferedRetry`（`state-defaults.ts:94`，默认 **`true`**）→ 当前默认走 buffered，**但这是操作员可独立关闭的开关**，非本特性能控制 | **依赖 `chatCompletionsBufferedRetry` 保持 `true`**（不像 Anthropic 需要姊妹 spec 翻转——CC 已默认 buffered；但若操作员显式设为 `false`，本特性在 CC 上同样静默失效，须显式记录该依赖，不能因"当前默认恰好是 true"就当作无条件可挂载） | **是，但依赖 `chatCompletionsBufferedRetry:true`（当前默认满足，操作员可关闭致特性失效）**——P3 CC 子任务 |
| `openai-cc` × `/v1/messages`（reverse，upstream 是 Anthropic） | `pumpReverseAnthropicLegV4`（`chat-completions/handler-v4.ts:734`） | 无条件走 live（`:744` 调用 `driver.runResponseSink`；docstring 明文「L2 buffered-retry is NOT applied on the reverse leg」——结构性不支持） | 无 | **本版本不支持**——强制透传，登记 backlog |
| `openai-cc` × `/responses`（via-responses，CC body 经 prepareWire 转 Responses wire） | 复用 `pumpStreamingV4`（同 CC direct 判据） | 同 CC direct——`state.chatCompletionsBufferedRetry` 默认 `true` | 同 CC direct——依赖同一个开关保持 `true`；**额外触发判据须读 Responses 上游的 `incomplete`，转译回 CC `finish_reason=length` 给客户端**，是 CC builder 与 Responses accumulator 的交叉场景 | **是，同 CC direct 依赖**——P3 CC 子任务须显式覆盖此变体 |
| `openai-responses` × `/responses`（direct，HTTP，`viaFallback=false`） | `pumpStreamingV4`（`responses/handler-v4.ts:320`） | `state.responsesBufferedRetry`（`state-defaults.ts:233`，默认 **`true`**）→ 当前默认走 buffered，**但操作员可独立关闭** | **依赖 `responsesBufferedRetry` 保持 `true`**（同 CC 的依赖形状）；**此外见下方「Responses HTTP 截获点」小节的独立 major 修正**——即便 buffered 可达，③要素判定本身也需要重画 | **是，但依赖 `responsesBufferedRetry:true` 且③要素需按下方重画的两个候选修法落地**——P3 Responses 子任务 |
| `openai-responses` × `/chat/completions`（fallback，`viaFallback=true`，客户端仍是 HTTP SSE） | 同 `pumpStreamingV4`，`viaFallback` 分支 | 同 direct——`state.responsesBufferedRetry` 默认 `true`；docstring `:343-345` 确认「direct and via-chat fallback now share the same buffered unit」（HTTP fallback，非 WS fallback——**WS fallback 是另一个独立 leg，见下方客户端 transport 展开表，实测走 live，与此 HTTP fallback 不同构**） | 依赖同一个开关；触发判据是 CC 的 `finish_reason=length`（因为 fallback 时上游 wire 已是 CC）；③要素同样需按下方重画 | **是，同 Responses direct 依赖**——P3 Responses 子任务须显式覆盖 fallback 变体 |
| `openai-responses` × `/v1/messages`（reverse，upstream 是 Anthropic，HTTP） | `pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576-645`） | 无条件走 live（`:585` 明确调用 `driver.runResponseSink`——结构性不支持） | 无 | **本版本不支持**——强制透传，登记 backlog |
| `gemini` × `/chat/completions`（direct，委托内部 CC codec） | `pumpGeminiStreamingV4`（`gemini/handler-v4.ts:415`） | 无条件走 live（只调用 `runResponseSink`，已核实） | 无 | **不适用（N1，Gemini 入站排除）** |
| `gemini` × `/v1/messages`（reverse） | `pumpReverseGeminiStreamingV4`（`gemini/handler-v4.ts:623`） | 待核实但**不适用（N1）** | 无 | **不适用（N1）** |
| `gemini` × `/responses`（via-responses） | 待核实但**不适用（N1）** | 待核实 | 无 | **不适用（N1）** |

**收窄结论（本特性实际覆盖范围，12 个 router 逻辑 cell——非「全部运行时 leg」，客户端 transport 展开见下方独立表）：**
- **可挂载（依赖各自的 buffered 前提，非无条件）：** `anthropic×/v1/messages`（依赖姊妹 spec §6.3 默认翻转，**当前默认配置下不可达**，P1）、`openai-cc×/chat/completions`（依赖 `chatCompletionsBufferedRetry:true`，**当前默认满足**，P3）、`openai-cc×/responses`via-responses 变体（同上依赖，P3，需交叉覆盖）、`openai-responses×/responses`（依赖 `responsesBufferedRetry:true` **且**③要素重画，**当前默认满足前者、后者仍是 major 缺口**，P3）、`openai-responses×/chat/completions`fallback 变体（同上依赖，P3，需交叉覆盖）。
- **本版本不支持、强制透传、登记 backlog（结构性无 buffered 路径，非配置可调）：** `anthropic×/chat/completions`translate、`anthropic×/responses`translate（HTTP+WS）、`openai-cc×/v1/messages`reverse、`openai-responses×/v1/messages`reverse。
- **不适用（N1 Gemini 排除）：** 全部 3 个 `gemini×*` 格。

---

## 矩阵定义（spec §5.3 四要素，逐 leg 一行——只对「可挂载」和「待核实」的格填写，「不适用」和「本版本不支持」格只需一句话+对应 producer oracle）

对每个可挂载/待核实的 `(inbound × outbound leg)`，明确：
- **①accumulatorSite** —— upstream completion 信号在哪一层被 accumulator 记录。
- **②terminatorConstructor** —— client-visible terminator 由哪个 codec/translator/handler 构造。
- **③interceptSite** —— transparent 分支必须在该构造**之前**在哪一层截获。
- **④finalCompletionOwner** —— continuation 最终完成时**谁且只谁**发出唯一终局。

---

### Anthropic direct（`anthropic × /v1/messages`）

**状态：四要素本身已读码确认；⚠️ 前提尚未满足（blocker，2026-07-27）——默认配置下 `buffered=false`，本节四要素描述的截获点当前不可达，见上方「当前选择条件」栏。P1 落地顺序：先完成姊妹 spec §6.3 默认翻转，四要素才生效。**

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | `src/lib/anthropic/stream-accumulator.ts` `AnthropicStreamAccumulator.stopReason`（由 `message_delta.delta.stop_reason` 填充），`sawMessageStop` 标记 `message_stop` 已到达 |
| ②terminatorConstructor | 无需构造——bypass-direct，上游帧逐字透传；driver 的 terminal drain（`src/lib/pipeline/driver.ts:1336`）flush 缓冲的 `message_delta`+`message_stop` |
| ③interceptSite | **`driver.ts:1336` 判断为真、`:1348` flush 之前**——**仅在 `runResponseBufferedSink` 内可达**（这段代码在 `runResponseSink` 里不存在，见上方 blocker 说明） |
| ④finalCompletionOwner | 续写链最终轮再次抵达 `:1336` 判断点，走正常 flush——同一段代码是唯一终局 |

**P1 实现要点：**
1. 新增的成功终止截获，不能复用 cut path（`:1401-1463`）的 `canContinue` 门——两者是 driver `for(;;)` 循环内互斥的不同代码路径。
2. **前置条件（blocker 修订新增）**：本截获分支的插入点本身只在 `runResponseBufferedSink` 内存在，而该函数只在 `state.protectStreamingGeneration !== false` 时才被 `pumpAnthropicStreamingV4` 调用（`handler-v4.ts:1231-1234`）。P1 不应实现「按需强切 buffered」的耦合分支（用户已明确否决），而应将「姊妹 spec §6.3 默认翻转已落地」列为 P1 的**显式硬前置门**，与 G2（保活死线，已查明根因、收口中）串联。

---

### CC direct（`openai-cc × /chat/completions`）

**状态：全部四要素已读码核实（2026-07-27）；挂载依赖 `state.chatCompletionsBufferedRetry` 保持 `true`（当前默认满足，非无条件），可直接用于 P3 Task 3.2。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/routes/chat-completions/handler-v4.ts:355` `sawMessageStop: (state) => state.acc.finishReason !== ""`；`state.acc` 由同文件 `onRenderedFrame`（`:339-354`）逐帧调 `accumulateOpenAIStreamEvent` 填充 |
| ②terminatorConstructor | `finish_reason` 是上游原生字段直接透传（`accumulateOpenAIStreamEvent` 写入 `acc.finishReason`，不新构造）；客户端可见的流终止符 `data: [DONE]` 由 handler **post-loop 合成**（`:654`，`await sink.write({ data: "[DONE]" })`，在 `outcome.kind === "complete"` 且 `acc.streamError`/`acc.finishReason===""` 两个提前 return 分支都不成立之后） |
| ③interceptSite | driver 的 terminal drain 触发点（`driver.ts:1336` `sawMessageStop?.()` 为真、`:1348` flush 之前）——与 Anthropic 同一段共享代码，非 CC 专属分支；`max_tokens` 截获须在这里插入，早于 handler 的 `[DONE]` 合成（该合成在 `runResponseBufferedSink` **返回之后**才跑，见④） |
| ④finalCompletionOwner | **已确认（非待核实）**：`runResponseBufferedSink`（`driver.ts:989-1509`）内部是一个 `for(;;)` 循环（`:1161`），续写分支（`:1401-1463`）在循环体内部 `continue`，**函数只在真正到达终局（成功 flush 或穷尽退化）时才 `return`**——即 CC handler 的 `pumpStreamingV4`（`:494-554`）拿到的 `outcome` 已经是"全部续写轮结束后的最终结果"，handler 的 `[DONE]` 合成点（`:654`）天然只在最后一轮之后跑一次，**不需要额外协调机制**（原表格"待核实"的顾虑不成立——续写是 driver 内部循环，不是 handler 感知到的多次 `runResponseBufferedSink` 调用）。**核实方法**：`driver.ts:1161` 的 `for(;;)` + `:1445-1454`（`continuationOffset = wireDeliveredBlocks; onContinuationLeg = true; continue`）逐行读码确认。 |

### CC via-responses（`openai-cc × /responses`，交叉场景——CC 客户端 body，上游实际是 Responses）

**状态：全部四要素已读码核实（2026-07-27）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | 同 CC direct（`state.acc: OpenAIStreamAccumulator`，客户端看 CC 帧，同一个 `createChatCandidateResponseSession` 非 reverse 分支，`handler-v4.ts:329-361`），**触发判据仍是 CC 形状的 `acc.finishReason`**——翻译发生在 render 阶段之前：上游 Responses SSE 帧先经 `createStreamTranslator().translate()`（`src/lib/openai/translate/responses-to-cc-stream.ts:28-186`）译成 `ChatCompletionChunk`，`response.incomplete` 事件在这里就被译成 CC 的 `finish_reason: mapIncompleteFinishReason(event.response.incomplete_details)`（`:127-129`，`length` 或 `content_filter`），**该翻译是 render 阶段的产物**（driver `renderFrames` 调 `codec.renderResponse` → `codec.ts:263-265` 的 `responsesRenderer.renderFrame`），在 `onRenderedFrame` 读到 `state.acc` 之前已经完成——故 `sawMessageStop` 判断点读到的 `acc.finishReason` **已经是翻译后的 CC 形状**，判据与 CC direct 完全同构，无需额外适配层。 |
| ②terminatorConstructor | 同 CC direct——`[DONE]` 由 handler `:654` 后置合成；`finish_reason` 已在 render 阶段由 `createStreamTranslator` 译成 CC 形状（见①），无第二次转换。 |
| ③interceptSite | 同 CC direct——`driver.ts:1336` 判断点，**帧已经过 render 翻译**（CC 客户端从不看到原始 Responses 事件）。 |
| ④finalCompletionOwner | 同 CC direct——同一个 `runResponseBufferedSink` 循环，via-responses 只是 render 阶段多一层 Responses→CC 翻译（`createResponsesToCcFrameRenderer`，`codec.ts:205`），不影响 driver 层的终局归属。**结论：CC via-responses 与 CC direct 在④要素上完全同构，P3 Task 3.3b 可直接复用 Task 3.2 的截获逻辑（原文档"若翻译发生更晚需要额外适配层"的分支已被证伪排除）。** |

---

### Responses HTTP direct（`openai-responses × /responses`，`viaFallback=false`，客户端 HTTP SSE）

**状态：①②④要素已读码核实（2026-07-27）；③要素判定**错误**（2026-07-27 major，据 GPT 设计复审修订）——原表格声称截获点在 `driver.ts:1336` 终局判断处，实测 `response.incomplete` 会在到达该点**之前**就被块级 boundary flush 给客户端。挂载依赖 `state.responsesBufferedRetry` 保持 `true`（当前默认满足）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/lib/openai/responses-stream-accumulator.ts:99-186` `accumulateResponsesStreamEvent`：`case "response.incomplete"`（`:138-141`）填充 `acc.status = event.response.status` **且** `acc.incompleteReason = event.response.incomplete_details?.reason`——**该字段已捕获**：提交 `b8b5e7c2 fix(responses): retain incomplete terminal reason`（属 `f0bd5f73 docs(plan): complete max_tokens continuation P0`）。 |
| ②terminatorConstructor | `response.completed`/`.incomplete`/`.failed` 三个 Responses 原生 lifecycle 事件由上游直接携带（无客户端侧二次构造）。 |
| ③interceptSite | **原表格结论证伪，已重画（major）**：`isResponsesCommitBoundary`（`src/lib/codec/openai-responses/commit-boundaries.ts:18-23`）明确把 `response.output_item.done` **以及** `response.completed`/`.failed`/`.incomplete` **三个 lifecycle terminal 全部**列为 commit boundary。HTTP 走块级路径时（`candidate-response-session.ts:140` `commitBoundaries: isResponsesCommitBoundary`），driver 在 `:1240` 命中 `candidateOpts.commitBoundaries?.(toWrite)` 为真的分支——此时 `onRenderedFrame` 已先把该帧累积进 `state.acc`（`:1146` `accumulateResponsesStreamEvent` 调用早于 `:1149` 的 `commitBoundaries` 判断）——立即 `flushBufferedFrames` 把 `response.incomplete` 连同缓冲区其余帧一起写给客户端。等代码流程走到 `:1336` 的 terminal drain 判断点时，`buffer` 已经清空、`response.incomplete` 已经在客户端 wire 上——**此时再截获已经太晚**：客户端已收到合法终局，若续写分支仍在此处触发并写入续写帧，会造成双终局（协议错误，直接违反 transparent-stitch「首轮终止符必须被抑制」的核心契约）。**两个候选修法（plan 期定，均需 producer oracle）**：<br>① **在 boundary flush 之前判定**：在 `accumulator` 已更新、帧尚未进入 `flushBufferedFrames` 的位置（即 `:1146` 之后、`:1149` 的 `commitBoundaries?.()` 判断之前）插入 max_tokens 检测——若命中，短路掉本次 boundary 提交、转为 hold+续写路径，不让该帧进入 `toFlush`。<br>② **max-tokens 模式下收窄 commit predicate**：当 `max_tokens_continuation` 对当前请求生效时，Responses commit predicate 只承认 `response.output_item.done`（中间 item 边界）为 boundary，把三个 lifecycle terminal 排除出 boundary 集合、留给 `:1336` 的 terminal drain 统一处理（等价于该请求临时退化为"块级 item-boundary + terminal-only 生命周期提交"的组合形状）。<br>**必需 producer oracle**：`test("Responses HTTP direct: max_tokens continuation — sink never receives the first round's response.incomplete before the second dispatch begins")`——断言第二轮 dispatch 发起**之前**，sink 从未写出过带 `status:"incomplete"` 的 `response.incomplete`/`response.completed` 帧。 |
| ④finalCompletionOwner | 同 CC direct——`runResponseBufferedSink` 内部 `for(;;)` 循环唯一 `return`，handler（`responses/handler-v4.ts:378-499`）拿到的 outcome 已是续写全部完成后的终局；**但此结论的前提是③的截获点已按上述两个候选之一正确落地**，否则续写触发时机本身就在 boundary flush 之后、为时已晚，④的"唯一终局"不变量无从谈起。 |

### Responses HTTP fallback（`openai-responses × /chat/completions`，`viaFallback=true`，交叉场景——Responses 客户端 body，上游实际是 CC，客户端仍是 HTTP SSE，非 WS）

**状态：①②④要素已读码核实（2026-07-27）；③要素与 direct 同一根因、同样证伪（major）——因为 fallback 与 direct 共用同一个 `isResponsesCommitBoundary` 判据 + 同一个 `runResponseBufferedSink` 调用点。挂载依赖同一个 `state.responsesBufferedRetry:true`。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | 同 Responses direct（**同一个 `createResponsesCandidateResponseSessionFactory` 非 reverse 分支**，`candidate-response-session.ts:106-166`，`viaFallback` 只影响 `fallbackResponseId` 的读取来源，不影响 accumulator 类型），但上游 wire 实际是 CC——render 阶段先经 `createCCToResponsesStreamTranslator`（`src/lib/openai/translate/responses-to-cc-request.ts:251-`）把 CC SSE 帧译成 Responses 事件（`codec.ts:263-265` 的 `ensureCcTranslator().translate()`），CC 的 `finish_reason:"length"` 在这里被译成 `ccFinishReasonToResponsesStatus("length")` → `{ status: "incomplete", incompleteReason: "max_output_tokens" }`（`responses-to-cc-request.ts:511-513`）——触发判据读到的 `acc.status`/`acc.incompleteReason` 已经是翻译后的 Responses 形状，翻译发生在 render 阶段（早于 `onRenderedFrame` 里的 `accumulateResponsesStreamEvent`）。 |
| ②terminatorConstructor | 同 Responses direct——三个 lifecycle 事件（此处是翻译合成的 `response.completed`，携带 `incomplete` status）由 render 阶段产出，非 handler post-loop 二次构造。 |
| ③interceptSite | **与 direct 同一根因证伪**：fallback 与 direct 共用同一个 `isResponsesCommitBoundary` predicate、同一个 `runResponseBufferedSink` 调用（`handler-v4.ts:380`，`viaFallback` 只影响 fallback session 注册时机，不改变 boundary 判据），故 `response.completed`（携带翻译后的 `incomplete` status）同样会在 `:1240` 被提前 flush。修法须与 direct 用**同一个**方案（两个候选之一），不能分别处理——否则 direct/fallback 行为会不一致。 |
| ④finalCompletionOwner | 同 direct——`runResponseBufferedSink` 单一循环终局，同样以③的正确落地为前提。 |

**结论：Responses HTTP fallback 与 direct 在①②④要素上完全同构（原文档"待核实"的交叉适配顾虑已被证伪排除，可直接复用 direct 的 accumulator/terminator 逻辑），但③要素的两个候选修法必须同时覆盖 direct 与 fallback 两个变体（同一根因），P3 Task 3.6/3.7b 须共用同一套截获实现，不能只测 direct。**

---

### Responses WS direct（`openai-responses × ws:/responses`，客户端 WS，`viaFallback=false`）

**状态：核心机制已读码核实；WS 块级续写的姊妹依赖状态已确认——姊妹 spec Task 6.1/6.2 均未落地（2026-07-27 核实）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | 同 Responses HTTP（共用同一个 `createResponsesCandidateResponseSessionFactory("ws")`，`candidate-response-session.ts:60-166`），但 `commitBoundaries` **故意省略**（`ws.ts:376-396` 明文注释：WS 不能复用 HTTP 的 `isResponsesCommitBoundary` 块级谓词，因为 `response.output_item.done` 在 WS 语境下提交一个块会过早关闭重试窗口——`committedAny` 提前置真，导致 `output_item.done` 之后、`response.completed` 之前的丢包错误降级为 `partial-degrade` 而非重试）。故 WS 是 **terminal-only** 提交：`driver.ts` 的 `sawMessageStop`/`sawUpstreamError` 是唯一 commit 触发点。 |
| ②terminatorConstructor | 同 HTTP：三个 lifecycle 事件由上游原生携带；WS 额外有 `stopAfterFrame`（`candidate-response-session.ts:141-146`，`TERMINAL_EVENTS` 命中即停止读取，避免读过 `response.completed` 挂到 idle-timeout）。 |
| ③interceptSite | 同 HTTP——driver `:1336`——但 WS **没有块级 boundary**（`commitBoundaries` 未传入 `runResponseBufferedSink`，`ws.ts:393-408`），故本特性在 WS 上只能是**整响应级**的 max_tokens 截获（与 CC 的终局-only 判据同构，非 Responses HTTP 的块级判据）。 |
| ④finalCompletionOwner | 待实施者在实现 Task 3.10 时**核实清楚**：WS 续写按姊妹 spec 的设计是"重新派发上游轮"（新 `upstream turn`，非同连接续帧），这与 Anthropic/CC/Responses-HTTP"同一个 `runResponseBufferedSink` 循环内 `continue`"的机制**不同构**——姊妹 spec Task 6.2（`plan-4-7-remaining.md:59-62`）本身也标注这是"承重实现细节"，其 close-code（1011）/ `sendErrorAndClose` 与增量 commit 时序如何与 `runResponseBufferedSink` 的 continuation 分支对接，**在姊妹 spec 落地前无法确定**，不是本 planner 能越权替姊妹 spec 做的实现决策。 |

**姊妹依赖状态（本次核实，非猜测）**：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1（`WS 升块级`，`:55-57`）与 Task 6.2（`WS 续写传输时序`，`:59-62`）**均为未勾选的 `- [ ]` 待办项**；`git log --oneline` 显示该文件自 `6696e201`（首次提交，2026-07-22）后再无提交，`git log --oneline master -- src/routes/responses/ws.ts` 也未见任何 WS 块级/续写相关改动——**Task 3.8/3.9/3.10（本特性 Responses-WS 续写）在实施前须重新核实该状态**（若届时仍未落地，按 Task 3.8 既定分支：标记阻塞、登记 backlog，不阻塞 CC/Responses-HTTP 收口）。

---

### Responses WS fallback（`openai-responses × ws:/chat/completions`，客户端 WS，`viaFallback=true`）—— **新增行（2026-07-27 major 修订，原表格遗漏）**

**状态：已实测锁定——`ws.ts` 与 HTTP handler 不同，WS fallback 恒走 live，与 buffered 配置无关。**

| 要素 | 内容（标注核实来源） |
|---|---|
| 是否走 buffered | **否，已实测确认**——`tests/responses/ws-buffered.it.test.ts:487-515`（测试标题「buffered ON + via-chat-completions fallback stays LIVE」）在 `setStateForTests({ responsesBufferedRetry: true, ... })`（buffered 显式开启）下，WS fallback 请求仍只调用一次上游（`expect(upstreamCalls).toBe(1)`）、`getProtectStreamingStats()` 为空对象（从未调用 `onBufferedResolve`，证明从未进入 `runResponseBufferedSink`）。本次独立复跑该测试文件：**5 pass，0 fail**。 |
| 与 HTTP fallback 的关键差异 | HTTP fallback（`responses/handler-v4.ts`）与 direct 共用 `resolveResponsesBufferedAndHeartbeat()` 的 `buffered` 判据；**WS fallback 不遵循这个共享规则**——`ws.ts:390` 的 `buffered = bufferedConfigured` 虽然形式上与 direct 同一变量，但实测结果表明 fallback 分支实际未进入 buffered 提交路径。**具体分流机制未经白盒代码路径追踪确定**（本次核实的确定性来自黑盒实测：已知输出、未追完整因果链，诚实标注为待 P3 深入读码——候选线索包括 `maybeRunHedgedResponseSink` 的 hedge 短路条件、`createRuntimeHedgePolicy` 的 fallback 特化行为、或 `responsesFallbackScratch` 在 codec 层触发的某种旁路，均未逐行验证）。**与 M 矩阵原表格「Responses fallback 同一个 buffered 调用、可挂载」的概括不相容**：那个结论只对 HTTP fallback 成立，WS fallback 是独立 leg，不能一概而论。 |
| 本特性可挂载？ | **本版本不支持**——该 leg 恒走 live，无 buffered 挂载点。P3 须显式登记 backlog，且须补 producer oracle 断言 max_tokens continuation 配置在此 leg 从不生效（复用 `ws-buffered.it.test.ts` 的既有正样本，追加 max_tokens 场景变体）。 |

### Responses WS reverse `@messages`（`openai-responses × ws:/v1/messages`，客户端 WS）—— **新增行（2026-07-27 major 修订，原表格遗漏）**

**状态：路由层可达，但 WS handler 未接线该分支——现状是缺陷而非明确拒绝，未经实测复现，标「路由可达但 handler 未接线」。**

| 要素 | 内容（标注核实来源） |
|---|---|
| 路由可达性 | `resolveModelTarget(requestedModel)`（`ws.ts:270`）解析 `@messages` 后缀是**通用逻辑**（`src/lib/models/resolver.ts:199`），与 HTTP/WS 传输无关；`routeOverride` 被传入 `driver.runRequest`（`ws.ts:303`），router 的 `decideExplicitLeg`（`router.ts:146-169`）对 `openai-responses` 客户端格式没有区分 HTTP/WS——若模型支持 `supportsDirectAnthropicApi`，`env.targetEndpoint` 会被设为 `ENDPOINT.MESSAGES`，与 HTTP 路径完全同构。**故路由层确认可达**，非仅理论可能。 |
| handler 接线现状 | HTTP 的 `responses/handler-v4.ts:233` 有明确的 `if (reverseMessages) await pumpReverseAnthropicLegV4({...})` 分派；**`ws.ts` 全文 grep 无 `reverseMessages`/`ENDPOINT.MESSAGES` 判断**（`grep -n "reverseMessages\|ENDPOINT.MESSAGES" src/routes/responses/ws.ts` 零命中）——`ws.ts` 无条件调用 `responsesCandidateSnapshot(driver, upstream)` 并断言 `candidate.kind !== "responses"` 即 `throw new Error("[WS] wrong candidate response session kind")`（`ws.ts:411-412`）。若真的路由到 `ENDPOINT.MESSAGES`，`createResponsesCandidateResponseSessionFactory("ws")` 会返回 `kind:"reverse-anthropic"` 的 session（`candidate-response-session.ts:64-101`，与 targetEndpoint 判断逻辑对 HTTP/WS 通用），与 `ws.ts:411` 的 `candidate.kind !== "responses"` 断言冲突——**该分支会抛错**（`[WS] wrong candidate response session kind`），而非优雅拒绝或正确处理。 |
| 是否已实测复现 | **未实测**——本次核实止步于静态读码推导（路由可达性 + 断言逻辑），未实际发起一个 WS `@messages` 请求验证抛错行为，也未确认路由决策前是否有更早的 400 拒绝（例如某个尚未读到的模型能力校验提前拦截）。诚实标注为「静态推导，非实测确认」，与本文件其余各行的实测/读码标准区别对待。 |
| 本特性可挂载？ | **不适用/待修复**——即便 handler 接线完成，该 leg 的走向仍需先决定"是否要支持 WS reverse @messages"这一更基础的产品问题（不在本特性范围内）。本特性对此 leg 的立场：**不主动接入，须补一条 producer oracle 确认现状**（无论是抛错还是某种优雅拒绝），避免本特性上线后被误认为覆盖了这个 leg。**须实施者在 P3 前先跑一次真实探针确认现状**（本次核实方法：`curl`/WS 客户端向 `/responses` 发一个 `model` 带 `@messages` 后缀且该模型 `supportsDirectAnthropicApi` 为真的 `response.create`，观察连接是关闭还是抛 500）。 |

---

### 已确定「本版本不支持」：`openai-responses × /v1/messages`（reverse leg，HTTP）

| 要素 | 内容 |
|---|---|
| 是否走 buffered | **否，已确认**——round-2 复核亲自读取 `pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576-645`）完整函数体，`:585` 明确调用 `driver.runResponseSink(upstream, env, sink)`（非 `runResponseBufferedSink`）。与 `openai-cc×/v1/messages`reverse（已确认不用 buffered，docstring 明文「L2 buffered-retry is NOT applied on the reverse leg」）同构一致，非猜测类推——两者是同一类"reverse leg 无缓冲"架构决策的两个具体实例。 |

---

## 三维分栏（2026-07-27 建议采纳，避免同一 targetEndpoint 下不同 pump 的 buffered/commit-boundary 语义被误判成同构）

审查建议把「router cell」「客户端 transport leg」「上游物理 transport」三个维度分开，不再用「Responses direct，HTTP/WS」一行同时表示不同 handler。三层关系：

1. **router cell（12 个，`decideRouteFromInput` 决策空间）**——`(clientFormat × targetEndpoint)`，与客户端用 HTTP 还是 WS 连接无关，纯粹是"这次请求的 body 是什么格式、路由到哪个上游端点"。上方「每格是否走 buffered 路径」表格是这一层。
2. **客户端 transport leg（实际 handler/pump 展开）**——同一个 router cell 在 `openai-responses` 格式下会因客户端连接方式（HTTP SSE vs WS）分裂成不同的 handler 文件（`responses/handler-v4.ts` vs `responses/ws.ts`），两者的 buffered 判据、commit boundary、fallback 语义**互不相同**（本次核实的 WS fallback stays-LIVE 现象就是明证）。下表展开这一层：

| 客户端 transport | targetEndpoint | Handler 文件 | buffered 判据来源 | 本特性可挂载？ |
|---|---|---|---|---|
| HTTP SSE | `/responses`（direct） | `responses/handler-v4.ts` | `resolveResponsesBufferedAndHeartbeat()` 读 `state.responsesBufferedRetry` | 是（依赖该开关 `true` + ③修法落地） |
| HTTP SSE | `/chat/completions`（fallback） | `responses/handler-v4.ts`（同一文件，`viaFallback` 分支） | 同上，共用同一个 buffered 判据（docstring 确认共享） | 是（同上依赖） |
| HTTP SSE | `/v1/messages`（reverse） | `responses/handler-v4.ts`（`pumpReverseAnthropicLegV4`） | 无——结构性走 `runResponseSink` | 本版本不支持 |
| WS | `/responses`（direct） | `responses/ws.ts` | `resolveResponsesBufferedAndHeartbeat()`（同一函数，但 `commitBoundaries` 故意省略——terminal-only） | 是（依赖同一开关 + terminal-only 语义，非块级） |
| WS | `/chat/completions`（fallback） | `responses/ws.ts`（同一文件，`viaFallback` 分支） | **实测走 live，与 buffered 配置无关**（本次新增核实，见上方独立小节） | **本版本不支持**（结构性走 live，与 HTTP fallback 不同构） |
| WS | `/v1/messages`（reverse） | `responses/ws.ts`——**无对应分派分支** | 不适用（未接线，会抛错，未实测复现） | **不适用/待修复**（见上方独立小节） |

3. **上游物理 transport（HTTP/1.1 vs HTTP/2 vs WS 上游连接）**——本特性不关心这一层（它是传输优化维度，与 buffered/commit-boundary 语义正交），列出仅为完整性：Anthropic/CC/Responses HTTP 上游走 h2 连接池（`docs/memory/project-h2-pool-capacity-routing-and-pre-response-retry.md`），Responses WS 上游走独立的 `createUpstreamResponsesTransport`（WS-to-WS）。这一层的选择不影响本特性的截获点判定，故本文件其余部分均未展开。

---

## 不适用/不支持格的一句话结论 + producer oracle 目标

| leg | 结论 | producer oracle 目标（P3 须实现，钉死「确实透传、未被误挂载」） |
|---|---|---|
| `anthropic × /chat/completions`translate | 本版本不支持（无 buffered），强制透传 | `test("anthropic @cc translate leg: max_tokens passes through untouched, continuation never triggers")` |
| `anthropic × /responses`translate（HTTP+WS） | 同上 | 同构测试，HTTP+WS 各一条 |
| `openai-cc × /v1/messages`reverse | 本版本不支持（无 buffered，docstring 明文），强制透传 | `test("cc reverse @messages leg: max_tokens passes through untouched")` |
| `openai-responses × /v1/messages`reverse（HTTP） | 本版本不支持（无 buffered，已确认非待核实），强制透传 | `test("responses reverse @messages leg: max_tokens passes through untouched via runResponseSink")`（见 `plan-3-cc-responses.md` Task 3.12） |
| `openai-responses × ws:/chat/completions`fallback | **本版本不支持（新增，实测锁定 stays LIVE）** | `test("responses WS fallback: max_tokens_continuation config is never consulted (stays live regardless of buffered config)")`——复用 `ws-buffered.it.test.ts` 的既有正样本场景 |
| `openai-responses × ws:/v1/messages`reverse | **不适用/待修复（新增，静态推导未实测，标注不确定性）** | `test("responses WS reverse @messages leg: current behavior is [抛错/拒绝/其他]（须先跑真实探针确定现状再写断言）")`——**本条 oracle 的具体断言内容依赖先跑探针，不能凭推导编造** |
| `gemini × *`（全部 3 格） | 不适用（N1，Gemini 入站排除，且已确认只走 `runResponseSink`） | `test("gemini inbound: max_tokens_continuation config is never consulted (N1 exclusion)")` |

---

## 矩阵收口任务

### Task M.1: 核实全部「待核实」格 + 补全四要素 —— **已完成（2026-07-27，planner 读码核实）**

- [x] 亲自读 `src/routes/chat-completions/handler-v4.ts` 的 `[DONE]` 合成完整时序（CC direct 行④）——`runResponseBufferedSink` 内部 `for(;;)` 循环唯一 `return`，handler 拿到的 outcome 已是续写全部完成后的终局，无需额外协调机制；原"待核实"的顾虑已证伪排除。
- [x] 亲自读 `src/routes/responses/handler-v4.ts` direct 路径的 `max_tokens`/`incomplete` 正常终止构造点（Responses direct 行②④）+ 核实 CC via-responses / Responses fallback 两个交叉场景的触发判据来源——**两个交叉场景的 Responses↔CC 翻译均发生在 render 阶段**（`createStreamTranslator`/`createCCToResponsesStreamTranslator`），**早于** `onRenderedFrame` 里的 accumulate 调用，故触发判据读到的值已经是目标格式的形状，与对应 direct 变体完全同构，均可直接复用 direct 变体的截获逻辑（不需要额外适配层——原方案"若翻译发生更晚需要适配层"的分支已被证伪排除）。
- [x] 核实姊妹 spec Responses-WS 续写传输时序的实施状态（`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1/6.2）——**均未落地**（`- [ ]` 未勾选，该文件自首次提交 `6696e201` 后无后续提交，`git log master -- src/routes/responses/ws.ts` 无相关改动）。P3 Task 3.8 判定分支应走"标记阻塞，登记 backlog，不阻塞 CC/Responses-HTTP 收口"。
- [ ] **P3 实施前须重新执行一次本核实**（本次核实基于 master `db1cb775`，2026-07-27；实施时点若有新的并发提交需重新读码确认，尤其 WS 姊妹依赖状态——可能在 P3 开工前已推进）。
- [ ] 每个可挂载格核实后，写一个 producer-oracle 单测断言④要素（"唯一终局"不变量）；每个「不支持/不适用」格写对应的透传 producer oracle（上表已列目标，含已确认的 Responses reverse leg，见 `plan-3-cc-responses.md` Task 3.12）——**测试骨架待 P3 实施时按上述读码结论编写，本任务只完成读码核实，不写测试代码（属 P3 范畴）**。
- [ ] **提交** → `docs(plan): fill terminal ownership matrix M (full leg enumeration verified via code read, 2026-07-27)`。

**验收标准：** 5 个「可挂载」格（Anthropic direct、CC direct、CC via-responses、Responses direct、Responses fallback）的四要素全部落实到具体 file:line（**已达成**）+ producer-oracle 测试骨架（**留待 P3**）；4 个「不支持」格（含已确认的 Responses reverse）+ 3 个「不适用」格的透传 oracle 全部写出（**留待 P3**）。**2026-07-27 复审后更正：本验收标准本身不完整——它只覆盖 12 个 router cell，未覆盖客户端 transport 展开后新增的 2 行（WS fallback stays-live、WS reverse 未接线），也未覆盖 Responses HTTP direct/fallback 的③要素 blocker——这些已在 Task M.3/M.4 补齐，P3 开工前须一并确认。**

### Task M.2: 与 P0 的 `incomplete_details.reason` 缺口交叉确认 —— **已完成（该字段已在 P0 落地，非缺口）**

- [x] 核实 P0 Task 0.2（Anthropic-only 独立 terminal observer）与 Task 0.3（per-format 纯 predicate）的分工——**读码确认**：`src/lib/openai/responses-stream-accumulator.ts:140` 已捕获 `incompleteReason`（提交 `b8b5e7c2`，属 `f0bd5f73 docs(plan): complete max_tokens continuation P0`），`plan-0-classifier-and-observability.md` 顶部已标注"P0 已完成"且第 11 行明确"CC/Responses 的 `incomplete_details.reason` 捕获和纯 terminal predicate 已在 P0 落地；它们的 terminal observer、分类生产接线与 History/telemetry readback 仍是 P3 的显式硬前置"——与本文件的分工假设一致，无需改动。
- [x] 与 `plan-3-cc-responses.md` 核对不重复实现——该文件依赖声明（顶部"依赖"行）已写明"`incomplete_details.reason` 已在 P0 捕获"，Task 3.0b 只消费已建好的字段，未见重复实现风险。
- [ ] **提交** → `docs(plan): cross-confirm incomplete_details.reason capture already landed in P0 (b8b5e7c2), matrix M.2 assumption updated from stale "not yet captured" to confirmed`。

### Task M.3: 修正 blocker——buffered 条件选择 vs 无条件可挂载 —— **本轮已完成读码核实 + 修订（2026-07-27）**

- [x] 亲自读 `handler-v4.ts:1105-1113`（Anthropic `resolveBufferedAndHeartbeat`）、`chat-completions/buffered-config.ts`（`resolveCcBufferedAndHeartbeat`）、`responses/buffered-config.ts`（`resolveResponsesBufferedAndHeartbeat`）三处独立配置判据，确认 `max_tokens_continuation.enabled` 在任何一处都不参与 `buffered` 判定。
- [x] 确认 Anthropic 默认 `protectStreamingGeneration:false`（`state-defaults.ts:78`）→ 默认走 live，本特性截获点不可达；CC/Responses 默认 `true`（`state-defaults.ts:94/233`）→ 当前默认可达，但操作员可独立关闭致特性静默失效。
- [x] 记录用户裁决（2026-07-27）：不做条件耦合补丁，改为完成姊妹 spec §6.3 默认翻转（Anthropic buffered 默认 on），已同步进 spec `2026-07-22-max-tokens-continuation.md` §5.3（commit `793c9bb7`，master 已有）。
- [x] 核实翻转前置门 G2 的最新状态——已在并发 worktree `.worktrees/keepalive-300s` 查明根因（`recoverToolCallText` marker lookahead 吞掉空 delta，非 CC 死线或代理 stall 检测本身），修复 commit `131ea3b2` + 按需升级保活 WIP 尚未合并 master。**本次核实止步于读取该 worktree 的提交历史 + 工作区 diff，未在本 worktree 内重新独立验证 G2 修复的正确性**（那是该 worktree 的职责范围，本文件只记录依赖状态）。
- [ ] **P1 实施前须重新核实**：姊妹 spec §6.3 翻转、G2 修复是否已合并 master（本次核实时点两者均未合并，只是"进行中"）。
- [ ] **提交** → `docs(plan): matrix M — replace unconditional "buffered" claim with per-format condition + post-flip mounting contract (blocker fix)`。

### Task M.4: 修正 major——Responses HTTP 截获点 + WS transport leg 展开 —— **本轮已完成读码核实 + 修订（2026-07-27）**

- [x] 亲自读 `src/lib/codec/openai-responses/commit-boundaries.ts:18-23`，确认 `RESPONSES_COMMIT_BOUNDARY_TYPES` 包含三个 lifecycle terminal，非只有 `output_item.done`。
- [x] 亲自读 `driver.ts:1146-1149`（`onRenderedFrame`/`commitBoundaries?.()` 判断顺序）+ `:1240`（boundary flush 分支），确认 accumulator 更新早于 boundary 判断、boundary 判断早于 `:1336` 终局判断——`response.incomplete` 会在 `:1240` 提前 flush。
- [x] 给出两个候选修法（boundary flush 前判定 / max-tokens 模式收窄 commit predicate）+ 对应 producer oracle 目标，留给 P3 落地时选择（本 planner 不越权替 P3 定案，因为两个候选各有取舍——候选①改动面更小但要在 driver 通用代码里嵌入 format 特定判断，候选②改动局限在 Responses codec 内但会让该请求"临时改变块级粒度"，需要 P3 实施者结合其他块级依赖方一并评估）。
- [x] 独立复跑 `tests/responses/ws-buffered.it.test.ts`（5 pass），确认 WS fallback stays-LIVE 是可复现的实测事实，非猜测。
- [x] 静态推导 WS `@messages` reverse 的路由可达性 + handler 断言冲突，诚实标注为"未实测复现"。
- [x] 新增「客户端 transport leg 展开表」区分 router cell（12 个）与实际 handler/pump（Responses 因客户端 transport 分裂为 6 行：HTTP direct/fallback/reverse + WS direct/fallback/reverse）。
- [ ] **提交** → `docs(plan): matrix M — fix Responses HTTP intercept-site major (commit-boundary flushes before terminal drain) + expand Responses WS fallback/reverse legs (major)`。
