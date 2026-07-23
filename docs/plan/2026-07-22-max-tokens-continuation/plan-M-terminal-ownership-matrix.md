# Plan-M: terminal ownership matrix（两轮审查共同点名的 plan 首要交付物）

> **修订记录（2026-07-23，据 GPT plan-review [major] 全 leg 枚举意见修订）**：原版本只列了 4 个同格式直连格（Anthropic direct / CC direct / Responses HTTP direct / Responses WS），被审查指出遗漏运行时真实存在的 translate/fallback/reverse legs（`handler-v4.ts:1123-1137` 的 `@cc`/`@responses` translate、`:1501-1505` 明文注释该 translate leg 不可复用 buffered 判据、`responses/handler-v4.ts:194-235` 的 `viaFallback`/`reverseMessages`）。本版本**从路由决策代码逐条枚举全部运行时可达的 `(inbound × outbound)` 格**，非凭空猜测组合——每格标注该 leg 是否走 `runResponseBufferedSink`（本特性可挂载）还是 `runResponseSink`（当前无缓冲、本特性在该 leg 上只能是「本版本不支持，强制透传」）。

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
| `openai-responses` × `/v1/messages`（reverse，upstream 是 Anthropic） | `pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576`） | **待核实**（planning 期未读到该函数完整实现体是否调用 `runResponseSink` 还是 `runResponseBufferedSink`——非流式路径 `:265` 明确用 `renderReverseNonStreamingV4`，流式路径 `:233` 调用 `pumpReverseAnthropicLegV4`，函数体尚待读） | **待核实（M.1 前置动作）** |
| `gemini` × `/chat/completions`（direct，委托内部 CC codec） | `pumpGeminiStreamingV4`（`gemini/handler-v4.ts:415`） | 否（只调用 `runResponseSink`，已核实） | **不适用（N1，Gemini 入站排除）** |
| `gemini` × `/v1/messages`（reverse） | `pumpReverseGeminiStreamingV4`（`gemini/handler-v4.ts:623`） | 待核实但**不适用（N1）** | **不适用（N1）** |
| `gemini` × `/responses`（via-responses） | 待核实但**不适用（N1）** | 待核实 | **不适用（N1）** |

**收窄结论（本特性实际覆盖范围，非全部 12 格）：**
- **可挂载且本计划覆盖：** `anthropic×/v1/messages`（P1）、`openai-cc×/chat/completions`（P3）、`openai-cc×/responses`via-responses 变体（P3，需交叉覆盖）、`openai-responses×/responses`（P3）、`openai-responses×/chat/completions`fallback 变体（P3，需交叉覆盖）。
- **本版本不支持、强制透传、登记 backlog（因为底层根本不走 buffered）：** `anthropic×/chat/completions`translate、`anthropic×/responses`translate（HTTP+WS）、`openai-cc×/v1/messages`reverse。
- **待 M.1 核实：** `openai-responses×/v1/messages`reverse（是否走 buffered）。
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

