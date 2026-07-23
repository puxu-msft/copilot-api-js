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

## 1. SSOT 类型改动（审计方法 = 跑 typecheck 逐个吃错，非罗列已知重复）

> **审查 Critical-1 修正**：初稿只列"已知重复声明"就断言"已核实穷尽"——错。正确审计法 = **加值后跑 `bun run typecheck`，逐个吃掉每个编译错误**（TS 会把每个不同源的字面量联合消费点炸出来，编译期抓、不静默漂移）。下方是已知必改点，但**以 typecheck 全绿为准**，不以此清单为准。

**主定义**（`src/lib/context/model-operation-record.ts`）:
- `:237` `DispatchVerdict` 加 `| "continued"`
- `:240` `CandidateRole` 加 `| "continuation"`
- `:241` `CandidateVerdict` 加 `| "continued"`

**已知必改的镜像/消费点**（[已核实] file:line，漏改则编译红或投影丢值）:
- `src/lib/pipeline/generation/candidate-state.ts:19` `CandidateRole` 重复声明 → 改为 `import type { CandidateRole }`（消灭重复，SSOT-types）。
- **[C1 补漏] `src/lib/context/request.ts:690-693` `settleGenerationAttempt` 的 `verdict` 内联 4 值字面量** → 改为 `import type { DispatchVerdict }`。[已核实] :1377 `settleGenerationAttempt(attempt, input.verdict, ...)` 处 `input.verdict` 是 `DispatchVerdict`（`types.ts:561`），加值后此调用点**普通函数实参协变检查会编译红**——这是初稿漏掉的真正挡编译点。
- **[C1 附带确认] `request.ts:697` `if (verdict !== "committed" && attempt.sseEvents !== undefined) v2.sseEvents = [...]`**：`"continued"` 落入 `!== "committed"` 分支 → 保留 sseEvents 快照。**这是期望行为**（续写诊断可追溯），实施时在 commit message 显式确认，不隐式继承（Minor-2）。
- `src/lib/context/types.ts:520,522,524` + `src/lib/history/types.ts:520,522,524`：`candidateRole?`/`candidateVerdict?`/`dispatchVerdict?` 内联字面量 → 优先改引用 SSOT 类型。
- **[Important-2 补漏] `src/lib/pipeline/driver.ts:653` `if (settlement.verdict === "discarded" && settlement.retryNextStrategy)`**：[已核实] `retryNextStrategy` **只在 `verdict === "discarded"` 时被消费**（唯一读点 → `recordAttemptFailure`）。续写结算 `verdict:"continued"` → `retryNextStrategy:"continuation"` 会被**静默忽略**。须决策：续写是否也要走 `recordAttemptFailure`（诊断/telemetry 可见）——建议加 `|| verdict === "continued"` 分支或专门记录路径（§5 telemetry 拆分依赖此可见性）。
- **[Minor-1 补漏] `src/lib/history/v3/projection.ts:312` `success: response?.success ?? attempt.verdict === "committed"`**：[已核实] `"continued"` dispatch 因 `!== "committed"` → 投影 `success:false`，History UI 会把"部分交付 + 正常移交续写"显示成失败（与 failed/discarded 视觉不可分）。**本轮决策**：暂按 `success:false` 呈现 + 记 backlog（UI 层为 `continued` 加中性"部分交付"展示是独立 UI 任务，不阻塞机制落地）——或在 projection 显式把 `continued` 投影为一个中性态。用户裁决取其一。

