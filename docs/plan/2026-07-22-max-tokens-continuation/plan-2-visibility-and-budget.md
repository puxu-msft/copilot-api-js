# Plan-2: visibility 策略 + 组合矩阵校验 + 独立预算 + 双轨可观测性收口

> 依赖：P1（Anthropic direct A 类续写已落地，transparent 是默认已实现的路径）。
> 目标：把 P1 已实现的 `transparent` 之外，补齐 `passthrough`/`marker` 两个策略 + 配置层的组合矩阵强制校验（spec §6，两 reviewer 都点名的「协议约束、非自由组合」）；P2b/P2c 是 B/C 类的门后可选扩展，各自独立、可并行、可延后。

**Files：**
- Modify: `src/lib/pipeline/driver.ts`（`marker` 策略的 wire 层实现：缝合 + 注入可辨识标记，不抑制信号本身）
- Modify: `src/lib/config/validation.ts`（组合矩阵校验：`visibility:passthrough` + `classes.*:"continue"/"retry_with_budget"` 的拒绝/降级逻辑）
- Test: `tests/config/max-tokens-visibility-matrix.unit.test.ts`
- Test: `tests/e2e-client/max-tokens-marker-visibility.it.test.ts`

---

### Task 2.1: `visibility:passthrough` 的组合矩阵强制校验

> **spec §6 承重规则**：`passthrough` 定义 = 永不缝合、始终透传终止符；一旦 `message_stop`/`[DONE]`/`response.incomplete` 转给客户端，流已合法终止，**不能**在同连接续写。故 `passthrough` + `classes.*:"continue"/"retry_with_budget"` 是协议不可兼容组合，配置解析**必须显式拒绝或降级**，绝不静默吞掉用户的 `continue` 设置。

- [ ] **Step 1: 写失败测试** —— 配置校验层断言该组合被拒绝/降级 + 记录诊断信号。

```ts
// tests/config/max-tokens-visibility-matrix.unit.test.ts
test("visibility=passthrough + classes.text=continue: config validation warns and downgrades classes.text to passthrough", () => {
  const resolved = resolveEffectiveMaxTokensContinuation({ visibility: "passthrough", classes: { text: "continue", tool_use: "passthrough", thinking: "passthrough" } })
  expect(resolved.classes.text).toBe("passthrough") // 降级，非静默保留 continue
  expect(resolved.diagnostics).toContain("strategy-prevented-stitch")
})
test("visibility=transparent + classes.text=continue: allowed, no downgrade", () => {
  const resolved = resolveEffectiveMaxTokensContinuation({ visibility: "transparent", classes: { text: "continue", tool_use: "passthrough", thinking: "passthrough" } })
  expect(resolved.classes.text).toBe("continue")
})
test("visibility=marker + classes.thinking=retry_with_budget: allowed (marker permits same-stream continuation)", () => {
  const resolved = resolveEffectiveMaxTokensContinuation({ visibility: "marker", classes: { text: "passthrough", tool_use: "passthrough", thinking: "retry_with_budget" } })
  expect(resolved.classes.thinking).toBe("retry_with_budget")
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 新增 `resolveEffectiveMaxTokensContinuation(raw)` 函数（在 `resolveMaxTokensContinuation` 之上叠加组合校验层，或直接扩展该函数——**决策点**：若扩展原函数需确认不破坏 P0 Task 0.3 已有测试的期望值，若原测试断言的 defaults 本身不含 `passthrough`+`continue` 组合则不冲突，可直接扩展；否则新增包装函数，P1 Task 1.2 的 driver 消费点改读新函数）。降级逻辑：`visibility==="passthrough"` 时把 `classes.*` 中值为 `"continue"`/`"retry_with_budget"` 的强制改写为 `"passthrough"`，并在返回值上附带 `diagnostics: string[]` 数组含 `"strategy-prevented-stitch"` 标记（供上层 history/telemetry 记录，绝不只是 console.warn 一次——须落盘可查）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(config): visibility x class combination matrix validation (passthrough forces non-stitch)`。