**状态：CC direct 主形状已在 planning 期读码，`[DONE]` 时序须实施前补全（Task M.1）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/routes/chat-completions/handler-v4.ts:355-357` `sawMessageStop: (state) => state.acc.finishReason !== ""` |
| ②terminatorConstructor | `finish_reason` 是上游原生字段直接透传；客户端可见的流终止符 `data: [DONE]` 由 handler **post-loop 合成**（`:628-657`，driver outcome resolve 之后补写） |
| ③interceptSite | driver 的 terminal drain 触发点（`sawMessageStop`真）插入检测；**`[DONE]` 合成逻辑须知道"续写中不该发"** |
| ④finalCompletionOwner | **待核实（M.1）**：`[DONE]` 合成点在 handler post-loop、driver 完成 resolve 之后才跑——续写多轮时只有最后一轮 resolve 后才应合成 `[DONE]`，须读该段完整代码确认协调机制 |

### CC via-responses（`openai-cc × /responses`，交叉场景）

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | 同 CC direct（客户端看 CC 帧），但**上游 wire 实际是 Responses**——触发判据须读 `ResponsesStreamAccumulator.status`（若能拿到）或 CC 层已翻译的 `finishReason`（若 `prepareWire` 已完成 Responses→CC 的响应翻译，判据可能已经是 CC 形状——**待核实**这层翻译发生在 driver 内部哪个阶段，是否早于 `sawMessageStop` 判断点） |
| ②-④ | **待核实（M.1）**——这是与 CC direct 共用 handler 代码但触发信号来源不同的变体，不能假设与 direct 完全同构 |

---

### Responses HTTP direct（`openai-responses × /responses`，`viaFallback=false`）

**状态：本表基于 planning 期调研，P3 实施前须实施者亲自复核；`incomplete_details.reason` 捕获缺口已知（见下）。**

| 要素 | 内容（标注核实来源） |
|---|---|
| ①accumulatorSite | `src/lib/openai/responses-stream-accumulator.ts` `ResponsesStreamAccumulator.status`（`case "response.incomplete"` 分支，`:126-130`填充）。**`incomplete_details.reason` 当前未被捕获**（accumulator 只存 `status`，不存 reason——已核实。此值属于 P0 的独立 terminal observer 需新增捕获的字段，非 P3 阶段才处理，见 `plan-0` 修订 + Task M.2 交叉确认） |
| ②terminatorConstructor | 待核实完整构造点（`handler-v4.ts:470-490` 只读到 `acc.status===""`兜底分支，正常 `max_tokens` 终止路径的构造代码位置待补） |
| ③interceptSite | 类似 Anthropic，driver 的 terminal drain 判断（`sawMessageStop`等价物）触发、frame 真正 flush 之前 |
| ④finalCompletionOwner | 待核实——续写自然终止对 Responses 是 `response.completed` |

### Responses fallback（`openai-responses × /chat/completions`，`viaFallback=true`，交叉场景）

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | 同 Responses direct（**同一个 buffered 调用共享同一 `runResponseBufferedSink` 实例**，`viaFallback` 只影响 fallback session 注册时机），但上游 wire 实际是 CC——触发判据须读 CC 的 `finish_reason=length`，非 Responses 的 `incomplete` |
| ②-④ | **待核实（M.1）**——与 direct 变体共用 handler 代码但触发信号来源不同，须显式区分测试 |

---

### Responses WS（`openai-responses × ws:/responses`）

**状态：仅骨架，姊妹 spec WS 续写传输时序依赖须先核实。**

| 要素 | 内容 |
|---|---|
| ①accumulatorSite | 同 Responses HTTP（共用 accumulator），但 `commitBoundaries` 故意省略（`ws.ts:376-396`，terminal-only 提交） |
| ②-④ | 待核实，且依赖姊妹 spec plan-4-7 Task 6.1/6.2 的落地状态（WS 续写=新上游轮重新派发，非同连接续帧） |

---

### 待核实：`openai-responses × /v1/messages`（reverse leg）

| 要素 | 内容 |
|---|---|
| 是否走 buffered | **未核实**——`pumpReverseAnthropicLegV4`（`responses/handler-v4.ts:576`）的函数体在 planning 期未完整读取，需 M.1 确认其调用 `runResponseSink` 还是 `runResponseBufferedSink`。**若走 `runResponseSink`（无缓冲）**，本 leg 天然不可挂载，标「本版本不支持，强制透传」，与 `openai-cc×/v1/messages`reverse 同构（CC reverse 已确认不用 buffered，Responses reverse 大概率同构但**不能凭类比下结论，必须读码确认**） |

---

## 不适用/不支持格的一句话结论 + producer oracle 目标

| leg | 结论 | producer oracle 目标（P3 须实现，钉死「确实透传、未被误挂载」） |
|---|---|---|
| `anthropic × /chat/completions`translate | 本版本不支持（无 buffered），强制透传 | `test("anthropic @cc translate leg: max_tokens passes through untouched, continuation never triggers")` |
| `anthropic × /responses`translate（HTTP+WS） | 同上 | 同构测试，HTTP+WS 各一条 |
| `openai-cc × /v1/messages`reverse | 本版本不支持（无 buffered，docstring 明文），强制透传 | `test("cc reverse @messages leg: max_tokens passes through untouched")` |
| `openai-responses × /v1/messages`reverse | 待核实后归类（若无 buffered 则同上） | 视核实结果定 |
| `gemini × *`（全部 3 格） | 不适用（N1，Gemini 入站排除，且已确认只走 `runResponseSink`） | `test("gemini inbound: max_tokens_continuation config is never consulted (N1 exclusion)")` |

---

## 矩阵收口任务

### Task M.1: 核实全部「待核实」格 + 补全四要素

- [ ] 实施者亲自读 `src/routes/chat-completions/handler-v4.ts` 的 `[DONE]` 合成完整时序（CC direct 行④）。
- [ ] 实施者亲自读 `src/routes/responses/handler-v4.ts` direct 路径的 `max_tokens`/`incomplete` 正常终止构造点（Responses direct 行②④）+ 核实 CC via-responses / Responses fallback 两个交叉场景的触发判据来源（哪一层完成了 Responses↔CC 的响应翻译，早于还是晚于 buffered 的 `sawMessageStop` 判断）。
- [ ] 实施者读 `responses/handler-v4.ts:576` 附近的 `pumpReverseAnthropicLegV4` 完整函数体，确认 Responses reverse leg 是否走 buffered（待核实项）。
- [ ] 实施者核实姊妹 spec Responses-WS 续写传输时序的实施状态（`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1/6.2）。
- [ ] 每个可挂载格核实后，写一个 producer-oracle 单测断言④要素（"唯一终局"不变量）；每个「不支持/不适用」格写对应的透传 producer oracle（上表已列目标）。
- [ ] **提交** → `docs(plan): fill terminal ownership matrix M (full leg enumeration verified)`。

**验收标准：** 5 个「可挂载」格（Anthropic direct、CC direct、CC via-responses、Responses direct、Responses fallback）+ 1 个「待核实」格（Responses reverse）的四要素全部落实到具体 file:line + producer-oracle 测试骨架；3 个「不支持」格 + 3 个「不适用」格的透传 oracle 全部写出。P3 才能开工。

### Task M.2: 与 P0 的 `incomplete_details.reason` 缺口交叉确认

- [ ] 核实 P0 Task 0.1（独立 terminal observer）与 Task 0.2（per-format 纯 predicate）的分工——`isResponsesMaxTokensTerminal` 本身是纯 predicate（接受 `status`+`incompleteReason` 两个参数），**不负责捕获**该值；捕获 `incomplete_details.reason` 是 Task 0.1 的 Responses observer 实现细节（因为 A/B/C 分型判定本身就需要这个值来触发 `isResponsesMaxTokensTerminal`，不能推迟到 P3——分型判定必须在 P0 就完整工作）。
- [ ] 与 `plan-3-cc-responses.md` 核对不重复实现——`incomplete_details.reason` 的捕获在 P0 阶段随 observer 一起建，P3 只消费已建好的字段，不重新实现捕获逻辑。
- [ ] **提交** → `docs(plan): cross-confirm incomplete_details.reason capture belongs to P0 observer, not P3`。
