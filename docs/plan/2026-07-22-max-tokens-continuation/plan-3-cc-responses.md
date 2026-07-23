# Plan-3: CC / Responses(HTTP) / Responses(WS) 接入

> 依赖：M（terminal ownership matrix 三格全部补全，Task M.1）+ P2（visibility/预算/组合校验层已跨格式共用）+ 各自 PoC 门（CC/Responses 悬挂判据门 E；Responses-WS 额外依赖姊妹 spec WS 续写传输时序落地状态）。
> **三格可并行**（各自只需按矩阵实现该格的截获点 + builder，共用 P2 的 visibility/预算层）。

**Files：**
- Create: `src/lib/codec/openai-cc/max-tokens-continuation-builder.ts`
- Create: `src/lib/codec/openai-responses/max-tokens-continuation-builder.ts`
- Modify: `src/routes/chat-completions/handler-v4.ts`（截获点接线，按 M 矩阵 CC 行）
- Modify: `src/routes/responses/handler-v4.ts`（截获点接线，按 M 矩阵 Responses-HTTP 行）
- Modify: `src/routes/responses/ws.ts`（若姊妹 WS 续写已落地，接入截获点；否则本任务阻塞，登记依赖）
- Test: `tests/openai/max-tokens-continuation-cc.it.test.ts`
- Test: `tests/responses/max-tokens-continuation-responses.it.test.ts`
- Test: `tests/responses/max-tokens-continuation-ws.it.test.ts`

---

## CC 子任务

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

---

## Responses HTTP 子任务

### Task 3.4: Responses continuation-builder

- [ ] **Step 1: 写失败测试** —— 组装 Responses `input` 续写请求（`[...原始, 已done的output_item, {role:user, content:message}]`）。
- [ ] **Step 2-4:** 跑失败 → 实现 + 注册 `registerContinuationBuilder("openai-responses", ...)` → 跑通过。
- [ ] **Step 5: 提交** → `feat(responses): max_tokens continuation-request builder`。

### Task 3.5: Responses `incomplete_details.reason` accumulator 补全（若 M.1 发现缺失）

> **条件任务**：仅当 M.1 核实发现 `ResponsesStreamAccumulator` 未捕获 `incomplete_details.reason` 时执行。若 M.1 核实该字段已被捕获（例如通过其他既有诊断路径），跳过本 task，直接在 Task 3.6 消费。

- [ ] **Step 1: 写失败测试** —— accumulator 捕获 `incomplete_details.reason`。
- [ ] **Step 2-4:** 跑失败 → 在 `src/lib/openai/responses-stream-accumulator.ts` 的 `case "response.incomplete"` 分支补充 `acc.incompleteReason = event.response.incomplete_details?.reason` → 跑通过。
- [ ] **Step 5: 提交** → `fix(responses): capture incomplete_details.reason in stream accumulator (prereq for max_tokens detection)`。

### Task 3.6: Responses 截获点（按 M 矩阵 Responses-HTTP 行）

- [ ] **Step 1: 写失败测试** —— 断言续写进行中不提前发 `response.incomplete`，最终以 `response.completed` 收尾（自然终止对 Responses 而言的语义）。
- [ ] **Step 2-4:** 跑失败 → 实现（按 M.1 核实到的确切构造点截获）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(responses): max_tokens continuation interception (HTTP direct)`。

### Task 3.7: Responses SDK oracle（双 SDK：官方 `openai` + `@ai-sdk/openai`）

- [ ] **Step 1: 写失败测试** —— 官方 SDK（较严格，`missing content` 会抛错，参考记忆 `responses-buffered-merge` 的教训）+ `@ai-sdk` （较宽容）都需测试，不能只测宽容的那个。
- [ ] **Step 2-4:** 跑失败 → 接线 → 跑通过。
- [ ] **Step 5: 提交** → `test(e2e): Responses max_tokens continuation SDK oracle (official + ai-sdk)`。

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

## P3 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend` 绿（含 CC/Responses 全部新测试）。
- [ ] CC/Responses-HTTP 两格必须完整落地（不依赖外部特性）；Responses-WS 视 Task 3.8 判定结果，可能是 backlog 状态收口。
- [ ] 三格（或两格 + 一个 backlog）的 `enabled:false` golden 字节等价验证。
- [ ] 门 E（CC/Responses 悬挂判据可靠性）若 FAIL，对应格式的 B 类判定退化为「只判 A/C」，在本文件对应 task 标注并登记 backlog，不影响 A 类收口。
