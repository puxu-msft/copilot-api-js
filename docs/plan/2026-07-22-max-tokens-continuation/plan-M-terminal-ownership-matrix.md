# Plan-M: terminal ownership matrix（两轮审查共同点名的 plan 首要交付物）

> **修订记录（2026-07-23，据 GPT plan-review [major] 全 leg 枚举意见修订）**：原版本只列了 4 个同格式直连格（Anthropic direct / CC direct / Responses HTTP direct / Responses WS），被审查指出遗漏运行时真实存在的 translate/fallback/reverse legs（`handler-v4.ts:1123-1137` 的 `@cc`/`@responses` translate、`:1501-1505` 明文注释该 translate leg 不可复用 buffered 判据、`responses/handler-v4.ts:194-235` 的 `viaFallback`/`reverseMessages`）。本版本**从路由决策代码逐条枚举全部运行时可达的 `(inbound × outbound)` 格**，非凭空猜测组合——每格标注该 leg 是否走 `runResponseBufferedSink`（本特性可挂载）还是 `runResponseSink`（当前无缓冲、本特性在该 leg 上只能是「本版本不支持，强制透传」）。
>
> **修订记录三（2026-07-27，planner 亲自读码核实，master `db1cb775`）**：本轮对全部「待核实（M.1）」格逐一读码核实，补全四要素，发现两处此前假设的核实缺口已被并发会话的 P0 落地实质关闭：① `incomplete_details.reason` 捕获——`src/lib/openai/responses-stream-accumulator.ts:140`（`accumulateResponsesStreamEvent` 的 `response.incomplete` 分支）**已捕获**（`acc.incompleteReason = event.response.incomplete_details?.reason`，提交 `b8b5e7c2 fix(responses): retain incomplete terminal reason`，属 `f0bd5f73 docs(plan): complete max_tokens continuation P0` 一部分）——原表格 M.2 交叉确认里"当前未被捕获"的表述已过时，本次同步更正为"已捕获"；② P0 的 Anthropic-only observer 分档决策（`plan-0-classifier-and-observability.md`）已按计划落地并标注"P0 已完成"，与本文件 Task M.2 的分工假设一致，无需改动。**结论不变，但依据从"计划假设"升级为"读码确认"**——下述各格的④要素、CC/Responses 交叉场景判据来源、WS 依赖状态均已逐条重新核实（细节见各小节，未核实到的角落已诚实标注 + 给出具体核实方法）。

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

**每格是否走 buffered 路径（本特性可挂载的前提）：**

