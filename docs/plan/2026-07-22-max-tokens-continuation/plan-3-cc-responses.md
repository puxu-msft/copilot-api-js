# Plan-3: CC / Responses(HTTP+fallback) / Responses(WS) 接入

> **修订记录（2026-07-23，据 GPT plan-review 全 leg 枚举意见修订）**：M 矩阵已从 4 个直连格扩展为全 leg 枚举——本文件新增 CC via-responses、Responses fallback 两个交叉场景 task（原方案只测 direct 变体，遗漏了这两个"共用 handler 代码但触发信号来源不同"的变体）。原 Task 3.5（`incomplete_details.reason` accumulator）已按 M.2 交叉确认**移至 P0**（`plan-0-classifier-and-observability.md` Task 0.2b）——分型判定本身需要这个值，不能推迟到 P3 才处理，本文件保留一个占位提示避免实施者重复实现。
>
> **修订记录二（2026-07-23，据 GPT plan-review round-2 修订）**：round-2 审查坐实 P0 只做了 Anthropic observer（分档决策，见 `plan-0-classifier-and-observability.md` 顶部）——本文件**新增 Task 3.0a（CC observer）+ Task 3.0b（Responses observer）**作为 CC/Responses 续写落地前的显式前置内容，把 P0 的 `TerminalObserverState`/`classifyMaxTokensTruncation` 格式无关基础设施，在本阶段真正建出 CC/Responses 各自的更新函数 + candidate state 挂点 + 反例测试 + 生产接线。**这两个 task 是 Task 3.1/3.2 等的硬依赖**（没有 observer，CC/Responses 的分型判定无从谈起，A/B/B-closed/C 四分型对三格式都要生效，非 Anthropic-only 限定）。
>
> **本 planning 期已亲自核实的 candidate state 挂点（据此设计 Task 3.0a/3.0b，非猜测）**：
> - **CC direct**：`src/routes/chat-completions/handler-v4.ts` 的 `createChatCandidateResponseSession`（约 `:326-360`），非 reverse 分支的 `createState: () => ({ acc: createOpenAIStreamAccumulator(), diag, bytesIn, eventsIn })`；`onRenderedFrame` 钩子里已有 `accumulateOpenAIStreamEvent(JSON.parse(frame.data), state.acc)`（`:340-347` 附近）——observer 更新应挂在这个已有的 `onRenderedFrame` 回调内，紧随 `accumulateOpenAIStreamEvent` 之后，读同一个已解析的 `ChatCompletionChunk` 事件。`OpenAIStreamAccumulator`（`src/lib/openai/stream-accumulator.ts:23-45`）已有 `toolCallMap: Map<number, ToolCallAccumulator>`（无 closed 标记，只有 `id/name/argumentParts`）+ `finishReason`——observer 的"最后块是否闭合"判据不能直接读 `toolCallMap`（其本身不含闭合状态），需要旁路补充判据（见 Task 3.0a 实现细节）。
> - **Responses（HTTP+WS 共用）**：`src/routes/responses/candidate-response-session.ts` 的 `createState: () => ({ acc: createResponsesStreamAccumulator(), diag, bytesIn, eventsIn, bufferedMerge })`（`:107-114`）；`onRenderedFrame` 钩子里已有 `accumulateResponsesStreamEvent(event, state.acc)`（`:121` 附近）——observer 更新同理挂在此处。`ResponsesStreamAccumulator`（`src/lib/openai/responses-stream-accumulator.ts:23-55`）的 `toolCallMap: Map<number, ToolCallAccumulator>` + `finalizedOutputIndexes: Set<number>`——**`finalizedOutputIndexes` 是"闭合"判据的现成来源**（一个 `output_index` 进了这个 set 就代表该 item 已终结，无论是 `function_call_arguments.done` 还是 `output_item.done` 触发的）。

