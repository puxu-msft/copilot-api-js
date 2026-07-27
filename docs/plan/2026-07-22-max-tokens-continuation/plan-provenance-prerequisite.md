# Plan-Provenance: synthetic `continuation` provenance marker（承重前置任务，非可选顺手项）

> **实施状态（2026-07-27）：已完成。** `OperationSyntheticKind`、`UpstreamRequestLeg.synthetic`、continuation-role dispatch 旁路标记、History V3 投影与真实持久化 readback oracle 均已落地；提交序列见各 Task。

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：原 README Global Constraints 只写「若姊妹未先落地则顺手解决」，未给具名 task/所有者/数据模型改动/producer-oracle——被审查指出这会产生"测试补 fixture/手工字段，真实 attempt 未标记"的假绿风险。本文件把它升级为**具名前置任务**，`plan-1-anthropic-continuation.md` 的 Task 1.4 显式依赖本文件的产出。

## 状态核查（本任务的第一步，非假设）

- [x] **Step 0：核查 backlog 是否已被姊妹机制 landed** —— 读 `docs/todo/2026-07-22-continuation-synthetic-provenance.md`（现有 backlog 条目）+ `git log --oneline -- src/lib/context/model-operation-record.ts` 确认 `OperationSyntheticKind` 是否已加 `"continuation"` 值；读 `src/lib/pipeline/driver.ts:1433-1438` 附近注释确认是否仍标注"尚未打标记"。
  - **若已 landed**（姊妹在本计划书写之后完成了这项）：引用精确 commit + 现有 producer test，跳过 Step 1-4，直接在 `plan-1-anthropic-continuation.md` Task 1.4 引用姊妹的实现。
  - **若未 landed**（本 planning 期核实的现状——`driver.ts:1437` 注释仍是"an observability gap tracked in docs/todo/..."）：继续 Step 1-4，本特性独立实现（因为本特性的 Task 1.4 History oracle 硬依赖这个标记，不能等姊妹不确定的时间表）。

> **本 planning 期核查结果（2026-07-23）**：`docs/todo/2026-07-22-continuation-synthetic-provenance.md` **仍是 backlog 状态**（未 landed）；`driver.ts:1437` 注释原文「an observability gap tracked in docs/todo/2026-07-22-continuation-synthetic-provenance.md (the continuation itself is correct)」确认未实现。**故本任务需要本特性独立实现，不能假设姊妹会先做。**

---

## 为什么这是本特性的前置任务，不是"顺手"

`plan-1-anthropic-continuation.md` Task 1.4 的 History oracle 要断言「`attempts[]` 含合成续写轮的 `upstreamRequest`（打 `synthetic:"continuation"`）」——这条断言若没有真实 provenance 实现，要么测试断言会失败（暴露计划的依赖缺口，好），要么实施者会走捷径在测试 fixture 里手工构造一个"看起来带标记"的假数据（掩盖真实缺失，坏——这正是审查警告的假绿模式）。**provenance 不是本特性的可选加分项，是 Task 1.4 验收链条上的必需一环。**

同时，本特性的续写与姊妹机制的续写是**两种不同触发路径**（success-path vs error-path）但**共用同一个 provenance 需求**（合成轮都需要标记）——若本特性独立实现，姊妹后续也可以直接复用本特性建立的 provenance 机制，两者收敛到同一套标记体系，不会产生"两套 continuation 各自发明一套 provenance"的分裂。

---

## 理想架构（沿用 backlog 条目已有的设计，本任务落地它）

**绝不**把 marker 写进真实 upstream body（会污染发给上游的字节）。加**旁路 provenance 元数据**：

### Task P.1: `OperationSyntheticKind` 加 `"continuation"` 值

- [x] **Step 1: 写失败测试** —— 类型层面接受新值。

```ts
test("OperationSyntheticKind accepts 'continuation'", () => {
  const kind: OperationSyntheticKind = "continuation" // 类型检查即测试
})
```

- [x] **Step 2-4:** 跑失败（类型不存在）→ 在 `src/lib/context/model-operation-record.ts` 的 `OperationSyntheticKind` union 加 `"continuation"` → 跑通过（typecheck 绿即测试通过，这是纯类型扩展）。
- [x] **Step 5: 提交** → `640813de feat(record): add continuation to OperationSyntheticKind`。

### Task P.2: `UpstreamRequestLeg` 加 provenance 槽位