| clientFormat × targetEndpoint | Handler pump 函数 | Buffered？ | 本特性可挂载？ |
|---|---|---|---|
| `anthropic` × `/v1/messages`（direct） | `pumpAnthropicStreamingV4`（`messages/handler-v4.ts:1176`） | 是（`runResponseBufferedSink`，`:1203`） | **是**——P1 主目标 |
| `anthropic` × `/chat/completions`（`@cc` translate） | `pumpTranslateLegStreamingV4`（`messages/handler-v4.ts:1508`） | **否**（`:1525` 调用 `driver.runResponseSink`，非 buffered；`:1501-1505` 明文注释 buffered 在 translate leg 是 deferred backlog） | **本版本不支持**——强制透传，登记 backlog（与既有 `docs/todo/deferred-backlog.md` "buffered-retry on translate leg deferred" 条目共享同一根因，本特性不重复造轮子，直接引用） |
| `anthropic` × `/responses`（`@responses` translate，HTTP+WS） | 同上 `pumpTranslateLegStreamingV4` | 否 | **本版本不支持**——同上 |
| `openai-cc` × `/chat/completions`（direct） | `pumpStreamingV4`（`chat-completions/handler-v4.ts:494`，非 reverse 分支） | 是（`:542`） | **是**——P3 CC 子任务 |
| `openai-cc` × `/v1/messages`（reverse，upstream 是 Anthropic） | `pumpReverseAnthropicLegV4`（`chat-completions/handler-v4.ts:734`） | **否**（`:744` 调用 `driver.runResponseSink`；docstring 明文「L2 buffered-retry is NOT applied on the reverse leg (RFC §7.3 / OQ6 — the CC client has no equivalent)」） | **本版本不支持**——强制透传，登记 backlog |
| `openai-cc` × `/responses`（via-responses，CC body 经 prepareWire 转 Responses wire） | 复用 `pumpStreamingV4`（同 CC direct 判据，但 `translateOut` 已在 S2 把上游 wire 转 Responses，客户端仍看 CC 帧） | 是（同 CC direct，走 `runResponseBufferedSink`） | **是**——但**触发判据须读 Responses 上游的 `incomplete`，转译回 CC `finish_reason=length` 给客户端**，是 CC builder 与 Responses accumulator 的交叉场景，P3 CC 子任务须显式覆盖此变体，不能只测 CC direct |
| `openai-responses` × `/responses`（direct，HTTP+WS） | `pumpStreamingV4`（`responses/handler-v4.ts:320`，`viaFallback=false`） | 是（`:380`，HTTP/WS 共用同一 buffered 判据函数，WS 另有独立 pump 但共享 accumulator 类型） | **是**——P3 Responses 子任务 |
| `openai-responses` × `/chat/completions`（fallback，`viaFallback=true`） | 同 `pumpStreamingV4`，`viaFallback` 分支 | 是（**同一个 buffered 调用**，`viaFallback` 只影响是否等待 fallback session 注册，不影响 buffered 判据；docstring `:336-338` 确认「direct and via-chat fallback now share the same buffered unit」） | **是**——但触发判据是 CC 的 `finish_reason=length`（因为 fallback 时上游 wire 已是 CC），需在 P3 Responses 子任务显式覆盖 fallback 变体（与 direct 变体共用 handler 代码但触发信号来源不同） |
| `openai-responses` × `/v1/messages`（reverse，upstream 是 Anthropic） | `pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576-645`） | **否，已确认**（`:585` 明确调用 `driver.runResponseSink(upstream, env, sink)`，非 `runResponseBufferedSink`——round-2 复核已亲自读取完整函数体，非「待核实」） | **本版本不支持**——强制透传，登记 backlog（与 `openai-cc×/v1/messages`reverse 同构确认，非猜测类推） |
| `gemini` × `/chat/completions`（direct，委托内部 CC codec） | `pumpGeminiStreamingV4`（`gemini/handler-v4.ts:415`） | 否（只调用 `runResponseSink`，已核实） | **不适用（N1，Gemini 入站排除）** |
| `gemini` × `/v1/messages`（reverse） | `pumpReverseGeminiStreamingV4`（`gemini/handler-v4.ts:623`） | 待核实但**不适用（N1）** | **不适用（N1）** |
| `gemini` × `/responses`（via-responses） | 待核实但**不适用（N1）** | 待核实 | **不适用（N1）** |

**收窄结论（本特性实际覆盖范围，非全部 12 格）：**
- **可挂载且本计划覆盖：** `anthropic×/v1/messages`（P1）、`openai-cc×/chat/completions`（P3）、`openai-cc×/responses`via-responses 变体（P3，需交叉覆盖）、`openai-responses×/responses`（P3）、`openai-responses×/chat/completions`fallback 变体（P3，需交叉覆盖）。
- **本版本不支持、强制透传、登记 backlog（因为底层根本不走 buffered，全部已确认非待核实）：** `anthropic×/chat/completions`translate、`anthropic×/responses`translate（HTTP+WS）、`openai-cc×/v1/messages`reverse、`openai-responses×/v1/messages`reverse。
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

