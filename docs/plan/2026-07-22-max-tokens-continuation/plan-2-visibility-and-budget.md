# Plan-2: visibility 策略（marker 完整契约）+ 独立预算 + 双轨可观测性收口

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：
> 1. **组合矩阵校验已前移到 P0/P1**（`resolveEffectiveMaxTokensContinuation` 在 P0 Task 0.4 建好，P1 Task 1.2/1.5 首个可启用 commit 就消费）——本文件不再包含原 Task 2.1/2.2（这两个 task 的内容已并入 `plan-0-classifier-and-observability.md` Task 0.4 + `plan-1-anthropic-continuation.md` Task 1.2/1.5）。P2 现在只负责 `marker` 策略的**完整** wire 实现 + B/C 类门后扩展。
> 2. **marker 契约已统一**（据修订后 spec §4）：`marker` 与 `transparent` 一样抑制被替代的首轮 terminator，区别仅为在续写前注入一个可辨识且格式合法的 marker——不是「不抑制、只追加」。本文件的 Task 2.1（原 Task 2.3）据此重写，并补全 content/metadata/protocol 归属、usage 计数、history synthetic provenance、CC/Responses 格式映射四个此前缺失的维度。

> 依赖：P1（Anthropic direct A 类续写 + `transparent` 策略已落地，组合校验已在 P1 生效）。
> 目标：补齐 `marker` 策略的完整 wire 实现（**不是**独立于 transparent 的另一套机制，而是 transparent 的严格超集：抑制 + 注记）；B/C 类是门后可选扩展，各自独立、可并行、可延后。

**Files：**
- Modify: `src/lib/pipeline/driver.ts`（`marker` 策略：复用 Task 1.2/1.3 的抑制机制，额外注入 marker 帧）
- Modify: `src/lib/history/types.ts`（`marker` provenance 字段，若与 `MaxTokensContinuationDiag` 现有字段不够表达则补充）
- Test: `tests/e2e-client/max-tokens-marker-visibility.it.test.ts`
- Test: `tests/history/max-tokens-marker-provenance.it.test.ts`

---

### Task 2.1: `marker` 策略完整 wire 实现（统一契约：抑制 + 注记，非独立机制）

> **spec §4 已冻结的统一契约**：`marker` **与 transparent 一样抑制被替代的首轮 terminator**（不转发 `message_delta{max_tokens}`+`message_stop`），区别仅为在续写前注入一个可辨识且格式合法的 marker。这不是一个新的抑制路径——**是 Task 1.2/1.3 已实现的 transparent 抑制机制的直接复用**，marker 策略只是在抑制之后、续写内容之前，多插入一帧。

**marker 的四个此前缺失维度的明确决策：**

1. **marker 是什么形态（content text / metadata / protocol extension）**——决策：**content text**（作为一个新的 `text` content block 的 delta，格式合法、不使用协议扩展字段）。理由：protocol extension 需要客户端识别新字段才有意义，本项目无法保证下游客户端（Claude Code CLI、SDK 使用者）认识自定义扩展字段；metadata（如 HTTP header 或非标准 SSE 字段）不会呈现给最终用户看到的对话内容，违背"marker 是给想知道被截过的人看"的设计初衷。content text 保证任何标准客户端都能"看到"marker，代价是它会进入对话历史（下一轮上下文），这是 spec 已知的可接受的权衡（marker 面向的正是"愿意接受这点代价换取可见性"的用户）。
2. **usage 计数**——marker 文本计入 `output_tokens`（spec §4 已明确「marker 策略下 marker 文本计入 output_tokens」），与 `transparent` 的"无 marker 无双计费提示"形成对比（transparent 下 usage 只包含真实内容 token）。
3. **history synthetic provenance**——marker 帧本身在 forwarded 轨需要打 `synthetic` 标记（复用现有 `OperationSyntheticKind`，若无合适现有值则在 provenance 前置任务里为 `maxTokensContinuation` 场景新增一个变体，如 `"max-tokens-marker"`；不能不打标记——richest-data-flow 要求任何注入的合成帧可辨识）。upstream-original 轨绝不含 marker（它是 proxy 注入的，非上游产出）。
4. **CC/Responses 格式映射**——marker 在 CC 是一个 `choices[].delta.content` 的增量文本片段；在 Responses 是一个 `response.output_text.delta` 事件。P3 落地 CC/Responses 续写时，marker 策略须在各自格式上重新验证这个映射（不能假设 Anthropic 的 text delta 形态直接套用）——本 task 只负责 Anthropic，P3 对应 task 需要独立验收 marker 在 CC/Responses 上的格式合法性。

