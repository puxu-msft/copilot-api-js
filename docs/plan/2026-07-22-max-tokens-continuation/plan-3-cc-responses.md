# Plan-3: CC / Responses(HTTP+fallback) / Responses(WS) 接入

> **修订记录（2026-07-23，据 GPT plan-review 全 leg 枚举意见修订）**：M 矩阵已从 4 个直连格扩展为全 leg 枚举——本文件新增 CC via-responses、Responses fallback 两个交叉场景 task（原方案只测 direct 变体，遗漏了这两个"共用 handler 代码但触发信号来源不同"的变体）。原 Task 3.5（`incomplete_details.reason` accumulator）已按 M.2 交叉确认**移至 P0**（`plan-0-classifier-and-observability.md` Task 0.2b）——分型判定本身需要这个值，不能推迟到 P3 才处理，本文件保留一个占位提示避免实施者重复实现。
>
> 依赖：M（terminal ownership matrix 全部相关格补全，Task M.1，含 CC direct/via-responses、Responses direct/fallback、Responses reverse 待核实格）+ P0（`incomplete_details.reason` 已在 P0 捕获）+ P1/P2（visibility/预算/组合校验层已跨格式共用）+ 各自 PoC 门（CC/Responses 悬挂判据门 E；Responses-WS 额外依赖姊妹 spec WS 续写传输时序落地状态）。
> **CC direct / CC via-responses / Responses direct / Responses fallback 四个可挂载场景 + WS 可并行**（各自只需按矩阵实现该格的截获点 + builder，共用 P1/P2 的 visibility/预算层）。

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

### Task 3.3b: CC via-responses 交叉场景（M 矩阵新增行，原方案遗漏）

> **依赖 M.1 核实结果**——`openai-cc × /responses` 是一个"客户端看 CC 帧、上游 wire 实际是 Responses"的交叉场景，触发判据须读 Responses 的 `incomplete`（转译回 CC `finish_reason=length`），不能假设它与 CC direct 完全同构。

- [ ] **Step 1: 写失败测试** —— 构造 CC 客户端请求实际路由到 `/responses`（via-responses leg）撞 `max_output_tokens` 的场景，断言触发判据正确读取（无论翻译发生在 driver 内哪一层，最终 CC 客户端看到的续写行为应与 direct 一致）。
- [ ] **Step 2-4:** 跑失败 → 实现（若 Task M.1 核实翻译层已经把 Responses 状态转成 CC 形状且早于 `sawMessageStop` 判断点，则本变体可直接复用 Task 3.2 的截获逻辑；若翻译发生更晚，需要额外适配层）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(cc): max_tokens continuation for the via-responses cross-scenario leg`。

---

## Responses HTTP 子任务

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

## P3 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend` 绿（含 CC/Responses 全部新测试，含 via-responses/fallback 交叉场景）。
- [ ] **必须完整落地（不依赖外部特性）**：CC direct、CC via-responses、Responses direct、Responses fallback 四格。**视依赖状态收口**：Responses-WS（Task 3.8 判定）。
- [ ] **`openai-responses × /v1/messages`reverse 格的核实结论**（M.1 待核实项）须在此收口前有明确归类——若核实为"不走 buffered"，补一条透传 producer oracle（M 矩阵已列目标）；若核实为"走 buffered"，需要补充实现（本文件当前未预留对应 task，若核实结果是"走 buffered"，须回补一个 Task 3.12，不可静默忽略）。
- [ ] 五格（或四格 + 一个 backlog）的 `enabled:false` golden 字节等价验证。
- [ ] 门 E（CC/Responses 悬挂判据可靠性）若 FAIL，对应格式的 B 类判定退化为「只判 A/C」，在本文件对应 task 标注并登记 backlog，不影响 A 类收口。