**状态：本 planning 期已亲自读码确认，P1 直接可用。**

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | `src/lib/anthropic/stream-accumulator.ts` `AnthropicStreamAccumulator.stopReason`（由 `message_delta.delta.stop_reason` 填充），`sawMessageStop` 标记 `message_stop` 已到达 |
| ②terminatorConstructor | 无需构造——bypass-direct，上游帧逐字透传；driver 的 terminal drain（`src/lib/pipeline/driver.ts:1336`）flush 缓冲的 `message_delta`+`message_stop` |
| ③interceptSite | **`driver.ts:1336` 判断为真、`:1348` flush 之前** |
| ④finalCompletionOwner | 续写链最终轮再次抵达 `:1336` 判断点，走正常 flush——同一段代码是唯一终局 |

**P1 实现要点：** 新增的成功终止截获，不能复用 cut path（`:1401-1453`）的 `canContinue` 门——两者是 driver `for(;;)` 循环内互斥的不同代码路径。

---

### CC direct（`openai-cc × /chat/completions`）

**状态：全部四要素已读码核实（2026-07-27），可直接用于 P3 Task 3.2。**

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

### Responses HTTP direct（`openai-responses × /responses`，`viaFallback=false`）

**状态：全部四要素已读码核实（2026-07-27）；`incomplete_details.reason` 捕获缺口已被 P0 关闭（非本阶段待办）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/lib/openai/responses-stream-accumulator.ts:99-186` `accumulateResponsesStreamEvent`：`case "response.incomplete"`（`:138-141`）填充 `acc.status = event.response.status` **且** `acc.incompleteReason = event.response.incomplete_details?.reason`——**该字段已捕获，非待核实项**：提交 `b8b5e7c2 fix(responses): retain incomplete terminal reason`（属 `f0bd5f73 docs(plan): complete max_tokens continuation P0`），`plan-0-classifier-and-observability.md` 顶部已标注"P0 已完成"且明确"CC/Responses 的 `incomplete_details.reason` 捕获…已在 P0 落地"。**原表格"当前未被捕获"的表述是过时快照，本次同步更正。** |
| ②terminatorConstructor | `response.completed`/`.incomplete`/`.failed` 三个 Responses 原生 lifecycle 事件由上游直接携带（无客户端侧二次构造）；这三者也是 `isResponsesCommitBoundary`（`src/lib/codec/openai-responses/commit-boundaries.ts:18-32`）认定的 commit boundary 之一，驱动 `driver.ts` 的块级 flush。终止后 handler 不再合成额外终止帧（Responses 协议自带完整 lifecycle，无 CC 式 `[DONE]` 后缀）。 |
| ③interceptSite | driver 的 terminal drain 判断点（`driver.ts:1336`，`sawMessageStop`读 `acc.status !== ""`，`responses/candidate-response-session.ts:138`）——与 Anthropic/CC 共享同一段代码；块级路径下（HTTP 走 `commitBoundaries: isResponsesCommitBoundary`，`candidate-response-session.ts:140`）截获点还需考虑块级 boundary flush（`:1240` 附近的 `commitBoundaries?.()` 分支）与终局 flush（`:1348`）两处——**`max_tokens` 截获必须在终局 flush（`:1336`判断真）处，不是块级 boundary**（块级 boundary 只是中间 `output_item.done`，不代表整个响应终止）。 |
| ④finalCompletionOwner | 同 CC direct——`runResponseBufferedSink` 内部 `for(;;)` 循环唯一 `return`，handler（`responses/handler-v4.ts:378-499`）拿到的 outcome 已是续写全部完成后的终局，无需额外协调。 |

### Responses fallback（`openai-responses × /chat/completions`，`viaFallback=true`，交叉场景——Responses 客户端 body，上游实际是 CC）

**状态：全部四要素已读码核实（2026-07-27）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | 同 Responses direct（**同一个 `createResponsesCandidateResponseSessionFactory` 非 reverse 分支**，`candidate-response-session.ts:106-166`，`viaFallback` 只影响 `fallbackResponseId` 的读取来源，不影响 accumulator 类型），但上游 wire 实际是 CC——render 阶段先经 `createCCToResponsesStreamTranslator`（`src/lib/openai/translate/responses-to-cc-request.ts:251-`）把 CC SSE 帧译成 Responses 事件（`codec.ts:263-265` 的 `ensureCcTranslator().translate()`），CC 的 `finish_reason:"length"` 在这里被译成 `ccFinishReasonToResponsesStatus("length")` → `{ status: "incomplete", incompleteReason: "max_output_tokens" }`（`responses-to-cc-request.ts:511-513`）——**触发判据读到的 `acc.status`/`acc.incompleteReason` 已经是翻译后的 Responses 形状**，与 direct 完全同构，翻译发生在 render 阶段（早于 `onRenderedFrame` 里的 `accumulateResponsesStreamEvent`），不存在"CC 形状漏读"的风险。 |
| ②terminatorConstructor | 同 Responses direct——三个 lifecycle 事件（此处是翻译合成的 `response.completed`，携带 `incomplete` status）由 render 阶段产出，非 handler post-loop 二次构造。 |
| ③interceptSite | 同 Responses direct——driver `:1336` 判断点，帧已经过 CC→Responses render 翻译。 |
| ④finalCompletionOwner | 同 Responses direct/CC direct——`runResponseBufferedSink` 单一循环终局。**结论：Responses fallback 与 direct 在④要素上完全同构，P3 Task 3.7b 可直接复用 Task 3.6 的截获逻辑（原文档"待核实"的交叉适配顾虑已被证伪排除）。** |

---

### Responses WS（`openai-responses × ws:/responses`）

**状态：核心机制已读码核实；WS 块级续写的姊妹依赖状态已确认——姊妹 spec Task 6.1/6.2 均未落地（2026-07-27 核实）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | 同 Responses HTTP（共用同一个 `createResponsesCandidateResponseSessionFactory("ws")`，`candidate-response-session.ts:60-166`），但 `commitBoundaries` **故意省略**（`ws.ts:376-396` 明文注释：WS 不能复用 HTTP 的 `isResponsesCommitBoundary` 块级谓词，因为 `response.output_item.done` 在 WS 语境下提交一个块会过早关闭重试窗口——`committedAny` 提前置真，导致 `output_item.done` 之后、`response.completed` 之前的丢包错误降级为 `partial-degrade` 而非重试）。故 WS 是 **terminal-only** 提交：`driver.ts` 的 `sawMessageStop`/`sawUpstreamError` 是唯一 commit 触发点。 |
| ②terminatorConstructor | 同 HTTP：三个 lifecycle 事件由上游原生携带；WS 额外有 `stopAfterFrame`（`candidate-response-session.ts:141-146`，`TERMINAL_EVENTS` 命中即停止读取，避免读过 `response.completed` 挂到 idle-timeout）。 |
| ③interceptSite | 同 HTTP——driver `:1336`——但 WS **没有块级 boundary**（`commitBoundaries` 未传入 `runResponseBufferedSink`，`ws.ts:393-408`），故本特性在 WS 上只能是**整响应级**的 max_tokens 截获（与 CC 的终局-only 判据同构，非 Responses HTTP 的块级判据）。 |
| ④finalCompletionOwner | 待实施者在实现 Task 3.10 时**核实清楚**：WS 续写按姊妹 spec 的设计是"重新派发上游轮"（新 `upstream turn`，非同连接续帧），这与 Anthropic/CC/Responses-HTTP"同一个 `runResponseBufferedSink` 循环内 `continue`"的机制**不同构**——姊妹 spec Task 6.2（`plan-4-7-remaining.md:59-62`）本身也标注这是"承重实现细节"，其 close-code（1011）/ `sendErrorAndClose` 与增量 commit 时序如何与 `runResponseBufferedSink` 的 continuation 分支对接，**在姊妹 spec 落地前无法确定**，不是本 planner 能越权替姊妹 spec 做的实现决策。 |

**姊妹依赖状态（本次核实，非猜测）**：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1（`WS 升块级`，`:55-57`）与 Task 6.2（`WS 续写传输时序`，`:59-62`）**均为未勾选的 `- [ ]` 待办项**；`git log --oneline` 显示该文件自 `6696e201`（首次提交，2026-07-22）后再无提交，`git log --oneline master -- src/routes/responses/ws.ts` 也未见任何 WS 块级/续写相关改动——**Task 3.8/3.9/3.10（本特性 Responses-WS 续写）在实施前须重新核实该状态**（若届时仍未落地，按 Task 3.8 既定分支：标记阻塞、登记 backlog，不阻塞 CC/Responses-HTTP 收口）。

---

### 已确定「本版本不支持」：`openai-responses × /v1/messages`（reverse leg）

| 要素 | 内容 |
|---|---|
| 是否走 buffered | **否，已确认**——round-2 复核亲自读取 `pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576-645`）完整函数体，`:585` 明确调用 `driver.runResponseSink(upstream, env, sink)`（非 `runResponseBufferedSink`）。与 `openai-cc×/v1/messages`reverse（已确认不用 buffered，docstring 明文「L2 buffered-retry is NOT applied on the reverse leg」）同构一致，非猜测类推——两者是同一类"reverse leg 无缓冲"架构决策的两个具体实例。 |

---

## 不适用/不支持格的一句话结论 + producer oracle 目标

| leg | 结论 | producer oracle 目标（P3 须实现，钉死「确实透传、未被误挂载」） |
|---|---|---|
| `anthropic × /chat/completions`translate | 本版本不支持（无 buffered），强制透传 | `test("anthropic @cc translate leg: max_tokens passes through untouched, continuation never triggers")` |
| `anthropic × /responses`translate（HTTP+WS） | 同上 | 同构测试，HTTP+WS 各一条 |
| `openai-cc × /v1/messages`reverse | 本版本不支持（无 buffered，docstring 明文），强制透传 | `test("cc reverse @messages leg: max_tokens passes through untouched")` |
| `openai-responses × /v1/messages`reverse | 本版本不支持（无 buffered，已确认非待核实），强制透传 | `test("responses reverse @messages leg: max_tokens passes through untouched via runResponseSink")`（见 `plan-3-cc-responses.md` Task 3.12） |
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

**验收标准：** 5 个「可挂载」格（Anthropic direct、CC direct、CC via-responses、Responses direct、Responses fallback）的四要素全部落实到具体 file:line（**已达成**）+ producer-oracle 测试骨架（**留待 P3**）；4 个「不支持」格（含已确认的 Responses reverse）+ 3 个「不适用」格的透传 oracle 全部写出（**留待 P3**）。P3 才能开工——本次读码核实已清空全部"待核实"标注，P3 开工的唯一剩余前置是编写实际测试代码。

### Task M.2: 与 P0 的 `incomplete_details.reason` 缺口交叉确认 —— **已完成（该字段已在 P0 落地，非缺口）**

- [x] 核实 P0 Task 0.2（Anthropic-only 独立 terminal observer）与 Task 0.3（per-format 纯 predicate）的分工——**读码确认**：`src/lib/openai/responses-stream-accumulator.ts:140` 已捕获 `incompleteReason`（提交 `b8b5e7c2`，属 `f0bd5f73 docs(plan): complete max_tokens continuation P0`），`plan-0-classifier-and-observability.md` 顶部已标注"P0 已完成"且第 11 行明确"CC/Responses 的 `incomplete_details.reason` 捕获和纯 terminal predicate 已在 P0 落地；它们的 terminal observer、分类生产接线与 History/telemetry readback 仍是 P3 的显式硬前置"——与本文件的分工假设一致，无需改动。
- [x] 与 `plan-3-cc-responses.md` 核对不重复实现——该文件依赖声明（顶部"依赖"行）已写明"`incomplete_details.reason` 已在 P0 捕获"，Task 3.0b 只消费已建好的字段，未见重复实现风险。
- [ ] **提交** → `docs(plan): cross-confirm incomplete_details.reason capture already landed in P0 (b8b5e7c2), matrix M.2 assumption updated from stale "not yet captured" to confirmed`。