- [x] **Step 1: 写失败测试** —— `UpstreamRequestLeg` 接受一个 provenance 字段（决策：加 `synthetic?: OperationSyntheticKind` 顶层字段，镜像 `SseEventRecord.synthetic` 的既有模式，非嵌套进 `extensions`——保持与项目里其他"合成物标记"字段的命名一致性，`SseEventRecord.synthetic?: OperationSyntheticKind` 已是先例）。

```ts
test("UpstreamRequestLeg accepts a synthetic provenance marker", () => {
  const leg: UpstreamRequestLeg = { format: "anthropic", synthetic: "continuation" }
})
```

- [x] **Step 2-4:** 跑失败 → 在 `src/lib/history/types.ts` 的 `UpstreamRequestLeg`（`:416-425`）加 `synthetic?: OperationSyntheticKind` 字段 → 跑通过。
- [x] **Step 5: 提交** → `44989a14 feat(history): add synthetic provenance to upstream requests`。

### Task P.3: driver 续写分支打标记（真实生产接线，非仅类型）

- [x] **Step 1: 写失败测试** —— 续写 exchange 的 dispatch 记录带 provenance，真实持久化读回验证（非手动 round-trip）。

```ts
test("a continuation dispatch's upstreamRequest carries synthetic:'continuation'; the upstream-original response track has NO such marker", async () => {
  // 走真实请求（复用姊妹 cut-path continuation 或本特性 max_tokens continuation 任一触发路径，二者共用同一套 provenance 机制）
  const entry = await getHistoryEntryFor(reqId)
  const continuationAttempt = entry.attempts.find(a => /* 识别续写 attempt 的判据，如 dispatchVerdict==="continued" 的 parent 或紧随其后的新 attempt */)
  expect(continuationAttempt?.upstreamRequest?.synthetic).toBe("continuation")
  expect(continuationAttempt?.upstreamResponse?.synthetic).toBeUndefined() // 上游原始轨绝不含合成物标记
})
```

- [x] **Step 2: 跑，失败。**
- [x] **Step 3: 实现** —— 在续写分支构造 `contEnv`/dispatch 记录的位置（姊妹 cut-path 在 `driver.ts:1439-1440` 附近 `const continuationBody = continuation.buildRequest(...)`；本特性 success-path 在 `plan-1` Task 1.2 的新分支），把 `env.ctx.setGenerationDispatchWireRequest(dispatch, { ...wireRequest })` 的调用点扩展为携带 provenance——**需要核实 `setGenerationDispatchWireRequest` 的 `WireRequest` 类型（`context/types.ts:63-69`）是否需要同步加 `synthetic` 字段**，还是 provenance 走单独的记录端口（如新增 `env.ctx.markGenerationDispatchSynthetic(dispatch, kind)` 方法，与 `setGenerationDispatchWireRequest` 分离，职责更单一）——**决策点，实施时定，倾向后者**（分离关注点：wire request 内容 vs provenance 标记是两回事，合并进一个签名会让调用方每次都要想"这次要不要传 synthetic"）。
- [x] **Step 4: 跑，通过。**
- [x] **Step 5: 提交** → `7499c502 feat(driver): tag continuation dispatch request provenance`。实现按计划倾向采用独立 `markGenerationDispatchSynthetic` 记录端口，并由 `CandidateRole:"continuation"` 自动覆盖当前 cut-path 与未来 success-path。

### Task P.4: History V3 projection 投影该字段

- [x] **Step 1: 写失败测试** —— `v3/projection.ts` 的 `recordToHistoryEntry` 把 `synthetic` 字段从内部记录投影到持久化 `HistoryEntry.attempts[].upstreamRequest.synthetic`。
- [x] **Step 2-4:** 跑失败 → 核实投影是否整体转发对象（若 `UpstreamRequestLeg` 整体转发，Task P.2 加的字段自动随行，无需 projection.ts 改动）还是逐字段 allowlist（若是，需显式加键）→ 据实处理 → 跑通过。
- [x] **Step 5: 提交** → `d60d1600 feat(history): project continuation provenance through V3`。核实结果为逐字段 allowlist，故显式投影该键。

### P.收口

- [x] `test:fast` + `typecheck` 绿；`test:backend` 绿。
- [x] **真实持久化 oracle 验收**（Task P.3 的测试）：走真实请求（既有姊妹 cut-path continuation 或本特性 max_tokens continuation），读 `getHistory()` 持久化 entry，确认 `synthetic:"continuation"` 标记真实存在，非测试 fixture 手工挂。
- [x] **关闭 backlog 条目**：更新 `docs/todo/2026-07-22-continuation-synthetic-provenance.md` 状态从"Backlog"改为"已解决"，引用本任务的提交序列。
