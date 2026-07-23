# Plan-2: 续写 driver 状态机分支（承重②）

> **审查 Critical-2:** `driver.ts` `!committedAny` 硬门旁加平行分支;replay→append 语义;generation/coordinator 候选语义。
> **依赖:** P0（ledger、config、outcome）、P1（committed 已改为 Task 2.1 ledger 喂养）。
>
> **⚠️ 2026-07-22 用户裁决修订（ADR D1-D4，见 [ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md)）：**
> - **[D3 续写触发 gate]** 续写**只在**满足全部条件时触发：`committedAny` 且被掐 + `continuation.enabled` + 有 builder + 预算未耗 + **已提交前缀无任一「完整的、需客户端交互的 tool_use 块」**。已提交前缀含完整可交互 tool_use → **不续写、正常 partial-degrade/终止**（合法轮边界，客户端要执行工具接续对话）。判据数据源 = `ledger.snapshot()`（extractor 只收 text/tool_use，`server_tool_use` 等上游自执行的已被排除，故 ledger 里的 `tool_use` 即"需客户端交互"）。
> - **[D3 合成前缀]** 合成 assistant 轮 = `ledger.snapshot()`（已排除 thinking——上游拒 thinking 作前缀 + 签名毒化；text/完整 tool_use 可安全重放）。已完整 text/thinking 块**照发客户端但不发 message_stop**（不结束连接），直接接合成 user 续写轮。
> - **[D2 anchor 休眠]** keepalive 默认 `ping`，续写分支**不涉及 anchor**（P1 顺序 anchor 代码已休眠）。续写块 index 接续 = 从已提交块数接着编（无 anchor +1 偏移，因为 anchor 不再注入）。

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink`——加 committedAny 旁路续写分支 + D3 gate + 预算保底；ledger 喂养已在 Task 2.1 landed）
- Create: `src/lib/pipeline/continuation-executor.ts`（append 语义:构造续写 env、跑新 exchange、帧接同一 sink）
- Create: `src/lib/anthropic/continuation-builder.ts`（Anthropic per-format builder + `hasCompleteInteractiveToolUse` 判据；注册进 registry）
- Test: `tests/pipeline/continuation-retry.it.test.ts`（driver 级，已有 Task 2.1 ledger 测试，续加）

**Interfaces:**
- Consumes: `CommittedBlocksLedger`（P0/Task2.1）、`getContinuationBuilder`（P0）
- Produces: `runContinuation(deps, sink, ledger, budget): Promise<ResponseOutcome>`——被 driver 在 committedAny 且 continuation 可行且**无完整可交互 tool_use** 时调用

---

### Task 2.1: ledger 喂养（committed settle 点记录）

- [ ] **Step 1: 写失败测试** —— 每个 commit 边界把该块快照喂 ledger;partial 块不入账

```ts
// tests/pipeline/continuation-retry.it.test.ts
test("ledger records only committed blocks; a mid-block-cut partial block is NOT recorded", async () => {
  // 驱动 buffered sink：块@1 完整 commit → 块@2 partial(mid input_json_delta) 被 RST
  // 断言 ledger.snapshot() 只含块@1，不含块@2 partial
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线** —— `driver.ts` commit 边界处（:1211 `committedAny = true` 附近）把刚 flush 的块 canonical 快照 `ledger.recordCommitted(...)`。partial 块（未过 commitBoundaries）天然不喂。ledger 在 `onAttemptReset` **不清**（跨 attempt 累积）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(driver): feed committed blocks to ledger at commit boundary`。

### Task 2.2: committedAny 旁路续写分支

- [ ] **Step 1: 写失败测试** —— 首块后 RST + continuation.enabled → 走续写而非 partial-degrade

```ts
test("committedAny + continuation.enabled + budget: mid-stream RST triggers continuation, not partial-degrade", async () => {
  // mock 上游：块@1 commit → RST；断言 driver 调 runContinuation（新 exchange，非 partial-degrade）
  // 断言 outcome 非 "partial-degrade"（除非续写也耗尽 → "continuation-exhausted"）
})
test("continuation.enabled=false keeps legacy partial-degrade", async () => { /* R1 逐字不变 */ })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 改 `retryable`/`!committedAny` 硬门旁 + 加分支（含 D3 gate）**

```ts
// 旁加（不弱化 !committedAny for terminal-only R1）。D3: 已提交前缀含完整可交互 tool_use → 不续写。
const canContinue = committedAny
  && state.bufferedRetryContinuation.enabled
  && getContinuationBuilder(clientFormat) !== undefined
  && continuationBudgetRemaining > 0
  && !hasCompleteInteractiveToolUse(ledger.snapshot()) // D3: 完整可交互 tool_use = 合法轮边界，不续写
if (canContinue) return runContinuation(deps, sink, ledger, budget) // append 语义
// 否则维持现有：committedAny → partial-degrade / exhausted（含 D3「有 tool_use 则终止」路径）
```

其中 `hasCompleteInteractiveToolUse(blocks) = blocks.some(b => b.type === "tool_use")`——ledger 的 extractor 已排除 `server_tool_use`（上游自执行、无需客户端交互），故 ledger 里任一 `tool_use` 即需客户端交互。

- [ ] **Step 4: 跑，通过 + R1 回归**（terminal-only 路径 committedAny 恒 false，逐字不变）+ **D3 回归**（前缀含 tool_use → 不续写、走 partial-degrade）。
- [ ] **Step 5: 提交** → `feat(driver): committedAny-bypass continuation branch (D3-gated)`。

### Task 2.3: continuation-executor（append 语义 + 共享预算保底）

- [ ] **Step 1: 写失败测试** —— 续写用新 env(合成轮)跑新 exchange、帧接同一 sink、续写块 index 接续;共享预算保底 1 次

```ts
test("continuation runs a NEW exchange with synthetic turns, frames appended to same sink at continued indices", async () => { /* ... */ })
test("shared budget floors continuation at 1: pre-first-block retries cannot starve continuation to 0", async () => {
  // max_retries=3 且首块前已用 3 次 → 续写仍保底 1 次（spec §5.2 倾向 (a)）
})
test("committed prefix WITH a complete interactive tool_use → NO continuation (D3 turn boundary)", async () => { /* partial-degrade */ })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现 `continuation-executor.ts`** —— 用 `getContinuationBuilder(fmt)(originalEnv, ledger.snapshot(), config.message)` 构造续写上游请求（合成 assistant 前缀 = ledger 快照，已排除 thinking）;跑新 exchange（复用 transport/generation 但**新 candidate**，非 `runRecovery` 同-candidate 恢复——按 Critical-2 显式区分）;输出帧接续 index 写同一 sink（**index 接续 = 从已提交块数接着编，无 anchor +1 偏移**——D2 anchor 已休眠）;预算 = `max(remainingShared, continuationFloor=1)`。已完整块**不发 message_stop**、续写块接进同一连接。settle 点冻结 ledger 快照（persistence-async-invariants）。合成轮打 `synthetic:"continuation"`（进 upstreamRequest 轨、不污染上游原始轨）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): continuation-executor (append-semantics new exchange)`。

### Task 2.4: generation/coordinator 候选语义

- [ ] **Step 1: 写失败测试** —— 续写新 candidate 不破坏 hedged winner 选择

```ts
test("continuation opens a logically-continued candidate; selectGenerationWinner unaffected", async () => { /* ... */ })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线** generation binding —— 续写 candidate 标记为「延续」而非新竞争者;`selectGenerationWinner`/`bind` 语义显式处理（避免续写 candidate 与原 candidate 竞争）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(driver): continuation candidate semantics in generation coordinator`。

### P2 收口

- [ ] `test:fast` + `typecheck` 绿;`test:backend`（driver 集成）绿。
- [ ] History `attempts[]` 断言:每次续写一个 attempt、含合成轮 upstreamRequest（打标记）+ ledger 快照引用;上游原始轨无合成物。
