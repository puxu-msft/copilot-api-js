# Plan-2: 续写 driver 状态机分支（承重②）

> **审查 Critical-2:** `driver.ts:1283` `!committedAny` 硬门旁加平行分支;replay→append 语义;generation/coordinator 候选语义。
> **依赖:** P0（ledger、config、outcome）、P1（续写块 index 接续）。

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` :980-1339——加 committedAny 旁路续写分支 + ledger 喂养 + 预算保底）
- Create: `src/lib/pipeline/continuation-executor.ts`（append 语义:构造续写 env、跑新 exchange、帧接同一 sink）
- Test: `tests/pipeline/continuation-retry.it.test.ts`（driver 级）

**Interfaces:**
- Consumes: `CommittedBlocksLedger`（P0）、`getContinuationBuilder`（P0）、`AnchorIndexAllocator`（P1）
- Produces: `runContinuation(deps, sink, ledger, budget): Promise<ResponseOutcome>`——被 driver 在 committedAny 且 continuation 可行时调用

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
- [ ] **Step 3: 改 `driver.ts:1283` 门 + 加分支**

```ts
// 旁加（不弱化 !committedAny for terminal-only R1）：
const canContinue = committedAny
  && state.bufferedRetryContinuation.enabled
  && getContinuationBuilder(clientFormat) !== undefined
  && continuationBudgetRemaining > 0
if (canContinue) return runContinuation(deps, sink, ledger, budget) // append 语义
// 否则维持现有：committedAny → partial-degrade / exhausted
```

- [ ] **Step 4: 跑，通过 + R1 回归**（terminal-only 路径 committedAny 恒 false，逐字不变）。
- [ ] **Step 5: 提交** → `feat(driver): committedAny-bypass continuation branch`。

### Task 2.3: continuation-executor（append 语义 + 共享预算保底）

- [ ] **Step 1: 写失败测试** —— 续写用新 env(合成轮)跑新 exchange、帧接同一 sink、续写块 index 接续;共享预算保底 1 次

```ts
test("continuation runs a NEW exchange with synthetic turns, frames appended to same sink at continued indices", async () => { /* ... */ })
test("shared budget floors continuation at 1: pre-first-block retries cannot starve continuation to 0", async () => {
  // max_retries=3 且首块前已用 3 次 → 续写仍保底 1 次（spec §5.2 倾向 (a)）
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现 `continuation-executor.ts`** —— 用 `getContinuationBuilder(fmt)(originalEnv, ledger.snapshot(), config.message)` 构造续写上游请求;跑新 exchange（复用 transport/generation 但**新 candidate**，非 `runRecovery` 同-candidate 恢复——按 Critical-2 显式区分）;输出帧经 P1 分配器接续 index 写同一 sink;预算 = `max(remainingShared, continuationFloor=1)`。settle 点冻结 ledger 快照（persistence-async-invariants）。合成轮打 `synthetic:"continuation"`（进 upstreamRequest 轨、不污染上游原始轨）。
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
