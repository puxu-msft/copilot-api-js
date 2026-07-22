# Plan-2b: 续写 executor + coordinator 缝（方案 A：新增第 5 个 verdict / role）

> 状态：草案（待异模型对抗审 + 用户过目）。日期 2026-07-22。
> 依据：用户裁决「方案 A（新增 `continued` verdict + `continuation` role + `runContinuation`）」+「先出详细 plan + 异模型审再实现」。
> 前置调查：`gpt-souls:architect-advisor` 报告（已主线复核 file:line，见下每条 [已核实]）。
> 关联：[ADR](../../decisions/2026-07-22-continuation-retry-sequential-anchor.md) D3、[spec](../../spec/2026-07-22-continuation-retry-and-sequential-anchor.md) §4-§5、[plan-2](plan-2-continuation-driver.md)。

## 0. 为什么需要第 5 个 verdict（承重论证，已核实）

续写触发时 parent dispatch/candidate 是**部分成功**（已 commit 块已在客户端 wire 上）。现有封闭四值枚举没有一个诚实描述它：

- [已核实] `DispatchVerdict = "committed"|"discarded"|"failed"|"cancelled"`（`model-operation-record.ts:237`）、`CandidateVerdict = "winner"|"loser"|"failed"|"cancelled"`（:241）。
- [已核实] `"committed"` **排他单例**：`model-operation-record.ts:1048` 二次 committed 直接 `throw`；:1061 `committedDispatch = handle`。最终那次「续写成功交付 message_stop」的 dispatch 占用它，parent 不能再标 committed。
- [已核实] `commitTerminal` 强制**每个 dispatch + candidate 必须显式结算**：:1098/:1100 有 open 的就 `throw`。故 parent 必须结算成某个 verdict，不能悬空。
- `discarded`/`failed` 都隐含「内容对客户端无价值/被扔」——与事实（内容已交付）相反。

→ **结论**：必须新增第 5 个值 `continued`（dispatch + candidate 各一），语义 = 「本次交换未达自己的终止符，但其已 commit 内容被完整保留、由后续续写接续」。这是结构性必需，非措辞问题。

## 1. SSOT 类型改动（含所有镜像同步点，已核实位置）

**主定义**（`src/lib/context/model-operation-record.ts`）:
- `:237` `DispatchVerdict` 加 `| "continued"`
- `:240` `CandidateRole` 加 `| "continuation"`
- `:241` `CandidateVerdict` 加 `| "continued"`

**镜像/重复声明同步点**（[已核实] 均为内联字面量、非 re-export，漏改则类型不兼容或 History 投影丢值）:
- `src/lib/pipeline/generation/candidate-state.ts:19` `CandidateRole` 重复声明 → **改为 `import type { CandidateRole }` 消灭重复**（SSOT-types 原则，非再抄字面量）。
- `src/lib/context/types.ts:520,522,524` `candidateRole?`/`candidateVerdict?`/`dispatchVerdict?` 内联字面量 → 加新值（或改引用 SSOT 类型，优先引用）。
- `src/lib/history/types.ts:520,522,524` 同上（History 投影镜像）。

**穷尽消费者审计**（防止哑漏）:
- [已核实] telemetry（`src/lib/telemetry/{db,store,read}.ts`）用**通用计数列**（`*_candidates` 无 per-verdict enum switch）→ 新 role 纯加计数、零 schema 改动风险。
- 实施期 grep 全仓 `DispatchVerdict`/`CandidateVerdict`/`CandidateRole` 的每个消费点，逐个确认新值处理正确（尤其任何 `Record<Verdict,...>`/`switch`/UI 渲染）；ui-v4 经 `~backend/*` re-export，若有 verdict 渲染须同步（穷尽 Record）。

## 2. coordinator.runContinuation（镜像 runRecovery，结算不同）

