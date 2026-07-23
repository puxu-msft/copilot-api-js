# Plan-1: Anthropic direct A 类续写（成功终止截获，新增实现）

> **修订记录（2026-07-23，据 GPT plan-review [major] 修订）**：
> 1. Task 1.1 的 settle 时序测试拆分为两个独立 oracle（driver integration + handler/in-process），因为 `runResponseBufferedSink` 本身从不调用 `ctx.complete()`——只驱动 driver 级测试断言"handler 未被调用"是假绿，真正的调用点在 handler 层。
> 2. visibility×class 非法组合校验（`resolveEffectiveMaxTokensContinuation`，P0 Task 0.4 已建好）**必须是 P1 首个可启用 commit 就消费**，不得留到 P2——否则 P1 落地到 P2 之间的窗口期，用户配置 `passthrough+continue` 会让 driver 在已透传终止符后又发续写帧，破坏协议。
> 3. Task 1.2 的分型判定输入源改为 P0 的独立 terminal observer（`TerminalObserverState`），不再是原方案的裸 ledger 最后块（该方案已被认定为 blocker 并在 spec/plan-0 修正）。

> 依赖：P0（独立 terminal observer + 分型判定器 + config schema + **组合校验函数** `resolveEffectiveMaxTokensContinuation`）+ M（Anthropic 格已在 planning 期确认，实施前重新核对 `driver.ts:1336` 附近代码是否漂移）+ **provenance 前置任务**（见 `plan-provenance-prerequisite.md`，本计划 Task 1.4 依赖其产出）+ 门 D（transparent 缝合被 SDK 接受）+ 门 A（text-only 前缀续写，max_tokens 场景）。
> 目标：默认 `enabled:false` 时零行为变更；opt-in 后 A 类（text 已闭合截断）自动续写到自然终止，客户端默认看到干净的 `end_turn`（transparent 缝合），后端 history 忠实记录真实每轮终止；**任何 commit 落地时刻，非法组合配置都不可能产生协议错误**（组合校验从第一个可启用 commit 就生效）。