### Task 2.2: `strategy-prevented-stitch` 落 history/telemetry（诚实配置语义，不静默）

- [ ] **Step 1: 写失败测试** —— 当降级发生时，该次请求的 history/telemetry 可见「本该续写但因 visibility=passthrough 被阻止」。

```ts
test("a request hitting the downgraded combination records strategy-prevented-stitch in pipelineInfo + telemetry", async () => {
  // 走真实请求，配置为该不兼容组合，断言 pipelineInfo.maxTokensContinuation 含某种「prevented」标记或 telemetry counter 命中
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `pipelineInfo.maxTokensContinuation` 加 `strategyPreventedStitch?: boolean` 字段（P0 Task 0.4 字段形状的补充——若 P0 阶段未预留，本 task 需要走一次「新增顶层字段三处必改」清单）+ telemetry 记一个 `class` 维度之外的独立 outcome 标记 → 跑通过。
- [ ] **Step 5: 提交** → `feat(observability): record strategy-prevented-stitch for the passthrough+continue downgrade`。

**说明（`passthrough` 策略无需独立实现）：** 由 Task 2.1 的组合矩阵校验可知，`visibility==="passthrough"` 会把所有 `classes.*` 强制降级为 `"passthrough"`——即该策略下续写从不触发，行为等价于 `enabled:false` 的 R1 默认路径。故 `passthrough` **不需要**额外的 wire 实现，Task 2.1 的校验层就是它的完整实现，此处不再单列 task。

### Task 2.3: `marker` 策略 wire 实现

- [ ] **Step 1: 写失败测试** —— 缝合 + 注入可辨识标记（不抑制信号本身语义，而是抑制真实终止符的同时插入标记文本/元数据，供用户知道"这里发生过续写"）。

```ts
// tests/e2e-client/max-tokens-marker-visibility.it.test.ts
test("visibility=marker: stitched stream includes a distinguishable marker AND ends in end_turn (not passthrough max_tokens)", async () => {
  // 真 SDK 消费，断言输出内容含可配置 marker 文本片段，且流仍是一条连续流（同 transparent 的抑制机制，只是多插入 marker）
})
test("marker text counts toward output_tokens usage (spec §4 marker-mode note)", async () => {
  // marker 策略下 marker 文本计入 output_tokens，与 transparent 的"无 marker 无双计费提示"区分
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（复用 Task 1.2/1.3 的抑制机制，`visibility==="marker"` 时额外在续写消息前/后插入一段可配置 marker 文本作为一个新的 text delta，跟踪进 usage）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): marker visibility mode for max_tokens continuation`。

### Task 2.4（可选，门 B PASS 后）: B 类续写扩展

> **依赖门 B PASS**（`plan-G-gates.md` 门 B）。若门 B FAIL，本 task 跳过，B 类永久透传，登记 backlog，**不阻塞其余任务**。

- [ ] **Step 1: 写失败测试** —— 悬挂 tool_use 丢弃后续写，断言语义等价性（非逐字节相同）。
- [ ] **Step 2-4:** 跑失败 → 实现（复用 Task 1.2 的截获分支，扩展 `classes.tool_use==="continue"` 时的判据——**注意 ADR D3 边界**：这里的 `continue` 只对**悬挂**（未闭合）tool_use 生效，已闭合 tool_use（B-closed）恒不续写，两者判据不同，不可混淆，Task 1.2 的实现已用 `truncationClass !== "tool_use_closed"` 显式排除）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): B-class (hanging tool_use) continuation, gated by door-B PASS`。

### Task 2.5（可选，门 C PASS 后）: C 类 `retry_with_budget` 扩展

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
- [ ] 组合矩阵校验的全部单元测试 + 三 visibility 策略的 SDK oracle 全绿。
- [ ] 若门 B/C 任一 FAIL，对应 Task 2.4/2.5 标注为「未实现，backlog」，不阻塞 P2 其余任务收口。