`src/lib/pipeline/generation/coordinator.ts`：接口加 `runContinuation(parent, reason, env): Promise<CoordinatedCandidate<TProcessor>>`，实现镜像 `runRecovery`（:125-133）但：
```ts
await parent.settleDispatch({ verdict: "continued", reason, retryNextStrategy: "continuation" })
parentRuntime.settle({ verdict: "continued", reason })
candidateReservations.get(parentRuntime.handle)?.release()
if (active === parentRuntime) active = undefined
return start({ role: "continuation", parentCandidate: parent.candidate, env })
```
- [已核实] `start()` 通用；`generationBudget.reserveCandidate(role)` 按 role 预留，无需为新 role 加分支（确认 `generation-budget.ts` 无 per-role 硬编码——实施期核实）。
- [已核实] `retryNextStrategy` 现有取值须核（`settleDispatch` 参数），`"continuation"` 若是新值也要同步其类型。

## 3. driver 旁路分支（committedAny + D3 门 + 预算保底）

`src/lib/pipeline/driver.ts` `runResponseBufferedSink` 的 `for(;;)` 循环内、失败分支处（现 `retryable`/`runRecovery` 一带，约 :1325-1354）：**旁加平行分支**，不弱化 `!committedAny`（terminal-only R1 逐字不变）:
```ts
// D3 门 + 预算保底：committedAny 且被掐 且 continuation 可行 且 前缀无完整可交互 tool_use
const continuationBudget = Math.max(remainingShared, 1) // §5.2 保底 1 次
const canContinue = committedAny
  && !retreated
  && (thrown ? classifyStreamError(thrown) === "other" : true) // 同 retryable 的错误类过滤（truncation/transport-close）
  && state.bufferedRetryContinuation.enabled
  && getContinuationBuilder(clientFormat) !== undefined
  && continuationBudget > 0
  && !hasCompleteInteractiveToolUse(opts.committedBlocksLedger?.snapshot() ?? [])
if (canContinue) { /* → runContinuation 分支（下 §4） */ }
```
- [已核实] ledger 是**外层 opts、跨 attempt 同一实例**（`currentCandidateResponseOpts = {...outer,...candidate}`，ledger 不在 candidate opts 里）→ P0 累积 + §5.2 共享预算「免费」复用同一 `for(;;)` 循环。**续写必须留在此循环内**（排除方案 C）。
- **共享预算**：续写与首块前透明重试合计 ≤ `max_retries`；`continuationBudget = max(remainingShared, 1)` 保底（spec §5.2 (a)）。用独立计数器 `continuationCount` 与 `attempt` 分开(telemetry §5.3 拆分)。

## 4. continuation-executor（append 语义 + index 续接 + message_start dedup）

新 `src/lib/pipeline/continuation-executor.ts`：`runContinuation(deps, ...)`：
1. 用 `getContinuationBuilder(clientFormat)(originalEnv.body, ledger.snapshot(), config.message)` 构造续写 body → 新 env（`env.with({ body })`）。合成轮打 `synthetic:"continuation"` 进 `upstreamRequest` 轨、**不污染上游原始轨**（spec §4.4）。
2. `coordinator.runContinuation(parent.candidate, "continuation", contEnv)` 起 `role:"continuation"` 新 candidate → 新上游 exchange。
3. **续写帧重写小状态机**（[已核实] 全新、无可复用原语）：
   - **index 续接**：`offset = ledger.snapshot().length`（**运行时可变**，非常量 1）。续写新上游从 index 0 计数，客户端已收 N 个块 → 续写 content_block_* 帧整体 `+offset`。与 `remapAnthropicBlockIndex` 同构但 offset 非常量；抽 offset 为参数复用该函数，勿新造重排。
   - **message_start dedup**：续写新 exchange 产第二个 `message_start`（新 id/usage）→ 丢弃（客户端全程唯一一个 message_start）。与 anchor H1 dedup 同构但独立状态。
   - **message_stop**：已完整块**不发** message_stop（不结束连接，ADR D3）；只有续写最终成功那次发 message_stop。