**穷尽消费者审计**：[已核实] telemetry（`telemetry/{db,store,read}.ts`）用通用计数列、无 per-verdict switch → 加计数零 schema 风险。实施期以 `bun run typecheck` 全绿 + grep 全仓 `DispatchVerdict|CandidateVerdict|CandidateRole` 每个消费点为准；ui-v4 经 `~backend/*` re-export 若有 verdict 渲染须同步（穷尽 Record）。

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
// [C2 修正] 初稿 Math.max(remainingShared,1) 恒>0 → continuation-exhausted 不可达 → 无限续写（spec §12 否决）。
// 循环外：let attempt=0（透明重试，已有）；let continuationCount=0（新）。
const remainingShared = cap - attempt - continuationCount // 共享预算：透明重试 + 续写合计 ≤ cap
// "保底 1 次"= 只在首次进入续写时抬下限到 1，此后正常递减到 0 才终止（一次性下限，非每次 floor）
const continuationBudget = continuationCount === 0 ? Math.max(remainingShared, 1) : remainingShared
const canContinue = committedAny
  && !retreated
  && (thrown ? classifyStreamError(thrown) === "other" : true)
  && opts.committedBlocksLedger !== undefined && opts.extractCommittedBlocks !== undefined // [C4] 未接线不续写
  && state.bufferedRetryContinuation.enabled
  && getContinuationBuilder(clientFormat) !== undefined
  && continuationBudget > 0                       // 现在真的会耗尽
  && !hasCompleteInteractiveToolUse(opts.committedBlocksLedger.snapshot()) // D3