**Files：**
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` 的 terminal drain 分支内插入 max_tokens 截获——**新代码路径，不是修改 cut-path 续写分支**）
- Modify: `src/routes/messages/handler-v4.ts`（生产接线：把 `resolveEffectiveMaxTokensContinuation("anthropic")` 传给 driver opts，读 Task 0.1 的 observer 而非 ledger）
- Test: `tests/pipeline/max-tokens-continuation-anthropic.it.test.ts`（driver 级，sequenced-transport 仿姊妹 `continuation-flow.it.test.ts`）
- Test: `tests/routes/messages/max-tokens-continuation-settle-timing.it.test.ts`（handler/in-process 级，settle 时序独立 oracle，**新增文件，与 driver 级测试分开**）
- Test: `tests/e2e-client/max-tokens-continuation-sdk.it.test.ts`（SDK oracle，仿姊妹 `continuation-sdk.it.test.ts`）

**Interfaces：**
- Consumes: `TruncationClass`/`classifyMaxTokensTruncation`/`TerminalObserverState`/`updateAnthropicTerminalObserver`（P0 独立 observer，**不是 ledger**）、`resolveEffectiveMaxTokensContinuation`（P0，已含组合校验）、`getContinuationBuilder("anthropic")`/`coordinator.runContinuation`/`continued` verdict（**全部复用姊妹，不重新定义**）、synthetic provenance marker（前置任务产出）
- Produces: driver 内新的 `canContinueMaxTokens` 判据 + 对应触发分支；`pipelineInfo.maxTokensContinuation` 的真实 populate 点（P0 已建骨架，本阶段驱动多轮/抑制的真实值）

---

### Task 1.1a: 驱动 oracle 一——driver-integration（首轮不 flush + 派发续写 + driver 未返回）

> **拆分说明**：这一层只证明 driver 内部控制流正确——`runResponseBufferedSink` 在 max_tokens 截获后**不 return**、继续循环、构造并派发续写请求。它**不能**证明 `ctx.complete()` 的调用次数（driver 从不直接调用它），试图在这层 spy `ctx.complete()` 会因为从未被调用而产生假绿（无论实现对错，这层测试里它都不会被调）。

- [ ] **Step 1: 写失败测试** —— 断言 driver 内部行为，不涉及 handler/ctx。

```ts
// tests/pipeline/max-tokens-continuation-anthropic.it.test.ts
test("driver-integration: A-class max_tokens terminal drain does NOT flush to the sink; a continuation exchange is dispatched; the internal for(;;) loop does not return", async () => {
  // mock 上游：块@1 text 完整 commit -> message_delta{stop_reason:max_tokens} + message_stop（干净终止）
  // 用 spy 包装 transport.send（driver 依赖），断言：
  //   (a) 首轮的 message_delta/message_stop 帧从未到达 sink.write
  //   (b) transport.send 被调用第二次（续写请求已派发）
  //   (c) runResponseBufferedSink 尚未 resolve（仍在 pending，用 Promise.race против 一个短 timeout 断言未决）
})
test("driver-integration: enabled=false -> byte-identical passthrough, loop returns immediately after first terminal (R1)", async () => {
  // 同样的 max_tokens 干净终止，但 enabled=false -> transport.send 只调用一次，sink 收到完整首轮帧
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现骨架**（本 task 只搭 driver 内部判据框架，完整实现在 Task 1.2）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `test(pipeline): driver-integration oracle for max_tokens continuation internal loop control flow`。

### Task 1.1b: 驱动 oracle 二——handler/in-process（`ctx.complete()`/history terminal 只在末 leg 后一次）

> **拆分说明**：这一层跑**真实 HTTP 请求**（走 handler，非直接调用 driver），才能验证 `ctx.complete()`/`recordGenerationLogicalTerminal`（在 `handler-v4.ts:1442` 调用）确实只在续写循环真正结束后触发一次，且 parent dispatch 结算为 `continued`（非 `failed`/`discarded`），final dispatch 结算为 `committed`。

- [ ] **Step 1: 写失败测试** —— in-process 真实请求（`serveInProcess` harness，仿姊妹 `continuation-sdk.it.test.ts`）。

```ts
// tests/routes/messages/max-tokens-continuation-settle-timing.it.test.ts
test("handler/in-process: ctx.complete() / history terminal fires exactly ONCE, only after the continuation loop truly ends; parent dispatch verdict=continued, final dispatch verdict=committed", async () => {
  // 真实 in-process HTTP 请求，mock 上游脚本：首轮 max_tokens 干净终止 -> 续写轮 end_turn 干净终止
  // 断言：
  //   - ctx.complete 只被调用一次（spy 或读 history 只有一条 entry、非两条）
  //   - 读 model operation record：parent dispatch.verdict === "continued"、final dispatch.verdict === "committed"
  //   - history entry 的 client-facing 结局只有一个（非"先 complete 又 fail"之类的双重结算）
})
```

- [ ] **Step 2-4:** 跑失败 → 无需额外实现（本 task 验证 Task 1.1a 骨架 + Task 1.2 完整实现共同产生的行为，实现在 Task 1.2 完成，本 task 的测试通过标志 Task 1.2 也已完成——**故本 task 的 Step 2-4 实际上在 Task 1.2 之后才跑绿，先写在这里作为 Task 1.2 的验收断言之一**）→ 跑通过。
- [ ] **Step 5: 提交**（与 Task 1.2 同一提交或紧随其后）→ `test(handler): settle-timing oracle confirms ctx.complete() fires once, parent=continued final=committed`。

### Task 1.2: driver 内 terminal drain 截获分支（新增实现，核心，含组合校验前移）

- [ ] **Step 1: 写失败测试** —— 首轮干净终止于 `max_tokens` + A 类（text 已闭合）+ `enabled:true` → 续写而非透传；**新增**非法组合测试（`passthrough`+`continue` 降级生效）。

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
test("visibility=passthrough + classes.text=continue (illegal combination): downgraded to passthrough at THIS first commit — no protocol violation possible even mid-rollout", async () => {
  // 配置该非法组合，断言 driver 消费的是 resolveEffectiveMaxTokensContinuation 的降级结果（classes.text=passthrough），
  // 而非原始配置的 continue —— 即便本 commit 是"首次启用"，也不可能出现"已终止流后又续写"的协议错误
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 在 `driver.ts:1336` 判断为真（`drained && sawMessageStop()`）之后、`:1348` 实际 flush 之前，插入：

```ts
// 新分支，与 cut-path 的 canContinue（:1415-1423）平行但独立——判据完全不同（success path, not error path）
// maxTokensConfig 已经过 P0 的 resolveEffectiveMaxTokensContinuation 组合校验（passthrough+continue 已被降级），
// driver 侧不需要重复校验组合合法性，只需信任传入值。
const maxTokensConfig = opts.maxTokensContinuation // 新增 opt，Task 1.5 handler 接线传入（已是 effective config）
const observerSnapshot = opts.maxTokensTerminalObserver?.() // 读 P0 独立 observer，非 ledger
const truncationClass = maxTokensConfig && candidateOpts.sawMessageStop?.() && stopReasonIsMaxTokens
  ? classifyMaxTokensTruncation(observerSnapshot)
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
  // 打 synthetic:"continuation" provenance（前置任务产出，见 plan-provenance-prerequisite.md）
  // continue 循环（不 return），不触发 handler 侧 ctx.complete()
}
// 否则走既有 :1348 flush（byte-identical，R1）
```

  **关键实现纪律（对照姊妹 plan-2b 教训清单，逐条核）：**
  - **C3 同构风险**：续写块的 wire-index offset 必须是「已上线到客户端的块计数」，不是 ledger 长度（姊妹已验证这个 bug 会静默损坏、不抛错）。本特性复用姊妹已有的 offset 计数器（`wireDeliveredBlocks`），不重新发明。
  - **C4 同构风险**：生产接线（handler 传 `maxTokensContinuation` opts 给 driver）是独立必需步骤，不能假设"接口存在=已接线"——Task 1.5 显式验证。
  - **message_start dedup**：续写 exchange 产生的第二个 `message_start` 必须丢弃（复用姊妹 `continuation.isMessageStart` 判据）。
  - **首轮 message_stop 不发**：与姊妹「已完整块照发但不发 message_stop」的处理一致——本特性额外要求连 `message_delta` 本身也不发（因为姊妹场景 message_delta 从未产出，本特性场景它已产出但要抑制，这是**新增的抑制逻辑**，不能照搬姊妹「无需抑制因为没发生」的假设）。
  - **组合校验前移**（本次修订新增）：`maxTokensConfig` 在进入 driver 之前已经过 `resolveEffectiveMaxTokensContinuation` 处理，driver 本身不重复做 `visibility==="passthrough"` 的降级判断——这是 handler 接线层（Task 1.5）的职责，driver 只信任传入的 effective config。

- [ ] **Step 4: 跑，通过（含 Task 1.1b 的 handler/in-process 测试此时也应转绿）。**
- [ ] **Step 5: 提交** → `feat(driver): max_tokens success-path continuation interception (Anthropic direct, combination-validated from first commit)`。

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

> **依赖 provenance 前置任务**（`plan-provenance-prerequisite.md`）——本 task 断言 `attempts[]` 含真实 `synthetic:"continuation"` 标记，若前置任务未完成，本测试的该项断言必然失败（这是设计内的依赖顺序，非本 task 缺陷）。

- [ ] **Step 1: 写失败测试（独立 oracle，不靠客户端 wire 自证——skill `verifying-authoritative-claims`）** —— 直接读持久化 history entry，断言即便客户端看到 `end_turn`，后端记录仍完整保留真实的首轮 `max_tokens`。

```ts
test("history perRoundStopReason includes the suppressed max_tokens; clientVisibleStopReason is end_turn; both coexist; attempts[] carries real synthetic:continuation provenance", async () => {
  // 走真实 http 流程（非手动挂字段），读 getHistory() 持久化 entry
  const entry = await getHistoryEntryFor(reqId)
  expect(entry.pipelineInfo.maxTokensContinuation.perRoundStopReason).toEqual(["max_tokens", "end_turn"])
  expect(entry.pipelineInfo.maxTokensContinuation.clientVisibleStopReason).toBe("end_turn")
  expect(entry.pipelineInfo.maxTokensContinuation.suppressedMaxTokens).toBe(true)
  // attempts[] 含合成续写轮的 upstreamRequest，真实带 synthetic:"continuation" provenance 标记（非 fixture 手工挂）
  const continuationAttempt = entry.attempts.find(a => a.dispatchVerdict === "continued" || /* 视 provenance 前置任务的确切字段形状 */)
  expect(continuationAttempt?.upstreamRequest?.extensions?.synthetic).toBe("continuation") // 精确字段路径以前置任务定稿为准
  // 上游原始轨（upstreamResponse）无合成物
})
```

- [ ] **Step 2-4:** 跑失败 → 实现（Task 1.2 截获点记录每轮真实 stopReason 到累积数组，最终 populate `pipelineInfo.maxTokensContinuation`；复用 P0 Task 0.5 的字段骨架和 `recordMaxTokensTruncation`/新增 `recordMaxTokensContinuationRounds` 方法真正调用多轮场景）→ 跑通过。
- [ ] **Step 5: 提交** → `feat(history): faithful backend recording for max_tokens continuation (perRoundStopReason + clientVisibleStopReason + real provenance)`。

**警示（对照记忆 `settle 冻结 history entry`）：** 本 task 的字段必须在 `ctx.complete()` **调用之前**完成 record（settle 冻结 entry 快照），不能依赖 settle 之后的 mutation——Task 1.1a/1.1b 已确认续写循环内 `ctx.complete()` 延后到循环真正结束才调用，故 record 时点在循环内部持续累积（每轮 flush 前 append 到累积数组），最终一次性随 `ctx.complete()` 的 `buildAnthropicResponseData` 一起提交，符合「settle 前 record」纪律。

### Task 1.5: handler 生产接线（C4 同构风险，独立必需步骤，含组合校验消费）

- [ ] **Step 1: 写失败测试** —— 端到端验证 opts 真正从 handler 传到 driver，未接线时续写不触发（即便 driver 内部逻辑正确，未接线=死代码）；**验证 handler 传的是 effective config（已过组合校验），非原始 raw config**。

```ts
test("production wiring: handler passes resolveEffectiveMaxTokensContinuation('anthropic') (combination-validated) to driver opts; unwired path never continues", async () => {
  // 对照 handler-v4.ts 当前 opts 组装，断言 maxTokensContinuation 键存在且值来自 resolveEffectiveMaxTokensContinuation（非裸 resolveMaxTokensContinuation）
})
```

- [ ] **Step 2-4:** 跑失败 → 在 `src/routes/messages/handler-v4.ts` 组装 `runResponseBufferedSink` opts 处（`:1203` 附近，与既有 `committedBlocksLedger`/`continuation` 接线相邻）新增：
```ts
maxTokensContinuation: resolveEffectiveMaxTokensContinuation("anthropic"), // 已含组合校验降级
maxTokensTerminalObserver: () => anthropicTerminalObserverState, // P0 独立 observer 实例，per-request
```
→ 跑通过。
- [ ] **Step 5: 提交** → `feat(handler): wire effective max_tokens_continuation config + terminal observer into Anthropic buffered path (production wiring)`。

### Task 1.6: `strategy-prevented-stitch` 真实落盘 + telemetry（残留项，round-2 审查坐实缺具体记录任务）

> **修订记录（2026-07-23，据 GPT plan-review round-2 [残留] 修订）**：`resolveEffectiveMaxTokensContinuation` 的 `diagnostics` 数组此前只是函数返回值，没有落到 `pipelineInfo`/telemetry 的具体任务——round-2 审查指出这违反 spec「绝不静默吞配置」的要求（用户配置了非法组合，必须能在 history/telemetry 里查到"这次请求本该续写但被 visibility 策略阻止了"，不能只在内存里降级完事）。

- [ ] **Step 1: 写失败测试** —— 真实持久化 + telemetry readback，非函数返回值断言。

```ts
// tests/pipeline/max-tokens-strategy-prevented-stitch.it.test.ts
test("a request configured with visibility=passthrough + classes.text=continue: history entry records strategyPreventedStitch=true; telemetry counter for the outcome increments", async () => {
  // 走真实 http 流程，配置该非法组合，mock 上游产出 A 类 max_tokens 截断
  const entry = await getHistoryEntryFor(reqId)
  expect(entry.pipelineInfo.maxTokensContinuation.strategyPreventedStitch).toBe(true)
  expect(entry.pipelineInfo.maxTokensContinuation.truncationClass).toBe("text") // 分型仍照常记录（观测独立于是否续写）
  // telemetry readback：一个独立于 class 维度的 outcome 计数器
  const stats = await readTelemetrySnapshot()
  expect(stats.maxTokensContinuationOutcome["strategy-prevented-stitch"]).toBeGreaterThan(0)
})
test("a request with a LEGAL combination (visibility=transparent + classes.text=continue): strategyPreventedStitch is false/undefined, no spurious counter increment", async () => {
  // 对照组，确认没有配置该组合的正常请求不会误触发这个诊断标记
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** —— 在 Task 1.2 的截获点：当 `resolveEffectiveMaxTokensContinuation` 返回的 `diagnostics` 数组含 `"strategy-prevented-stitch"` 时（即本次请求命中了曾被降级的非法组合配置——注意这个诊断信号的产生时机是**配置解析时**，不是每次请求时都重新跑校验，但记录动作是**每次命中 max_tokens 终止时**），把 `strategyPreventedStitch: true` 写入 `recordMaxTokensTruncation` 调用的 diag 对象（P0 Task 0.5 已建的记录端口，本 task 只是真正传入非默认值）。**telemetry 侧**：在 `src/lib/observability/telemetry-dimensions.ts` 或新文件注册一个独立于 `max_tokens_truncation{class}` 的 outcome 维度/counter（`max_tokens_continuation_outcome{outcome="strategy-prevented-stitch"}`，参照 telemetry-architecture skill「聚合后无法重算的因子拆最细」——这是一个独立可观测事件，不应该被塞进 class 维度里稀释掉）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(observability): real strategy-prevented-stitch recording (history + telemetry readback, not just in-memory diagnostics)`。

### P1 收口

- [ ] `test:fast` + `typecheck` 绿；`test:backend`（driver + handler 集成）绿。
- [ ] **R1 golden 验证**：`enabled:false` 时四种截断分型的 max_tokens 透传逐字节等价于现状（跑既有 golden 测试套件，确认未破坏任何既有断言）。
- [ ] **连跑确定性**：涉及 terminal 截获时序的测试连跑 10-25 次（FakeClock + 持 ReadableStream controller 精确控帧）。
- [ ] History oracle 独立验收（Task 1.4 的真实持久化读回，非手动 round-trip）。
- [ ] **组合校验验收**：无论何时启用 P1（即便只是"刚落地这一个 commit"），配置 `passthrough+continue` 的用户不可能观察到协议违规（Task 1.2 的降级测试 + Task 1.5 的接线测试共同覆盖），且该次请求的 `strategy-prevented-stitch` 已真实落盘 + telemetry 可查（Task 1.6，非仅内存诊断）。