> 依赖：M（terminal ownership matrix 全部相关格补全，Task M.1，含 CC direct/via-responses、Responses direct/fallback、Responses reverse **已确定不走 buffered**）+ P0（`incomplete_details.reason` 已在 P0 捕获；Anthropic observer 已建立同一套 `TerminalObserverState`/`classifyMaxTokensTruncation` 供本阶段复用）+ P1/P2（visibility/预算/组合校验层已跨格式共用）+ 各自 PoC 门（CC/Responses 悬挂判据门 E；Responses-WS 额外依赖姊妹 spec WS 续写传输时序落地状态）。
> **CC direct / CC via-responses / Responses direct / Responses fallback 四个可挂载场景 + WS 可并行**（各自只需按矩阵实现该格的截获点 + builder，共用 P1/P2 的 visibility/预算层）；**Task 3.0a/3.0b（observer 落地）是本文件所有其余 task 的前置，必须先做**。

**Files：**
- Modify: `src/lib/pipeline/max-tokens-terminal-observer.ts`（P0 已建 Anthropic-only 文件，本阶段追加 `updateCcTerminalObserver`/`updateResponsesTerminalObserver`）
- Modify: `src/routes/chat-completions/handler-v4.ts`（Task 3.0a：observer 挂入 `createChatCandidateResponseSession` 的 `onRenderedFrame`；Task 3.2 起：截获点接线）
- Modify: `src/routes/responses/candidate-response-session.ts`（Task 3.0b：observer 挂入 `createState`/`onRenderedFrame`）
- Modify: `src/routes/responses/handler-v4.ts`（截获点接线，按 M 矩阵 Responses-HTTP/fallback 行）
- Create: `src/lib/codec/openai-cc/max-tokens-continuation-builder.ts`
- Create: `src/lib/codec/openai-responses/max-tokens-continuation-builder.ts`
- Modify: `src/routes/responses/ws.ts`（若姊妹 WS 续写已落地，接入截获点；否则本任务阻塞，登记依赖）
- Test: `tests/pipeline/max-tokens-terminal-observer.unit.test.ts`（追加 CC/Responses 反例集，同 Anthropic 文件）
- Test: `tests/openai/max-tokens-continuation-cc.it.test.ts`
- Test: `tests/responses/max-tokens-continuation-responses.it.test.ts`
- Test: `tests/responses/max-tokens-continuation-ws.it.test.ts`

---

## Observer 落地子任务（本文件其余 task 的硬依赖）

### Task 3.0a: CC terminal observer + candidate state 挂点 + 生产接线

- [ ] **Step 1: 写失败测试** —— CC 版本的 A/B/B-closed 反例（CC 无 thinking 概念，C 类对 CC 天然不适用——GHC CC 端点不透出 reasoning 作为独立块，故 CC observer 只需覆盖 text/tool_use 两种 kind，比 Anthropic 少一维）。

```ts
// tests/pipeline/max-tokens-terminal-observer.unit.test.ts（追加）
test("CC: text delta then cut before finish_reason -> lastBlockKind=text, closed=false", () => {
  const obs = createTerminalObserver()
  updateCcTerminalObserver(obs, { choices: [{ delta: { content: "partial" }, finish_reason: null }] })
  expect(obs.lastBlockKind).toBe("text")
  expect(obs.lastBlockClosed).toBe(false)
})
test("CC: tool_call opened (delta.tool_calls[0] with id+name), arguments streaming, cut before finish_reason -> lastBlockKind=tool_use, closed=false (hanging)", () => {
  const obs = createTerminalObserver()
  updateCcTerminalObserver(obs, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_x" } }] }, finish_reason: null }] })
  updateCcTerminalObserver(obs, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] }, finish_reason: null }] })
  expect(obs.lastBlockKind).toBe("tool_use")
  expect(obs.lastBlockClosed).toBe(false)
})
test("CC: tool_call fully streamed AND finish_reason=tool_calls arrives before max_tokens cut is impossible in the same turn (B-closed via finish_reason=length is the real corner) -> a NEXT tool_call opened after the first closed, then cut -> lastBlockKind=tool_use for the LATEST one", () => {
  // CC 没有显式 content_block_stop；一个 tool_call 的"闭合"判据 = 出现了更高 index 的下一个 tool_call（G4 已证严格串行）或 finish_reason 到达。
  // 若 finish_reason=length 到达时最后一个 tool_call 仍在流式（无下一个更高 index 出现）-> closed=false（悬挂，B 类）。
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— `updateCcTerminalObserver(state, chunk: ChatCompletionChunk)` 读 `choices[0].delta`：`delta.content` 存在 → `lastBlockKind="text"`, `lastBlockClosed=false`（CC text 只有在 `finish_reason` 到达时才"闭合"，因为 CC 没有块级 stop 事件）；`delta.tool_calls` 存在且新 index 出现 → `lastBlockKind="tool_use"`, `lastBlockClosed=false`（若这不是首次出现的 index，说明前一个 index 的 tool_call 已经"完成"——即闭合判据 = G4 证实的严格串行特性：更高 index 出现即前块完成，`closed` 应回填到前一个块，但 observer 只关心"最后"一块，故只需在检测到新 index 时把 state 重置为新 kind/未闭合，无需回填历史）；`choices[0].finish_reason` 非空 → 若 `finishReason==="length"`（即本次是 max_tokens 撞线）此时最后记录的 kind 就是分型输入，`lastBlockClosed` 视该 kind 在到达 `finish_reason` 前是否已被下一个 index 掩盖决定（tool_use 情形：`finish_reason` 到达本身**不算**闭合信号——闭合只能来自"下一个块出现"，这与 Anthropic 的显式 `content_block_stop` 语义不同，是 CC 格式特有的角落，本 task 须显式测试锁定这个差异）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(cc): CC terminal observer (text/tool_use only, no thinking concept)`。