- [ ] **Step 1: 写失败测试** —— 断言 marker 策略下：首轮真实终止符被抑制（同 transparent）+ 额外注入的 marker 内容 + usage 计入 + provenance 标记。

```ts
// tests/e2e-client/max-tokens-marker-visibility.it.test.ts
test("visibility=marker: first-round max_tokens terminator is suppressed (identical to transparent), a distinguishable marker text is injected before the continuation content, stream ends in end_turn", async () => {
  // 真 SDK 消费，断言：
  //   - 首轮 message_delta{max_tokens}/message_stop 从未到达客户端（与 transparent 同）
  //   - .finalMessage() 含可配置 marker 文本片段（作为一个 text block 的一部分或独立 text block）
  //   - 最终 stop_reason=end_turn（非 max_tokens）
})
test("marker text counts toward output_tokens usage (distinguishing marker from transparent's silent sum)", async () => {
  // 断言 usage.output_tokens 包含 marker 文本的 token 数
})
test("marker frame carries a synthetic provenance marker in the forwarded track; upstream-original track has no marker", async () => {
  // 走真实持久化读回，断言 forwarded sseEvents 里 marker 帧的 synthetic 字段被标记；upstream-original 轨无此帧
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 复用 Task 1.2/1.3 的抑制机制（`visibility==="marker"` 走与 `"transparent"` 完全相同的抑制判据），唯一差异是在续写请求真正发出**之前**（或续写内容首帧之后，视用户体验决策——**建议放在续写内容之前**，即"这里发生过截断续写"的提示先于续写内容出现），额外通过 `sink.writeSynthetic` 或等价通道注入一个打了 provenance 标记的 text delta 帧；该帧的文本计入本轮的 usage 累加。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): marker visibility mode (unified contract: suppress + annotate, reusing transparent's interception)`。

### Task 2.2（可选，门 B PASS 后）: B 类续写扩展

> **依赖门 B PASS**（`plan-G-gates.md` 门 B，已修订为方法论冻结 + 观测分布 + 用户裁决阈值，非临时 `<20%`）。若门 B 观测结果不支持 opt-in（用户看到分布后拒绝），本 task 跳过，B 类永久透传，登记 backlog，**不阻塞其余任务**。

- [ ] **Step 1: 写失败测试** —— 悬挂 tool_use 丢弃后续写，断言语义等价性（复用门 B 冻结的等价 oracle，非临场发明新判据）。
- [ ] **Step 2-4:** 跑失败 → 实现（复用 Task 1.2 的截获分支，扩展 `classes.tool_use==="continue"` 时的判据——**注意 ADR D3 边界**：这里的 `continue` 只对**悬挂**（未闭合）tool_use 生效，已闭合 tool_use（B-closed）恒不续写，两者判据不同，不可混淆，Task 1.2 的实现已用 `truncationClass !== "tool_use_closed"` 显式排除）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): B-class (hanging tool_use) continuation, gated by door-B PASS + user-accepted divergence threshold`。

### Task 2.3（可选，门 C PASS 后）: C 类 `retry_with_budget` 扩展

> **依赖门 C PASS**。若门 C FAIL，本 task 跳过，C 类永久透传（分型 telemetry 已在 P0 独立记录，观测价值不受影响）。

- [ ] **Step 1: 写失败测试** —— thinking-only 截断，`retry_with_budget` 触发**重发**（非续写）。

```ts
test("C-class thinking-only max_tokens, retry_with_budget: re-dispatches the ORIGINAL request with raised max_tokens (not a continuation turn)", async () => {
  // 断言重发请求体 = 原始请求 + 抬高的 max_tokens，不含任何续写轮（无 assistant=committed prefix，无 user=continue message）
  // 断言重发结果的 visibility 策略同样生效（若 transparent，客户端只看到一次干净响应，不知道背后重发过）
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（这是**独立于续写截获分支**的另一条路径——重发是全新请求，非同连接缝合；`thinking_retry_budget` 配置值决定抬高到多少；visibility 策略仍决定客户端是否看到"重试过"的痕迹，但机制上更接近姊妹 spec 的"透明重试"而非"续写"）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): C-class retry_with_budget (re-dispatch, not continuation), gated by door-C PASS`。

### P2 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend` 绿。
- [ ] 三 visibility 策略（`transparent`/`passthrough`/`marker`）的 SDK oracle 全绿——`passthrough` 的验收已在 P1 组合校验测试里覆盖（`classes.*` 全降级，等价 R1），本阶段只需确认 `marker` 完整独立验收。
- [ ] 若门 B/C 任一 FAIL 或用户基于观测分布拒绝 opt-in，对应 Task 2.2/2.3 标注为「未实现，backlog」，不阻塞 P2 其余任务收口。
