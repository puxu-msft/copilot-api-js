# Plan-1: Anthropic direct A 类续写（成功终止截获，新增实现）

> 依赖：P0（分型判定器 + config schema）+ M（Anthropic 格已在 planning 期确认，实施前重新核对 `driver.ts:1336` 附近代码是否漂移）+ 门 D（transparent 缝合被 SDK 接受）+ 门 A（text-only 前缀续写，max_tokens 场景）。
> 目标：默认 `enabled:false` 时零行为变更；opt-in 后 A 类（text 已闭合截断）自动续写到自然终止，客户端默认看到干净的 `end_turn`（transparent 缝合），后端 history 忠实记录真实每轮终止。

**Files：**
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` 的 terminal drain 分支内插入 max_tokens 截获——**新代码路径，不是修改 cut-path 续写分支**）
- Modify: `src/routes/messages/handler-v4.ts`（生产接线：把 `resolveMaxTokensContinuation("anthropic")` 传给 driver opts；沿用已有的 `committedBlocksLedger`/`extractCommittedBlocks`/`continuation` builder 接线模式，新增一组 `maxTokensContinuation` 专属 opts）
- Test: `tests/pipeline/max-tokens-continuation-anthropic.it.test.ts`（driver 级，sequenced-transport 仿姊妹 `continuation-flow.it.test.ts`）
- Test: `tests/e2e-client/max-tokens-continuation-sdk.it.test.ts`（SDK oracle，仿姊妹 `continuation-sdk.it.test.ts`）

**Interfaces：**
- Consumes: `TruncationClass`/`classifyMaxTokensTruncation`（P0）、`resolveMaxTokensContinuation`（P0）、`CommittedBlocksLedger`/`getContinuationBuilder("anthropic")`/`coordinator.runContinuation`/`continued` verdict（**全部复用姊妹，不重新定义**）
- Produces: driver 内新的 `canContinueMaxTokens` 判据 + 对应触发分支；`pipelineInfo.maxTokensContinuation` 的真实 populate 点

---

### Task 1.1: settle/finalize 时序契约决策（承重架构项，必须先于任何代码）

> **这是 spec §5.1 标注的「承重架构设计项，非核实项」**——post-success 续写在 `message_stop` 已到达后启新 exchange，会撞 settle-freeze 不变量。姊妹机制是 cut-path（`!drained`，从未到达 settle 点），本特性是 success-path（`drained && sawMessageStop()` 已为真，若不介入会立即走向 settle）——**settle 时点不同，不能假设姊妹的时序契约直接适用**。

- [ ] **Step 1: 读透 settle 触发链** —— 精确定位「什么代码路径在 `drained && sawMessageStop()` 为真之后、多久会调用 `ctx.complete()`/`recordGenerationLogicalTerminal`」。核实：`driver.ts:1336-1358` 的 terminal drain 只是 driver 内部的 flush + `notifyBufferedResolve` + `return {kind:"complete"}`；真正的 `ctx.complete()` 调用在 **handler** 层（`src/routes/messages/handler-v4.ts:1442` `env.ctx.complete(buildAnthropicResponseData(acc, model))`），发生在 driver 的 `runResponseBufferedSink` **返回之后**。
- [ ] **Step 2: 决策时序方案** —— 因为 `ctx.complete()` 在 handler 层、driver 返回之后才调用，**本特性的截获点在 driver 内部（terminal drain 分支），天然早于 settle**——只要截获逻辑在 driver 返回 `{kind:"complete"}` **之前**判断"这是 max_tokens 且应续写"并转而继续 driver 内部的 `for(;;)` 循环（不 return），settle 就根本不会被触发（因为 handler 侧的 `env.ctx.complete()` 依赖 driver 返回 `outcome.kind==="complete"`，只要 driver 不返回、继续循环，`ctx.complete()` 无从调用）。**这与姊妹 cut-path 的处理时序同构**（姊妹也是在 driver 内部循环 `continue`，不返回给 handler）。
- [ ] **Step 3: 显式记录决策** —— 写入本文件与 README 冻结契约：**「settle 不推迟、不做已 settle 补记协议——因为driver 循环内部 `continue` 天然阻止了 settle 触发，这是`for(;;)`循环结构本身提供的时序保证，非新设计」**。若续写循环最终真正结束（自然终止或预算耗尽），driver 才 `return {kind:"complete"|"stream-error"}`，handler 才调用一次 `ctx.complete()`/`ctx.fail()`——与现有 R1 路径完全同构，无需新的 settle 协议。
- [ ] **Step 4: 反例排查（写测试钉死这个假设）** —— 断言"driver 在 max_tokens 截获后继续循环时，`ctx.complete()` 未被调用"，及"只有循环真正终止后才调用一次"。

```ts
// tests/pipeline/max-tokens-continuation-anthropic.it.test.ts
test("driver internal loop continues past a max_tokens terminal drain when continuation is enabled — handler-level ctx.complete() is NOT invoked until the loop truly ends", async () => {
  // 用 spy 包装 env.ctx.complete，断言在续写期间未被调用，只在最终 outcome 后调用一次
})
```

- [ ] **Step 5: 提交** → `docs(plan): settle/finalize timing decision for max_tokens continuation (driver-loop-continue, no new settle protocol)`。**本 task 只是决策 + 钉死测试，不含实际截获实现**（Task 1.2 才实现）。

### Task 1.2: driver 内 terminal drain 截获分支（新增实现，核心）

- [ ] **Step 1: 写失败测试** —— 首轮干净终止于 `max_tokens` + A 类（text 已闭合）+ `enabled:true` → 续写而非透传。

```ts
test("A-class max_tokens terminal drain: continuation enabled + text closed -> continues instead of flushing max_tokens to client", async () => {
  // mock 上游：块@1 text 完整 commit → message_delta{stop_reason:max_tokens} + message_stop（干净终止，非 RST）
  // 断言：driver 未把这次 message_delta/message_stop flush 给客户端 sink；转而构造续写请求、跑新 exchange
})
test("max_tokens_continuation.enabled=false: byte-identical passthrough (R1)", async () => {
  // 同样的 max_tokens 干净终止，但 enabled=false → 逐字节透传 message_delta{max_tokens}+message_stop，无续写
})
test("B-closed (complete interactive tool_use before max_tokens) -> no continuation, passthrough (ADR D3 reuse)", async () => {
  // 复用姊妹 hasCompleteInteractiveToolUse 判据，断言即便 enabled:true 也不续写
})
test("budget exhausted after max_rounds -> passthrough the final real max_tokens terminator (honest fallback, spec §4)", async () => {
  // 续写 max_rounds 次仍撞 max_tokens -> 最后一次正常 flush 透传（藏不掉兜底）
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 在 `driver.ts:1336` 判断为真（`drained && sawMessageStop()`）之后、`:1348` 实际 flush 之前，插入：

```ts
// 新分支，与 cut-path 的 canContinue（:1415-1423）平行但独立——判据完全不同（success path, not error path）
const maxTokensConfig = opts.maxTokensContinuation // 新增 opt，P1 handler 接线传入
const lastBlock = /* 读 candidateOpts 累积器或 ledger 最后一块状态 */
const truncationClass = maxTokensConfig && candidateOpts.sawMessageStop?.() && stopReasonIsMaxTokens
  ? classifyMaxTokensTruncation({ lastBlockType: lastBlock?.type, lastBlockClosed: lastBlock?.closed })
  : undefined
const canContinueMaxTokens =
  truncationClass !== undefined
  && maxTokensConfig?.enabled
  && maxTokensConfig.classes[truncationClass === "tool_use_closed" ? "tool_use" : truncationClass] === "continue"
  && truncationClass !== "tool_use_closed" // ADR D3: 完整 interactive tool_use 恒不续，即便 classes.tool_use 配了 continue（该配置项只对悬挂 tool_use 生效，§6 注释已言明）
  && maxTokensRoundsRemaining > 0
  && getContinuationBuilder(clientFormat) !== undefined
if (canContinueMaxTokens) {
  // 记录真实首轮 stop_reason 到 perRoundStopReason（后端忠实，§9），但不 flush 给客户端
  // 构造续写请求（复用姊妹 continuation builder + coordinator.runContinuation）
  // continue 循环（不 return），不触发 handler 侧 ctx.complete()
}
// 否则走既有 :1348 flush（byte-identical，R1）
```

  **关键实现纪律（对照姊妹 plan-2b 教训清单，逐条核）：**
  - **C3 同构风险**：续写块的 wire-index offset 必须是「已上线到客户端的块计数」，不是 ledger 长度（姊妹已验证这个 bug 会静默损坏、不抛错）。本特性复用姊妹已有的 offset 计数器（`wireDeliveredBlocks`），不重新发明。
  - **C4 同构风险**：生产接线（handler 传 `maxTokensContinuation` opts 给 driver）是独立必需步骤，不能假设"接口存在=已接线"——Task 1.5 显式验证。
  - **message_start dedup**：续写 exchange 产生的第二个 `message_start` 必须丢弃（复用姊妹 `continuation.isMessageStart` 判据）。
  - **首轮 message_stop 不发**：与姊妹「已完整块照发但不发 message_stop」的处理一致——本特性额外要求连 `message_delta` 本身也不发（因为姊妹场景 message_delta 从未产出，本特性场景它已产出但要抑制，这是**新增的抑制逻辑**，不能照搬姊妹「无需抑制因为没发生」的假设）。

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(driver): max_tokens success-path continuation interception (Anthropic direct)`。

### Task 1.3: visibility=transparent wire 抑制（terminal ownership matrix Anthropic 格的③要素落地）

- [ ] **Step 1: 写失败测试** —— SDK oracle：客户端最终只看到一条干净流，`stop_reason=end_turn`，无 `max_tokens` 痕迹。

```ts
// tests/e2e-client/max-tokens-continuation-sdk.it.test.ts
test("visibility=transparent: SDK sees ONE coherent stream ending in end_turn, max_tokens terminator suppressed", async () => {
  // 真 @anthropic-ai/sdk 消费缝合流；.finalMessage() 断言单一 message_start、连续 index、stop_reason=end_turn、无重复
})
test("usage.output_tokens monotonic across the stitched stream, final value = sum of both rounds", async () => {
  // 断言 SDK 不因 output_tokens > 原始 max_tokens 抛错或异常
})
```

- [ ] **Step 2-4:** 跑失败 → 实现 usage 累积/单调性处理（每轮真实 usage 求和，非取首轮或末轮单值）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(pipeline): transparent visibility wire stitching for max_tokens continuation`。

### Task 1.4: 后端忠实记录（`perRoundStopReason`/`clientVisibleStopReason`/`suppressedMaxTokens`）

- [ ] **Step 1: 写失败测试（独立 oracle，不靠客户端 wire 自证——skill `verifying-authoritative-claims`）** —— 直接读持久化 history entry，断言即便客户端看到 `end_turn`，后端记录仍完整保留真实的首轮 `max_tokens`。

```ts
test("history perRoundStopReason includes the suppressed max_tokens; clientVisibleStopReason is end_turn; both coexist", async () => {
  // 走真实 http 流程（非手动挂字段），读 getHistory() 持久化 entry
  const entry = await getHistoryEntryFor(reqId)
  expect(entry.pipelineInfo.maxTokensContinuation.perRoundStopReason).toEqual(["max_tokens", "end_turn"])
  expect(entry.pipelineInfo.maxTokensContinuation.clientVisibleStopReason).toBe("end_turn")
  expect(entry.pipelineInfo.maxTokensContinuation.suppressedMaxTokens).toBe(true)
  // attempts[] 含合成续写轮的 upstreamRequest（打 synthetic:"continuation"）+ 真实 upstreamResponse（无合成物）
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（Task 1.2 截获点记录每轮真实 stopReason 到累积数组，最终 populate `pipelineInfo.maxTokensContinuation`；复用 P0 Task 0.4 的字段骨架和 `recordMaxTokensContinuation` 方法真正调用）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(history): faithful backend recording for max_tokens continuation (perRoundStopReason + clientVisibleStopReason)`。

**警示（对照记忆 `settle 冻结 history entry`）：** 本 task 的字段必须在 `ctx.complete()` **调用之前**完成 record（settle 冻结 entry 快照），不能依赖 settle 之后的 mutation——Task 1.1 已确认续写循环内 `ctx.complete()` 延后到循环真正结束才调用，故 record 时点在循环内部持续累积（每轮 flush 前 append 到累积数组），最终一次性随 `ctx.complete()` 的 `buildAnthropicResponseData` 一起提交，符合「settle 前 record」纪律。

### Task 1.5: handler 生产接线（C4 同构风险，独立必需步骤）

- [ ] **Step 1: 写失败测试** —— 端到端验证 opts 真正从 handler 传到 driver，未接线时续写不触发（即便 driver 内部逻辑正确，未接线=死代码）。

```ts
test("production wiring: handler passes resolveMaxTokensContinuation('anthropic') to driver opts; unwired path never continues", async () => {
  // 对照 handler-v4.ts 当前 opts 组装，断言 maxTokensContinuation 键存在且值来自 resolveMaxTokensContinuation
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/routes/messages/handler-v4.ts` 组装 `runResponseBufferedSink` opts 处（`:1203` 附近，与既有 `committedBlocksLedger`/`continuation` 接线相邻）新增：
```ts
maxTokensContinuation: {
  ...resolveMaxTokensContinuation("anthropic"),
  classifyTruncation: classifyMaxTokensTruncation,
},
```
→ 跑通过。
- [ ] **Step 5: 提交** → `feat(handler): wire max_tokens_continuation config into Anthropic buffered path (production wiring)`。

### P1 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend`（driver + handler 集成）绿。
- [ ] **R1 golden 验证**：`enabled:false` 时四种截断分型的 max_tokens 透传逐字节等价于现状（跑既有 golden 测试套件，确认未破坏任何既有断言）。
- [ ] **连跑确定性**：涉及 terminal 截获时序的测试连跑 10-25 次（FakeClock + 持 ReadableStream controller 精确控帧）。
- [ ] History oracle 独立验收（Task 1.4 的真实持久化读回，非手动 round-trip）。