### Task 3.0a-wire: CC observer 挂入 candidate state（真实生产接线）

- [ ] **Step 1: 写失败测试** —— 端到端：真实 CC handler 流程产生 observer 快照，读 history 持久化验证。

```ts
test("CC direct: observer snapshot reaches history via recordMaxTokensTruncation when finish_reason=length", async () => {
  // 走真实 CC handler 流程，mock 上游产出 text 撞 max_tokens（finish_reason=length）
  // 断言 getHistory() 读回 truncationClass === "text"
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/routes/chat-completions/handler-v4.ts` 的 `createChatCandidateResponseSession` 非 reverse 分支的 `createState`/`onRenderedFrame` 里新增 `terminalObserver: createTerminalObserver()` 状态字段 + 在既有 `accumulateOpenAIStreamEvent` 调用后追加 `updateCcTerminalObserver(state.terminalObserver, chunk)`；在 handler 的正常 terminal 判断点（`isCcMaxTokensTerminal(acc.finishReason)` 为真时）读 `state.terminalObserver` + `classifyMaxTokensTruncation` + 调用 `env.ctx.recordMaxTokensTruncation(...)`（复用 P0 Task 0.5 已建的记录端口，非重新发明）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(handler): wire CC terminal observer to production terminal call site`。

### Task 3.0b: Responses terminal observer + candidate state 挂点 + 生产接线

- [ ] **Step 1: 写失败测试** —— Responses 版本的 A/B/B-closed/C 反例（Responses **有** reasoning/thinking 概念，`output_item` 类型含 `reasoning`——C 类对 Responses 适用，需要覆盖）。

```ts
test("Responses: text output_text.delta then cut before output_item.done -> lastBlockKind=text, closed=false", () => {
  const obs = createTerminalObserver()
  updateResponsesTerminalObserver(obs, { type: "response.output_text.delta", output_index: 0 }, /* finalizedOutputIndexes snapshot */ new Set())
  expect(obs.lastBlockKind).toBe("text")
  expect(obs.lastBlockClosed).toBe(false)
})
test("Responses: function_call arguments streaming, cut before output_item.done or function_call_arguments.done -> lastBlockKind=tool_use, closed=false (hanging)", () => {
  // 用 finalizedOutputIndexes（accumulator 已有字段）判闭合——未进入该 set 即未闭合
})
test("Responses: reasoning item opened after a committed text item, cut mid-reasoning -> lastBlockKind=thinking (NOT text) — the exact ledger-would-misclassify analog for Responses", () => {
  // Responses 侧的"最后块是 reasoning"判据 —— 对应 Anthropic thinking-after-text 反例
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— `updateResponsesTerminalObserver(state, event: ResponsesStreamEvent, finalizedOutputIndexes: ReadonlySet<number>)` 读事件的 `output_index` + `type`（`response.output_text.delta`→text、`response.function_call_arguments.delta`→tool_use、`response.reasoning_summary_text.delta`或等价 reasoning 事件→thinking——**须核实 Responses 实际的 reasoning delta 事件类型名**，不臆测）；闭合判据直接查 `finalizedOutputIndexes.has(output_index)`（accumulator 已维护的字段，无需重新实现闭合逻辑，只需读取）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(responses): Responses terminal observer (text/tool_use/thinking via finalizedOutputIndexes)`。

### Task 3.0b-wire: Responses observer 挂入 candidate state（真实生产接线，HTTP+WS 共用）

- [ ] **Step 1: 写失败测试** —— 同 Task 3.0a-wire 模式，Responses 版本，HTTP + WS 各一条。
- [ ] **Step 2-4:** 跑失败 → 在 `src/routes/responses/candidate-response-session.ts` 的 `createState`/`onRenderedFrame`（HTTP+WS 共用同一份代码，`:107-130` 附近）新增 `terminalObserver` 状态字段 + 更新调用；在 `src/routes/responses/handler-v4.ts` 的正常 terminal 判断点接线 → 跑通过。
- [ ] **Step 5: 提交** → `feat(handler): wire Responses terminal observer to production terminal call sites (HTTP+WS)`。

---

## CC 子任务（消费 Task 3.0a 的 observer）

### Task 3.1: CC continuation-builder

- [ ] **Step 1: 写失败测试** —— 组装 CC `messages` 续写请求（复用姊妹 CC builder 的既有模式，若姊妹 P5 已实现则直接 `registerContinuationBuilder("openai-cc", ...)` 复用同一 registry；若姊妹尚未实现 CC builder，本特性需要独立实现，但**必须复用同一个 `ContinuationRequestBuilder` 接口签名**，不新造第二套接口）。
- [ ] **Step 2-4:** 跑失败 → 实现 + 注册 → 跑通过。
- [ ] **Step 5: 提交** → `feat(cc): max_tokens continuation-request builder`。

### Task 3.2: CC 截获点（按 M 矩阵 CC 行④要素）

- [ ] **Step 1: 写失败测试** —— 断言续写进行中 `[DONE]` 不提前发出（M.1 已定的 producer-oracle 目标）。

```ts
test("CC: continuation in progress does not emit [DONE] until the final resolve", async () => {
  // 复用 M 矩阵核实到的 handler [DONE] 合成时序，断言驱动
})
test("CC: finish_reason=length terminal drain interception mirrors Anthropic (transparent default)", async () => {
  // finish_reason 被抑制，最终 finish_reason=stop，[DONE] 只发一次
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（对齐 Anthropic 的截获思路，但截获点、终局构造点均按 M 矩阵 CC 行——若 M.1 发现 `[DONE]` 合成时序有额外复杂度，本 task 据实处理，不能想当然复制 Anthropic 分支）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(cc): max_tokens continuation interception (terminal drain, transparent default)`。

### Task 3.3: CC SDK oracle

- [ ] **Step 1: 写失败测试** —— 真 `openai` SDK 消费缝合流。
- [ ] **Step 2-4:** 跑失败 → 接线 → 跑通过。
- [ ] **Step 5: 提交** → `test(e2e): CC max_tokens continuation SDK oracle`。

### Task 3.3b: CC via-responses 交叉场景（M 矩阵新增行，原方案遗漏）

> **依赖 M.1 核实结果**——`openai-cc × /responses` 是一个"客户端看 CC 帧、上游 wire 实际是 Responses"的交叉场景，触发判据须读 Responses 的 `incomplete`（转译回 CC `finish_reason=length`），不能假设它与 CC direct 完全同构。

- [ ] **Step 1: 写失败测试** —— 构造 CC 客户端请求实际路由到 `/responses`（via-responses leg）撞 `max_output_tokens` 的场景，断言触发判据正确读取（无论翻译发生在 driver 内哪一层，最终 CC 客户端看到的续写行为应与 direct 一致）。
- [ ] **Step 2-4:** 跑失败 → 实现（若 Task M.1 核实翻译层已经把 Responses 状态转成 CC 形状且早于 `sawMessageStop` 判断点，则本变体可直接复用 Task 3.2 的截获逻辑；若翻译发生更晚，需要额外适配层）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(cc): max_tokens continuation for the via-responses cross-scenario leg`。

---

## Responses HTTP 子任务（消费 Task 3.0b 的 observer）

### Task 3.4: Responses continuation-builder

- [ ] **Step 1: 写失败测试** —— 组装 Responses `input` 续写请求（`[...原始, 已done的output_item, {role:user, content:message}]`）。
- [ ] **Step 2-4:** 跑失败 → 实现 + 注册 `registerContinuationBuilder("openai-responses", ...)` → 跑通过。
- [ ] **Step 5: 提交** → `feat(responses): max_tokens continuation-request builder`。

### Task 3.5: `incomplete_details.reason` 依赖确认（已移至 P0，本 task 只是占位提示）

> **修订记录**：原方案在此处实现 accumulator 字段捕获——**已按 M.2 交叉确认移至 P0**（`plan-0-classifier-and-observability.md` Task 0.2b），因为 A/B/C 分型判定本身需要这个值才能工作，不能推迟到 P3。本 task 仅在此确认 P0 的实现已就绪，不重复实现。

- [ ] 核实 `src/lib/openai/responses-stream-accumulator.ts` 的 `ResponsesStreamAccumulator.incompleteReason` 字段已由 P0 Task 0.2b 落地（`git log` 确认对应提交存在）。若发现 P0 未完成此项（不应该发生，但作为防御性检查），暂停本 task、回退到 P0 补完。
- [ ] **提交**（若无需修改，可跳过提交，仅在实施记录里标注核实通过）。

### Task 3.6: Responses direct 截获点（按 M 矩阵 Responses-HTTP 行）

- [ ] **Step 1: 写失败测试** —— 断言续写进行中不提前发 `response.incomplete`，最终以 `response.completed` 收尾（自然终止对 Responses 而言的语义）。
- [ ] **Step 2-4:** 跑失败 → 实现（按 M.1 核实到的确切构造点截获）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(responses): max_tokens continuation interception (HTTP direct)`。

### Task 3.7: Responses SDK oracle（双 SDK：官方 `openai` + `@ai-sdk/openai`）

- [ ] **Step 1: 写失败测试** —— 官方 SDK（较严格，`missing content` 会抛错，参考记忆 `responses-buffered-merge` 的教训）+ `@ai-sdk` （较宽容）都需测试，不能只测宽容的那个。
- [ ] **Step 2-4:** 跑失败 → 接线 → 跑通过。
- [ ] **Step 5: 提交** → `test(e2e): Responses max_tokens continuation SDK oracle (official + ai-sdk)`。

### Task 3.7b: Responses fallback 交叉场景（M 矩阵新增行，原方案遗漏）

> **依赖 M.1 核实结果**——`openai-responses × /chat/completions`（`viaFallback=true`）与 direct 变体共用同一个 `runResponseBufferedSink` 调用（`viaFallback` 只影响 fallback session 注册时机），但上游 wire 实际是 CC，触发判据须读 CC 的 `finish_reason=length`，非 Responses 的 `incomplete`。

- [ ] **Step 1: 写失败测试** —— 构造走 fallback 的 Responses 客户端请求撞 `max_tokens`（上游实际是 CC wire），断言触发判据正确识别（CC `finish_reason=length`）且续写行为与 direct 变体一致（客户端仍看 Responses 形状的响应）。
- [ ] **Step 2-4:** 跑失败 → 实现 → 跑通过。
- [ ] **Step 5: 提交** → `feat(responses): max_tokens continuation for the fallback cross-scenario leg`。

---

## Responses WS 子任务

> **前置依赖核实（M.1 已列，此处重申为阻塞条件）**：本组子任务依赖姊妹 spec `docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-4-7-remaining.md` Task 6.1（WS 块级）/6.2（WS 续写传输时序）的落地状态。**若姊妹尚未落地，本组子任务标记为阻塞、登记 backlog，不阻塞 CC/Responses-HTTP 的收口**——这是一处明确的跨特性依赖边界，不由本 planner 越权替姊妹 spec 做实现决策。

### Task 3.8: 依赖状态核实

- [ ] 核实姊妹 plan-4-7 Task 6.1/6.2 的 git 提交状态（是否已合并 master）。
- [ ] **若已落地**：核实其 WS 块级谓词 + 续写传输时序的确切接口，本特性直接复用其挂载点，转 Task 3.9。
- [ ] **若未落地**：登记 `docs/todo/` backlog 条目「max_tokens Responses-WS 续写依赖姊妹 WS 续写传输时序未决」，本组子任务到此为止，不继续 3.9-3.11。

### Task 3.9: Responses WS continuation builder 复用

- [ ] （仅在 3.8 判定"已落地"时执行）复用 Task 3.4 的 builder（同一 registry，`openai-responses` 格式不分 HTTP/WS）。

### Task 3.10: WS 截获点（按 M 矩阵 Responses-WS 行，复用姊妹传输时序）

- [ ] **Step 1: 写失败测试** —— WS 续写 = 新上游 turn 结果接同一 WS 下行流（复用姊妹已定的语义，非在同一 HTTP response 帧序列里缝合）。
- [ ] **Step 2-4:** 跑失败 → 实现 → 跑通过。
- [ ] **Step 5: 提交** → `feat(ws): max_tokens continuation via re-dispatched upstream turn (reuses sibling WS transport timing)`。

### Task 3.11: WS SDK/客户端 oracle

- [ ] **Step 1: 写失败测试** —— WS 客户端消费缝合流。
- [ ] **Step 2-4:** 跑失败 → 接线 → 跑通过。
- [ ] **Step 5: 提交** → `test(e2e): Responses WS max_tokens continuation oracle`。

---

## Reverse leg 透传确认（已定论，非待核实）

> **修订记录（2026-07-23，据 GPT plan-review round-2 修订）**：round-2 亲自核实 `src/routes/responses/handler-v4.ts:576-645` 的 `pumpReverseAnthropicLegV4` 完整函数体——`:585` 明确调用 `driver.runResponseSink(upstream, env, sink)`（非 `runResponseBufferedSink`）。**`openai-responses × /v1/messages`reverse 格已确定归类为"本版本不支持 continuation"，非"待核实"**——`plan-M-terminal-ownership-matrix.md` 已同步更正。本 task 只需补一条透传 producer oracle，不存在"若核实为走 buffered 需回补 Task 3.12"的分支（该分支已被证伪，删除）。

### Task 3.12: `openai-responses × /v1/messages`reverse 透传 producer oracle

- [ ] **Step 1: 写失败测试** —— 断言该 leg 上 max_tokens 终止逐字节透传，`max_tokens_continuation` 配置从不被读取/生效。

```ts
test("Responses reverse (@messages) leg: max_tokens passes through untouched via runResponseSink; max_tokens_continuation config is never consulted", async () => {
  // 走真实 reverse leg 请求（upstream 是 Anthropic，客户端看 Responses 形状），mock 上游产出 stop_reason=max_tokens
  // 即便配置 max_tokens_continuation.enabled=true，断言输出逐字节等于 enabled:false 时的行为（无续写介入）
})
```

- [ ] **Step 2-4:** 跑失败（或已通过，若当前代码天然满足——因为 `pumpReverseAnthropicLegV4` 根本不读任何 `maxTokensContinuation` opts）→ 确认/补充 → 跑通过。
- [ ] **Step 5: 提交** → `test(responses): reverse @messages leg passthrough producer oracle (confirmed non-buffered, no continuation possible)`。

---

## P3 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend` 绿（含 CC/Responses 全部新测试，含 via-responses/fallback 交叉场景 + Task 3.0a/3.0b 的 observer 落地）。
- [ ] **必须完整落地（不依赖外部特性）**：CC direct、CC via-responses、Responses direct、Responses fallback 四格 + 各自的 observer（Task 3.0a/3.0b）。**视依赖状态收口**：Responses-WS（Task 3.8 判定）。
- [ ] **`openai-responses × /v1/messages`reverse 格已确定归类为"本版本不支持"**（Task 3.12 透传 producer oracle 已覆盖，非待核实项）。
- [ ] 五格（或四格 + 一个 backlog）的 `enabled:false` golden 字节等价验证。
- [ ] 门 E（CC/Responses 悬挂判据可靠性）若 FAIL，对应格式的 B 类判定退化为「只判 A/C」，在本文件对应 task 标注并登记 backlog，不影响 A 类收口。