if (canContinue) { continuationCount++; /* → runContinuation（§4）*/ }
// 预算耗尽 → committedAny 既有路径 → continuation-exhausted（P0 outcome）
```
- [已核实] ledger 是**外层 opts、跨 attempt 同一实例**（`currentCandidateResponseOpts = {...outer,...candidate}`，ledger 不在 candidate opts 里）→ P0 累积 + §5.2 共享预算「免费」复用同一 `for(;;)` 循环。**续写必须留在此循环内**（排除方案 C）。
- **[C4 承重] 生产接线是独立、必需的一步**（初稿 §8 漏）：ledger/extractor 目前**只在 `.it.test` 手工构造**，`handler-v4.ts:1193-1229` 传给 `runResponseBufferedSink` 的 opts **不含** `committedBlocksLedger`/`extractCommittedBlocks`（[已核实] `git show d6a16bb7` 自述 "Not yet wired into the handler in production"）。缺此步则前 5 提交全死代码、门恒读空 ledger。§8 显式新增"生产接线"提交。`canContinue` 双守卫防未来格式漏接线静默触发空 ledger 续写。

## 4. continuation-executor（append 语义 + index 续接 + message_start dedup）

新 `src/lib/pipeline/continuation-executor.ts`：`runContinuation(deps, ...)`：
1. 用 `getContinuationBuilder(clientFormat)(originalEnv.body, ledger.snapshot(), config.message)` 构造续写 body → 新 env（`env.with({ body })`）。合成轮打 `synthetic:"continuation"` 进 `upstreamRequest` 轨、**不污染上游原始轨**（spec §4.4）。
2. `coordinator.runContinuation(parent.candidate, "continuation", contEnv)` 起 `role:"continuation"` 新 candidate → 新上游 exchange。
3. **[C3 承重修正] wire-index 续接的 offset 数据源 = 已上线到客户端的块计数，绝不是 `ledger.snapshot().length`**（全新、无现成消费者）：
   - 反例（[已核实] 证据链）：客户端已收 thinking@0 + text@1（2 块上线）；但 extractor 丢 thinking（`committed-block-extractor.ts:55-60`）、`anthropicCommitBoundaries` 不分块类型照 commit thinking（`commit-boundaries.ts:20`）→ `ledger.snapshot().length === 1`。若 offset=1，续写首块落 index 1 = **撞已发的 text@1**，破坏 SSE 结构。这是 D3「被掐于 text/thinking」的**核心场景**，非边缘。
   - 正确：driver 维护**独立的 wire-level 已上线块计数器**（每成功 flush 一个 commit 边界块就 +1，无论 extractor 是否保留），offset 用它。**复用 `AnchorIndexAllocator`（`keepalive-anchor.ts:32-62` 的 `onRealBlockOpen`/`realBlockOffset`）**——正是"已开出多少真实块→下一块落哪 wire index"的同构记账原语，D2 后闲置（这同时给 P1 reviewer 标记的"allocator 零消费者"一个真实消费者）。抽 offset 为参数复用 `remapAnthropicBlockIndex`，勿新造重排。
   - **message_start dedup**：续写新 exchange 产第二个 `message_start`（新 id/usage）→ 丢弃（客户端全程唯一一个 message_start）。与 anchor H1 dedup 同构但独立状态。
   - **message_stop 抑制**：已完整块**不发** message_stop（不结束连接，ADR D3）；只有续写最终成功那次发 message_stop。
4. 输出帧**接同一 sink**、wire-index 续接；settle 点冻结 ledger 快照（persistence-async-invariants §3）。
5. 迭代：续写再被掐 → 回 §3 门（预算递减、ledger 继续累积、wire 计数器继续递增）。终局 outcome：`success` / `continuation-exhausted`（预算耗尽，现可达）/ `partial-degrade`（不可续）。

**[Important-1] replay vs append 帧变换挂载点须先画清**（spec §5.1 首要架构项，初稿仍未落地）：续写新 exchange 帧是复用主循环 `for await (frame of runResponse)` 循环体（默认 buffer-then-flush-at-boundary，为"重生整段"设计），还是绕过 buffer 独立直通转发？offset remap / message_start dedup / message_stop 抑制三手术挂 `onRenderedFrame`（driver.ts:1142 已有钩子）还是新 `transformContinuationFrame`？续写 exchange 自己的 `commitBoundaries`/`sawMessageStop` 是否需抑制（否则续写走到自己的 message_stop 会被主循环当作本 attempt 终态提交尾部）？**实施前用 §3.3 那样的详细度画出"新上游 frame → client sink 帧"完整变换链 + 挂载点**——本计划最大结构性未决，PoC P-A 前必须定。

## 5. History / telemetry（richest-data-flow）

- 每次续写 = 新 attempt/dispatch：`upstreamRequest` 含合成轮（打 `synthetic:"continuation"` + ledger 快照引用）+ `upstreamResponse`（真实上游帧，无合成物）。沿用现有 `beginDispatch`/`settleDispatch` 记录端口。
- parent dispatch/candidate 结算为 `continued`（非 failed）→ History `attempts[]` 诚实呈现「部分交付 + 续写接续」。
- telemetry §5.3 拆分：`continuationCount`（续写次数）与首块前透明重试次数分开计数（`meta.continuationRetries` P0 已备）；新 `continuation` role 让 sink 平行加计数、不与 `recovery` 混桶。

## 6. 测试策略

- **单元**：continuation-executor 的 wire-index offset 续接（含 **[C3 回归] thinking 块场景**：thinking@0+text@1 上线但 ledger 只 1 → offset 须=2 非 1，纯算法单测，不依赖真上游）、message_start dedup、message_stop 抑制。
- **driver .it**（续 `tests/pipeline/continuation-retry.it.test.ts`）：首块 commit→RST→走 runContinuation（非 partial-degrade）；前缀含 tool_use→不续写（D3 回归）；预算保底 1 次；**[C2 回归] 预算耗尽→`continuation-exhausted` 可达**（不无限续写）；`continued` verdict 结算正确（parent 非 failed）；**[C4] 未接线 ledger→不续写**。
- **客户端 SDK oracle**（wire 正确性不自洽，skill `client-proxy-e2e-testing`）：`@anthropic-ai/sdk` 消费缝合流（已发块 + 续写块重编号），断累积连续、无重复、无第二 message_start、无协议破坏。**含 thinking 块的缝合流**（验 C3 offset 真对）。
- **e2e（mock upstream，`upstream-hook-mocking`）**：造「首块后 mid-block RST」→ 断代理发出续写请求（含合成轮）→ mock 续写响应 → 客户端 SDK 拿完整拼接（incident 复现）。
- **flaky**：FakeClock + 持 ReadableStream controller 精确控帧；连跑 10-25 次证确定性。

## 7. PoC 待验点（实施前须实测，非纯推理）

- **P-A [承重]**：续写新上游 exchange 的帧**能否无缝接到已推进的 sink** 而不破坏 SSE 协议（同一 200 连接内，第二个上游 response 的帧经 wire-index-offset + message_start dedup 后，真 `@anthropic-ai/sdk` 是否接受为一条连续流）。→ mock upstream + SDK oracle 先跑最小缝合流。**[C3] P-A 用例必须含 thinking 块**（否则 offset 错位这个算法 bug 会被无 thinking 的用例漏过、给虚假安全感——offset 正确性与 P-A wire 接受度是两个独立维度）。
- **P-B**：`generation-budget.reserveCandidate("continuation")` 是否真无 per-role 硬编码分支（读 `generation-budget.ts` 确认）。
- **P-C [Important-2]**：不只"`retryNextStrategy` 是否封闭枚举"——更关键：[已核实] `driver.ts:653` 只在 `verdict==="discarded"` 时消费 `retryNextStrategy`，`"continued"` 会被静默忽略。须决策续写是否也走 `recordAttemptFailure`（telemetry §5.3 拆分可见性依赖此）。

## 8. 改动面清单（提交切分，每 commit 终态自洽、中间态不半坏）

1. `feat(record): add continued verdict + continuation role to operation-record SSOT`（SSOT 加值 + **[C1] 全镜像同步，审计法 = 跑 typecheck 逐个吃错**，含 `request.ts:692`/`driver.ts:653`/`context/types.ts`/`history/types.ts`/`candidate-state.ts` + 消灭重复声明；该 commit 终态 = **typecheck 全绿**，不半坏）。
2. `feat(coordinator): runContinuation (append-semantics, continued settle)`。
3. `feat(driver): committedAny-bypass continuation branch (D3-gated + real budget exhaustion)`。
4. `feat(pipeline): continuation-executor (wire-index continuation + message_start dedup)`。
5. **[C4 新增] `feat(handler): wire continuation ledger + config into the Anthropic buffered path`**（handler 建 ledger + 传 extractor + 解析 config——**没有这步前面全是死代码**；放在 executor 之后、SDK-oracle 测试之前）。
6. `feat(telemetry): split continuation vs transparent-retry counts`。
7. `test: continuation SDK-oracle stitched-stream (incl. thinking) + incident e2e`。

## 9. 风险 / 未采纳

- **方案 B（复用 runRecovery 换 verdict）未采纳**：一函数两历史身份，高概率诱使复用 `recovery` role → 破坏 telemetry §5.3 拆分。
- **方案 C（绕开 coordinator）未采纳**：需重建 attempts/budget/reactive-retry，违 richest-data-flow + spec §4.4。
- **主风险**：P-A（sink 缝合）未过 → 续写形状需调整（回退 partial-degrade 保底，不牺牲其余格式）。
- SSOT 改动波及面广，靠 TS 穷尽检查逐个逼出（编译期抓，不静默漂移）。

## 10. 异模型对抗审整合记录（gpt-souls:reviewer 第 1 轮，2026-07-22；主线逐条复核 file:line 后采纳）

- **[Critical-1 采纳]** SSOT 审计不全：`request.ts:692` `settleGenerationAttempt` 内联 4 值 verdict → 加值后 :1377 调用点编译红（初稿漏）。改：审计法从"列已知重复"改为"跑 typecheck 逐个吃错"，§1/§8.1 补 request.ts + driver.ts:653。[已核实]
- **[Critical-2 采纳]** `Math.max(remainingShared,1)` 永真 → `continuation-exhausted` 不可达 → 无限续写（违 spec §12）。改：§3 预算算法为"首次进入一次性下限、此后递减到 0"，§6 补耗尽可达回归测试。
- **[Critical-3 采纳，承重]** `offset=ledger.length` 在 thinking 块场景错位（thinking 上线占 index 但不入 ledger）。改：§4 offset 数据源改 wire-level 已上线块计数器（复用 AnchorIndexAllocator），§6/§7 补 thinking 场景用例。[已核实 证据链]
- **[Critical-4 采纳]** ledger 生产未接线，门恒读空。改：§3/§8 新增"生产接线"提交 + `canContinue` 双守卫。[已核实 handler-v4 无接线]
- **[Important-1 采纳]** replay vs append 帧变换挂载点未落地 → §4 末补"实施前须画完整变换链 + 挂载点"红线（PoC P-A 前必须定）。
- **[Important-2 采纳]** `retryNextStrategy` 在 `verdict!=="discarded"` 不被消费 → §1/§7 P-C 补决策点。[已核实 driver.ts:653]
- **[Minor-1 采纳]** projection `success=verdict==="committed"` → `continued` 显示为失败 → §1 补 UI/投影决策（暂 backlog 或中性态，用户裁决）。[已核实 projection.ts:312]
- **[Minor-2 采纳]** `request.ts:697` sseEvents 快照对 `continued` 行为 = 保留（期望，诊断可追溯）→ commit message 显式确认。
- **顶层决策（新增第 5 个 verdict）经 reviewer 独立核实为合理**，未被推翻（committed 排他 :1048 + commitTerminal 强制结算 :1098/1100 属实）。

> **状态**：Critical 全部在计划层已修正。进入实现前**建议再过一轮异模型审确认修正到位**（尤其 §4 帧变换链画完后），或直接进实现并在 executor 落地后合并态审。

## 11. 落地记录（2026-07-23,分支 `feat/continuation-retry`,未合并 master）

P2(Anthropic 续写)**已完整落地并端到端验证**。提交序:

1. `d151f288` SSOT 新增 `continued` verdict + `continuation` role(typecheck 逐个吃错穷尽镜像:request.ts/context/history/candidate-state)。
2. `26d1fc4d` `coordinator.runContinuation`(parent 结算 `continued` 非 failed)。
3. `cd2fa29c` PoC P-A(真 SDK 接受缝合流 + C3 offset 坐实,`exp/continuation-stitch/`)。
4. `a459fb31` driver committedAny 旁路续写分支 + 缝合重写(wire-index offset + message_start dedup;C3 mutation-verified)。
5. `ba3e9e02` handler 生产接线(ledger/extractor/hooks + registerAnthropicContinuationBuilder)+ SDK oracle e2e(端到端活线证明)。
6. `089b8310` telemetry 拆分(preFirstBlock vs continuation)+ Important-2 recordAttemptFailure。
7. `bdb06513` 合并态审 remediation(见下)。

**Important-1 解决(vs 计划)**:无独立 executor 文件——续写复用 driver `for(;;)` 循环 + `coordinator.runContinuation`。被掐腿无 message_stop 故无需抑制,只丢 message_start dedup + wire-index offset(scalar,primary 腿 offset 0 惰性)。

**合并态异模型审(gpt-souls:reviewer)findings 处理(`bdb06513`,逐条 file:line 复核)**:
- [Critical-1 = 范围澄清,非阻塞] D4 全端点未落地——但 CC/Responses 属 P4-P6 分阶段,P2 仅 Anthropic(kickoff/plan 界定)。端点矩阵已写进 spec 头。
- [Critical-2 = 真修] `history/v3/projection.ts` `record.attempts.length`(imported record 上 undefined→TypeError)→ 改回 `record.dispatches.length`。**stale-branch bug**:master 已修(分支落后 32 commit),非续写代码;但**先前把这 4 个 History V3 fail 当「无关预存」dismiss 是错的**(应对照 master 跑而非信 HANDOFF 注)。414 history 测全绿。
- [Important-1 = 诚实化+backlog] `synthetic:"continuation"` provenance marker 未实现,driver 注释曾谎称已打→改诚实 + 记 `docs/todo/2026-07-22-continuation-synthetic-provenance.md`(纯可观测性缺口)。
- [Important-2 = 真修] 续写预算超候选上限(`maxTotalCandidates ?? 5`,`max_retries≥5` 时第 6 候选 throw)→ 根因修:续写 best-effort,dispatch 包 try/catch 优雅降级 `continuation-exhausted` 而非崩;候选上限从 `deps.maxRetries` 推导。
- [Minor = 补测] chained 续写(多跳)成功走**生产路径** SDK e2e 断言(mock 驱不动 runContinuation 候选会话终态);mock 侧加优雅预算降级测。

**验证**:full `test:backend` exit 0(4 History fail 已清,无回归);continuation-flow.it(mock)+ continuation-sdk.it(真 SDK,含 thinking-offset + chained)+ coordinator.it + protect-streaming-stats.unit 全绿;typecheck + lint 干净。

**剩余(非 P2)**:P3 incident 复现 e2e、P4-P6 CC/Responses 续写、P7 默认翻转(依赖 >300s keepalive)、synthetic provenance marker(backlog)。