4. 输出帧**接同一 sink**、index 续接；settle 点冻结 ledger 快照（persistence-async-invariants §3）。
5. 递归/迭代：续写本身可能再被掐 → 回到 §3 门（预算递减、ledger 继续累积续写已 commit 的块）。终局 outcome：`success`（续写成功）/ `continuation-exhausted`（预算耗尽，P0 已备）/ `partial-degrade`（不可续）。

## 5. History / telemetry（richest-data-flow）

- 每次续写 = 新 attempt/dispatch：`upstreamRequest` 含合成轮（打 `synthetic:"continuation"` + ledger 快照引用）+ `upstreamResponse`（真实上游帧，无合成物）。沿用现有 `beginDispatch`/`settleDispatch` 记录端口。
- parent dispatch/candidate 结算为 `continued`（非 failed）→ History `attempts[]` 诚实呈现「部分交付 + 续写接续」。
- telemetry §5.3 拆分：`continuationCount`（续写次数）与首块前透明重试次数分开计数（`meta.continuationRetries` P0 已备）；新 `continuation` role 让 sink 平行加计数、不与 `recovery` 混桶。

## 6. 测试策略

- **单元**：continuation-executor 的 index-offset 续接（offset=N）、message_start dedup、message_stop 抑制。
- **driver .it**（续 `tests/pipeline/continuation-retry.it.test.ts`）：首块 commit→RST→走 runContinuation（非 partial-degrade）；前缀含 tool_use→不续写（D3 回归）；预算保底 1；`continued` verdict 结算正确（parent 非 failed）。
- **客户端 SDK oracle**（wire 正确性不自洽，skill `client-proxy-e2e-testing`）：`@anthropic-ai/sdk` 消费缝合流（已发块 + 续写块重编号），断累积连续、无重复、无第二 message_start、无协议破坏。
- **e2e（mock upstream，`upstream-hook-mocking`）**：造「首块后 mid-block RST」→ 断代理发出续写请求（含合成轮）→ mock 续写响应 → 客户端 SDK 拿完整拼接（incident 复现）。
- **flaky**：FakeClock + 持 ReadableStream controller 精确控帧；连跑 10-25 次证确定性。

## 7. PoC 待验点（实施前须实测，非纯推理）

- **P-A [承重]**：续写新上游 exchange 的帧**能否无缝接到已推进的 sink** 而不破坏 SSE 协议（同一 200 连接内，第二个上游 response 的帧经 index-offset + message_start dedup 后，真 `@anthropic-ai/sdk` 是否接受为一条连续流）。→ mock upstream + SDK oracle 先跑最小缝合流。
- **P-B**：`generation-budget.reserveCandidate("continuation")` 是否真无 per-role 硬编码分支（读 `generation-budget.ts` 确认）。
- **P-C**：`retryNextStrategy` 是否封闭枚举、`"continuation"` 是否需同步其类型。

## 8. 改动面清单（提交切分）

1. `feat(record): add continued verdict + continuation role to operation-record SSOT`（SSOT + 全镜像同步 + 穷尽消费者审计 + 消灭 candidate-state 重复声明）。
2. `feat(coordinator): runContinuation (append-semantics, continued settle)`。
3. `feat(driver): committedAny-bypass continuation branch (D3-gated + budget floor)`。
4. `feat(pipeline): continuation-executor (index continuation + message_start dedup)`。
5. `feat(telemetry): split continuation vs transparent-retry counts`。
6. `test: continuation SDK-oracle stitched-stream + incident e2e`。

## 9. 风险 / 未采纳

- **方案 B（复用 runRecovery 换 verdict）未采纳**：一函数两历史身份，高概率诱使复用 `recovery` role → 破坏 telemetry §5.3 拆分。
- **方案 C（绕开 coordinator）未采纳**：需重建 attempts/budget/reactive-retry，违 richest-data-flow + spec §4.4。
- **主风险**：P-A（sink 缝合）未过 → 续写形状需调整（回退 partial-degrade 保底，不牺牲其余格式）。
- SSOT 改动波及面广，靠 TS 穷尽检查逐个逼出（编译期抓，不静默漂移，[已核实] candidate-state 调用点会炸型错）。
