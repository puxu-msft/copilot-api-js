# Plan-3: B2-P4～P6 —— fresh-dispatch splice 执行器 + handler 接线 + 协议级回归矩阵

> **实施状态（HEAD `dd79edb3`）：** 本 plan 的 direct Anthropic live 范围已落地。pre-ready delayed-commit、ready transport close、以及 ready-live clean EOF before semantic content 都先以无下游 authority 的 evaluator 收集 R；只有 `complete` R 才经 delivery owner 的 C9 batch publication 写入并提交 disposition。`commit-failed`/`wire-torn` fail-closed，唯一真实 finalizer 是 owner outer `finally` 的 `settleFinal()`。初始 fresh R dispatch 现与 ready R 一样显式标记 `precontent-recovery`，而不是把 V2 currentStrategy 留空。C4 以真实 handler 对 empty-text R success／fallback 同时读取 V2 entry 与 terminal-bus canonical V3 record，锁住 terminal、P/R upstream、failureReason 及 synthetic／real client frame provenance。旧文的接线行号、`4.3b 尚未接线`、`4.4/4.5 待做`均已过时；以下历史步骤保留为设计证据，当前状态以本段和任务状态表为准。
>
> **实际偏离（已验证且非范围缩减）：** 没有采用早期的逐帧 splice 门面，而是 evaluator → `stageDirectRecoveryBatch` → owner `publishRecoveryBatch` → disposition 的两阶段 publication；这保证 C9 前可 fallback、C9 后不把部分 R 降级回 P。buffered B2 与 translated publication 没有假装已实现，仍 fail-closed，前者在 backlog 中保留。真实 `@anthropic-ai/sdk` 离线 oracle、三 keepalive mode、abort provenance、clean EOF 与 History terminal projection 已进入 Task 5 覆盖。
>
> **范围裁定（用户硬约束 never-false-kill）：** B2 排除 `timeout(header-wait)`、`reaper-cancel` 等 abort provenance；只对确定性 HTTP/网络上游死亡且未交付真实语义内容启动。实现/测试资产已经完成；独立复评、C5 mutation evidence replay 与 `bun run test:backend` 最终门仍进行中，不能据此把全计划标记完成。可复现命令与 mutation 判据见 [Task 4.3b 实施报告](task-4.3b-implementation-report.md)。

## 背景：挂载点精确定位（代码实证）

`handler-v4.ts` 的 COMMIT 分支（`streamCommitAfterSec > 0` 且窗口已过期后）：

```
streamSSE(c, async (stream) => {
  ...
  try {
    let result: DriverRequestResult
    try {
      result = await p                     // ← p = driver.runRequest(...)（handler-v4.ts:426）
    } catch (error) {
      // ← 这里！pre-ready 失败必然落在这个 catch 块（handler-v4.ts:647-694）
      //   现有分支：isAbortError → client-abort/reaper-cancel/timeout 三分支
      //             HTTPError → 上游 4xx/5xx
      //             其余（socket reset / HTTP2 REFUSED_STREAM）→ network_error
      // B2 要在这三类"非 client-abort"的失败上，语义内容未交付时，先试 fresh recovery
    }
    ...
  } finally {
    sink.finalize?.()
    detachClientAbort()
  }
})
```

**关键判断：** B2 只对**非 client-abort**的失败生效（`isAbortError && clientAbort.signal.aborted` 分支必须原样保留 —— 客户端已经断开，救回来没有意义，且 spec/FINDINGS 都没有把 client-abort 纳入 B2 范围）。`reaper-cancel` 和 `timeout`（header-wait timeout）在语义上更接近"我方主动放弃"，是否也该走 B2 恢复——**这是一个待决问题**，见下方 Task 4.3 的门控项。HTTPError（上游 4xx/5xx）与其余非 abort 错误（network_error 类，socket reset/RST）是 B2 的核心目标（这正是原始事故 req_57/58/63 的形状：`rstCode=0`）。

### ⚠ 第二个挂载点：ready-但-pre-content 失败（Unified gate 的另一半，别只做 pre-ready）

上面这段只覆盖了 `await p` 本身 reject 的场景（pre-ready，`runRequest` 从未拿到 upstream）。但 spec/FINDINGS 明确要求统一 gate **同时覆盖"已经 ready、pump 正在跑、但上游在首个真实语义内容之前失败"**这第二种失败——这在代码里是完全不同的落点：

- **live 路径**：`pumpAnthropicStreamingV4` 的 `outcome.kind === "stream-error"` 分支（`handler-v4.ts:1279-1320`）——upstream 的可迭代对象在 `sink.write` 过程中抛出（H3）。此刻 `acc`（accumulator）是否已经产出过真实 block，即 `hasDeliveredSemanticContent` 的 ready-态判据（Plan-2 Task 0.2 的第二分支）。
- **buffered 路径**：`driver.ts` 内部 `runResponseBufferedSink` 的重试循环耗尽/不可重试时，落到 `degradeOutcome = committedAny ? committedDegrade : "exhausted"`（`driver.ts:1482`）——**当 `committedAny === false`**（等价于"ready 但没有真实内容交付"）的 `"exhausted"` 分支，是 B2 buffered 路径的目标挂载点。**当 `committedAny === true`** 时已经是 continuation-retry 的地盘，不是 B2 的范围（两者由 `committedAny` 这同一个既有布尔值互斥区分，无需新增判据）。

**这意味着 Task 4.3 的接线必须做两处，不是一处**：① `handler-v4.ts` COMMIT 分支的外层 `catch (error)`（pre-ready，Plan-2 已提供 `driver.runPreContentRecovery`）；② `pumpAnthropicStreamingV4` 的 `stream-error` 分支 + `runResponseBufferedSink` 的 `"exhausted"` 结局（ready-但-pre-content，**这里不能直接调 `driver.runPreContentRecovery`**——那个方法的设计前提是"`coordinator.runPrimary()` 本身 reject"，而 ready-态失败时 primary 已经成功 ready 过、只是**响应流**失败了，需要走的是**已有的** `coordinator.runRecovery(parent, reason, env)`（这才是"ready parent 存在、要发起下一个候选"的正确既有方法，"B2 不是 continuation 变体"这句话只针对 pre-ready 场景，ready-态失败复用现有 `runRecovery` 完全合适——它与 continuation 的唯一区别是 gate 条件不同：`runRecovery`（无条件，既有机制，spec 之前就存在于"buffered-retry 委托 transparent retry"）vs `runContinuation`（`committedAny===true`），**而 B2 在 ready-态的新增价值仅仅是"把这条已有的 `runRecovery` 路径也接到 live（非 buffered）模式下"**——现状 `runRecovery` 目前只在 buffered 路径的驱动循环里被调用（`driver.ts:1389`），live 路径的 `pumpAnthropicStreamingV4` 遇到 `stream-error` 目前**没有任何重试**、直接终态失败。这是本计划必须澄清的第二个"新拓扑"点，其难度不亚于 pre-ready 分支，实现者务必两处都覆盖，不要只做 pre-ready 就当 B2 完工）。

**这一发现改变了 Files 清单与 Task 划分**（见下）——原草稿遗漏了 live 路径 ready-态失败这一半，现已修正。

## Files 总览

- Modify: `src/routes/messages/handler-v4.ts`（① COMMIT 分支的外层 `catch` 块，`:647-694` 附近——pre-ready 挂载点；② `pumpAnthropicStreamingV4` 的 `outcome.kind === "stream-error"` 分支，`:1279-1320` 附近——live 路径 ready-态挂载点）
- Modify: `src/lib/pipeline/driver.ts`（`runResponseBufferedSink` 的 `"exhausted"` 结局分支，`:1467-1488` 附近——buffered 路径 ready-态挂载点；`committedAny===false` 时旁路进 B2，`committedAny===true` 维持现有 continuation/partial-degrade 逻辑不变）
- Modify: `src/lib/anthropic/live-reconcile.ts`（Task 4.1′：把既有 live rewriting decorator 的控制面补完整，供后续恢复接线一次构造、跨 attempt 复用；它不是 pass-through，故不得继承 delivery identity；触发判定仍由 Task 4.2/4.3 落地）
- Modify: `src/routes/messages/post-commit-error.ts`（若 splice 也失败，仍需现有 `writeTerminalThenSettle` 机制收尾——复用，不重写）
- Test: `tests/anthropic/live-reconcile-cross-attempt.unit.test.ts`（按 wire state 覆盖同一个持久 decorated sink 跨首次 attempt 与 fresh attempt 的拼接行为）
- Test: `tests/e2e-client/precontent-recovery.it.test.ts`（client-proxy e2e，真 `@anthropic-ai/sdk` oracle，仿 `continuation-sdk.it.test.ts` 结构，覆盖两个挂载点）
- Test: `tests/routes/messages/precontent-recovery-matrix.it.test.ts`（协议级回归矩阵：三模式 × 5 种失败形态 × 两个挂载点）
- Test: `tests/pipeline/precontent-recovery-buffered.it.test.ts`（buffered 路径的 `committedAny===false` 旁路分支，driver 级）

---

## Task 4.0：ready-态挂载点 —— live 路径复用既有 `runRecovery`

> **实施状态（2026-07-28）：live driver 能力已完成，保持零 handler 接线；buffered 对应接线已裁决暂缓。** Plan 引用的**行号**已过时（`driver.ts:1389`→`:1530`、`handler-v4.ts:1279-1320`→`:1382-1423`），**文件路径未变**；当前 `generation.bindings` 仍是按 `UpstreamStream` 找回 `{coordinator,candidate}` 的 `WeakMap`，故原设计继续适用。新增 `driver.runResponseRecovery(upstream, env, reason)`：先对 ready 态 recovery 自己执行 `classifyServerExecutionRisk(outboundPrepareWire(...))`，不读取也不继承 hedge 的 `allowServerTools`，再调用既有 `coordinator.runRecovery`、绑定并返回 fresh upstream。`runRecovery` 新增可选 `retryNextStrategy` 覆盖参数，默认仍为 `"buffered-retry"`，ready 态 B2 显式写 `"precontent-recovery"`。当前 live pump 的真实 `stream-error` 分支仍直接终态失败；本 Task 按硬验收不接 handler，因此生产行为未变。测试覆盖 ready-open 后首个真实 block 前抛错可拿到第二 upstream、server-tool gate 不增加 open 次数、已交付真实内容时 delivery gate 为 true、History 标记覆盖与 buffered 默认值回归。下方 buffered 子任务未实施：主会话已裁决在 live Task 4.3/4.5 接线完成、具备实际 splice 语境后再做，现归档于 `docs/todo/deferred-backlog.md` 的“B2 ready-state recovery 的 buffered 路径旁路”条目；该路径必须尊重 `max_retries=0`。

**先做这个 Task，再做 Task 4.1（splice 纯函数对两个挂载点通用，但需求先从这里确认）。**

**设计依据：** `coordinator.runRecovery(parent, reason, env)`（`coordinator.ts:133-141`）已经是"给定一个 ready 的 parent 候选，settle 掉它、开一个新候选"的现成机制——目前**只有 buffered 路径的驱动循环在调用它**（`driver.ts:1389`，`runResponseBufferedSink` 内部）。live 路径的 `pumpAnthropicStreamingV4` 遇到 `stream-error` 时，目前是**直接终态失败**（`handler-v4.ts:1279-1320`，写错误帧 + `ctx.fail` + return），从未调用过 `runRecovery`。

B2 在 live 路径的新增值：当 `outcome.kind === "stream-error"` 且 `!hasDeliveredSemanticContent(candidateSnapshot)` 且 `!classifyServerExecutionRisk(...)` 命中时，**不要**立即写终态错误帧，而是调用 `driver`（需要新暴露一个方法，例如 `runResponseRecovery(upstream, env, reason)`，内部找到该 upstream 绑定的 `binding.coordinator` + `binding.candidate` 调用 `coordinator.runRecovery(candidate, reason, env)`，语义类似 `driver.ts:769-845` 现有 `maybeRunHedgedResponseSink` 里"通过 `generation.bindings.get(upstream)` 找回 coordinator/candidate"的既有写法）——成功后返回新的 `{upstream, env}`，handler 用 Task 4.1 的 splice 函数把新流的帧接进同一个 sink。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/precontent-recovery-live.it.test.ts（新，driver 级，先于 handler 级验证机制本身）
test("driver exposes a way to recover a ready-but-pre-content-failed upstream via coordinator.runRecovery, without requiring committedAny", async () => {
  // mock transport：primary 成功 open，但流在首个真实 block 前抛错（stream-error 形状）
  // 断言：调用新的 driver 方法后，能拿到第二个 upstream（recovery 候选），且 coordinator 记录了 runRecovery 的 settle（parent verdict=failed, reason=... ）
})
test("if the primary already delivered a real block before failing, this path is NOT applicable (that's continuation's job, not B2's)", async () => {
  // 断言：hasDeliveredSemanticContent 为 true 时，调用方（handler）不应该走这条路径——这是纯门控测试，非 driver 内部强制
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线** —— `driver.ts` 新增方法（`PipelineDriverWithNonStreaming` 接口扩展），签名草案：

```ts
runResponseRecovery(upstream: UpstreamStream, env: RequestEnvelope, reason: string): Promise<DriverRequestResult>
```

  内部：`const binding = generation.bindings.get(upstream); if (!binding) throw ...; const recovered = await binding.coordinator.runRecovery(binding.candidate, reason, env); generation.bind(binding.coordinator, recovered); return {ok:true, upstream: recovered.upstream, env: recovered.env}`。**这个方法与 Plan-2 Task 0.4 的 `runPreContentRecovery` 是姊妹方法**——前者服务 ready-态失败（有 upstream 引用可查 binding），后者服务 pre-ready 失败（没有 upstream，只能用 driver 闭包记的 `lastPreReadyFailure`）。两者共享 Task 4.1 的同一个 splice 拼接函数与同一个 server-tool gate 检查点，但驱动它们的 coordinator 方法不同（一个新建 `runRecoveryFromPreReadyFailure`，一个复用既有 `runRecovery`）——**实现者必须在这里调用 `classifyServerExecutionRisk` 一次，不要假设 `runRecoveryFromPreReadyFailure` 里已经做过检查就漏了这条路径的检查（两个方法各自独立 gate，不能只查一处）**。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): driver.runResponseRecovery — reuse existing coordinator.runRecovery for ready-but-pre-content live-path failures`。

**buffered 路径的对应接线**（同一 Task 内一并完成，因为复用同一个 `runRecovery` 调用、只是触发点在 `driver.ts` 内部而非 handler）：

- [ ] 在 `runResponseBufferedSink` 的失败判定处（`driver.ts:1361-1399` 附近，现有 `retryable` 分支），**在 `!committedAny` 分支耗尽重试预算、即将走向 `degradeOutcome="exhausted"` 之前**，插入一次 B2 gate 检查（`!hasDeliveredSemanticContent` 在 buffered 场景下等价于 `!committedAny`——**这两者是否完全等价需要实现者用测试确认**：`committedAny` 由 `anthropicCommitBoundaries` 判定"是否有 boundary 被 flush 过"，而 `hasDeliveredSemanticContent` 目前设计读的是 `CandidateBoundaryClassifier.result`——buffered 候选是否也驱动了同一个 boundary classifier 是 Plan-2 Task 0.2 已经标注的验证点，这里再次确认）+ server-tool gate；命中则不走 `degradeOutcome`，而是走 B2 的 splice-recovery（**注意 buffered 场景下 splice 目标不是"接进同一个 live sink"，而是"这次的 fresh attempt 本身重新进入 buffered 缓冲循环"——即 B2 在 buffered 模式下退化成"多给一次重试机会，且这次重试不计入原有 `retryCap` 预算"，本质上是把 `retryCap` 用尽后的最后一击外挂在 buffered 循环外层，而非改写 buffered 循环内部逻辑**）。

**裁决（2026-07-28，已关闭门控）**：buffered 路径不在本 Task 实施，归档至 `docs/todo/deferred-backlog.md`，待 live 路径 Task 4.3/4.5 接线完成后触发。用户已明确 `max_retries=0` 表示“不要任何重试”，因此未来的 buffered B2 外挂旁路必须额外检查 `resolveBufferedCaps(vendor).maxRetries > 0`；该值为 0 时，连 B2 这一次也不得发起。

---

## Task 4.1 / 4.1′：三模式 wire-level splice（首版门面否决后重划为持久 decorator）

> **实施状态（2026-07-29，Task 4.1′ 重划完成，保持零 handler 接线）。** 2026-07-28 首版新增的 `precontent-recovery-splice.ts` 被评审否决：它在 hooks 存在时每帧临时执行 `makeReconcilingSink(...).write(frame)`，只是给 `handler-v4.ts` 同一函数作用域内已经可取得的 `sink`、`anchorHooks`、`anchorState` 再包一层门面；生产 live direct/translate 两条腿本就通过 `liveReconcilingSink` 构造同一个 decorator，不存在层级障碍。首版文件及其测试已删除，历史否决理由保留在此。
>
> 重划后的实际形状是把 `makeReconcilingSink` 的控制面补完整，并在 Task 4.3 由 handler **一次构造、跨首次 attempt 与 fresh recovery attempt 复用同一个实例**。对存在的 `suspendHeartbeat`、`resumeHeartbeat`、`finalize` 原样转发，对缺失方法继续保留 `undefined` 供 feature detection。Task 4.3a 后这些已是活的生产控制面：live driver 的 `close` 经 decorator 到 supervisor，再映射为 `suspendHeartbeat`；fresh recovery 必须通过同一 decorator 显式 `resumeHeartbeat`；pump 内 attempt-local `finalize` 经 decorator 到 supervisor 后被延迟，真正终结归 owner `settleFinal`。buffered 仍使用 raw sink，不经过该控制链。
>
> **2026-07-30 BLOCKER 订正：**“继承 delivery identity”不是透明性补齐，而是破坏性行为变更。delivery session 的 winner 写向构造时捕获的 raw sink；driver 又按传入 sink 对象身份决定走 session 还是 `sink.write` fallback。因此 reconciling decorator 一旦注册 identity，默认 live hedge 胜者会绕过 reconcile，客户端收到第二个 `message_start`、与 open anchor@0 冲突的真实 block@0，且 anchor 永不关闭。修复恢复改前契约：改写/丢弃/重排帧的 decorator **不得继承 delivery identity**；当时仅允许纯 write-pass-through supervisor 继承。**2026-08-06 渐进合并 supersede：master 已引入显式 `wireAllocationPort`，driver 不再需要从 wrapper identity 找 owner；旧 `inheritDownstreamDeliverySession` workaround 与 allowlist 守卫均删除。live winner 通过 raw delivery session 的 allocation port 显式保留归属，同时 rewriting decorator 继续没有 identity。**
>
> 三模式验收已搬到 `tests/anthropic/live-reconcile-cross-attempt.unit.test.ts`，判据只按当前 wire state 命名：无 hooks；hooks 已构造但尚未注入；已注入、无 open anchor；已注入且 open anchor。attempt 边界用例的链序与 Task 4.3 生产链一致：`原始 sink → recovery supervisor → reconciling rewriting decorator`；`close()`/`finalize()` 从最外层 decorator 转发到 supervisor 后被抑制，`settleFinal()` 才到达原始 sink。每例都让同一个 sink 实例先承载首次 attempt 状态，再写 fresh attempt 帧；empty-text close-off 额外锁定方法序列 `writeAnchor → write`，防止手工遍历 `reconcileLiveFrame` 后统一 `sink.write` 丢失 `synthetic:"anchor"` 标记；fresh attempt 再次在真实块前以 `error` 终止时，anchor 必须在 error 前且只关闭一次。模式判据不是 config `streamKeepaliveMode`：`streamKeepaliveEscalateSec > 0` 时即使配置为 ping 也会构造 hooks，是否去重/remap 取决于 `injected` 与 `anchorBlockOpen` 的当前状态。
>
> 下方 2026-07-23 的原始设计步骤与签名草案保留为历史；其中“新增 per-frame splice 门面”已被本段取代，不再执行。

**设计依据（实测表，FINDINGS.md 逐字摘录）：**

| mode | 已发脚手架 | fresh attempt 拼接规则 |
|---|---|---|
| `ping`（默认） | 裸 `event: ping` | fresh `message_start` 原样成首 message，real block 原 index |
| `enveloped_ping` | synthetic/已捕获 message_start、无 anchor | 丢弃 duplicate message_start；real block 原 index |
| `empty_text` | message_start + anchor `content_block_start@0` + 空 delta | 首 real block 前写 `content_block_stop@0`；丢 dup message_start；real block index +1；失败/终止在首 real block 前也须先 close anchor |

这与 `live-reconcile.ts` 的 `reconcileLiveFrame` 是**同构问题**（"给定 AnchorState + AnchorHooks，决定要不要 drop message_start / 要不要先关 anchor / 要不要 remap index"）——但 `reconcileLiveFrame` 是逐帧增量应用在"仍在同一条上游流"上，B2 面对的是"上游流已经彻底断了、要接一条全新的流"，语义上更接近"一次性重放 `reconcileLiveFrame` 的判定逻辑作用在 fresh attempt 的第一帧上，之后转入正常透传"。

**推荐实现路径**：复用 `AnchorState` + `AnchorHooks` + `reconcileLiveFrame`（`~/lib/anthropic/live-reconcile`），不重新发明一套判定逻辑——fresh attempt 开始后的第一帧仍然过一次 `reconcileLiveFrame(frame, anchorState, anchorHooks)`（这个函数已经处理了"dedup message_start"、"要不要先 close anchor"、"要不要 remap"的全部三模式分支），之后的帧走正常 `write`。`closeAnchorIfOpen`（导出自 `~/lib/anthropic/keepalive-anchor`，`keepalive-anchor.ts:178`，`handler-v4.ts` 已在多处导入使用）可直接复用于"recovery 也失败、需要在写终态错误帧前收口 anchor"的场景（Task 4.1 的第 4 个测试用例）。**唯一需要新增的**是：ping 模式下 `anchorHooks` 是 `undefined`（`buildAnthropicAnchorHooks(enabled=false)` 见 `handler-v4.ts:968-970`），此时 `reconcileLiveFrame` 根本不会被调用到（因为 `liveReconcilingSink` 在 `anchorHooks` 为 undefined 时直接返回原始 sink，`handler-v4.ts:1148-1150`）——**验证清单**：确认 ping 模式下"fresh message_start 直接透传成为首帧"这一实测行为，是否只需要"不做任何特殊处理、直接把 fresh attempt 的帧一帧帧 write 出去"就自然成立（FINDINGS 的 SDK 探针已经验证了这一点：`ping → fresh message_start → text@0` 场景下 SDK 正确累积，说明 Anthropic SDK 本身不介意收到"心跳 ping 之后来一个全新 message_start"——这是**协议层面**的宽容性，不是我方代码要做什么特殊处理）。

- [ ] **Step 1: 写失败测试** —— 三模式分别验证

```ts
// tests/routes/messages/precontent-recovery-splice.unit.test.ts
test("ping mode: fresh message_start passes through untouched (no anchor state involved)", () => {
  // 用 makeArraySink 收集写出的帧；驱动 spliceFreshAttemptFrames 走 ping 模式
  // 断言：fresh attempt 的 message_start / content_block_start 等帧原样写出，无 remap
})
test("enveloped_ping mode: duplicate message_start from fresh attempt is dropped; real blocks keep original index", () => {
  // anchorState.injected = true, anchorState.anchorBlockOpen = false（enveloped_ping 特征）
  // 断言 fresh attempt 的 message_start 帧被丢弃，第一个 content_block_start 保持原 index
})
test("empty_text mode: anchor is closed (content_block_stop@0) before the first real block; real block index shifts +1", () => {
  // anchorState.injected = true, anchorState.anchorBlockOpen = true, anchorState.anchorClosed = false
  // 断言输出序列包含 stopFrame（先于任何真实 block），且真实 block 的 index 被 remap +1
})
test("empty_text mode: if the SECOND fresh dispatch ALSO fails before any real block, the anchor is STILL closed before the terminal error frame", () => {
  // 覆盖 FINDINGS 明确点名的 corner case："失败/终止在首 real block 前也须先 close anchor"
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** `src/routes/messages/precontent-recovery-splice.ts`：**不重新发明判定逻辑**，直接复用 `reconcileLiveFrame` + 已有的 `AnchorState`/`AnchorHooks` 类型（从 `~/lib/pipeline/types` 导入）、`closeAnchorIfOpen`（已有，`~/lib/anthropic/keepalive-anchor` 或 `handler-v4.ts` 引用处，需确认导出位置）。函数签名草案（局部签名，不改公共类型）：

```ts
/** 把 fresh recovery attempt 的每一帧，按现有 anchor 状态过一次 reconcile，再交给 supervisor 包装的 sink 写出。
 *  纯粹复用 live-reconcile 的既有判定——不是重新发明协议逻辑。 */
export async function spliceFreshAttemptFrame(
  frame: ClientFrame,
  sink: ClientSink,
  anchorState: AnchorState,
  anchorHooks: AnchorHooks | undefined,
): Promise<void> {
  if (!anchorHooks) {
    await sink.write(frame) // ping 模式：anchorHooks 恒 undefined，直通
    return
  }
  const frames = reconcileLiveFrame(frame, anchorState, anchorHooks)
  for (const f of frames) await sink.write(f)
}
```

  **验证清单**：`reconcileLiveFrame` 目前的隐含假设是"这是同一条直播流的增量帧"（例如 `messageStartForwarded` 状态在"没注入过 anchor"时的 passthrough 分支里也会被设置，`live-reconcile.ts:108-116`）——需要实现者用测试确认，当 fresh attempt 的第一帧是 `message_start` 且 `anchorState.injected === true`（因为原 attempt 确实注入过 keepalive）时，`reconcileLiveFrame` 会正确地把这第二个 message_start 识别为"重复"并丢弃（这是 P4 存在的核心理由——FINDINGS 的 SDK 探针场景 2/3/4 已经验证了这个丢弃行为，本 Task 只是把它包装成生产代码路径，理论上应该直接复用即可，不应该出现意外分歧；若测试跑出分歧，说明 `reconcileLiveFrame` 需要扩展一个新分支而非本函数绕过它）。

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(anthropic): precontent-recovery splice reuses live-reconcile anchor judgment for fresh attempt frames`。

---

## Task 4.2：触发判定 `shouldAttemptPreContentRecovery`

> **实施状态（2026-07-30）：已完成，保持零 handler 接线。** 新增 `src/routes/messages/precontent-recovery-gate.ts` 的纯函数 `shouldAttemptPreContentRecovery`，显式接收 failure class、**必填且从 raw sink 解析的** delivery session 与运行时 `preContentRecovery` 配置。确定性 `http-error` / `network-error` 仅在配置开启且 `hasDeliveredSemanticContent(session) === false` 时返回 true；`abort` 直接接收 handler 已算好的 `PostCommitAbortKind`，避免从同一对 signal 重复派生双源值，`client-abort` / `reaper-cancel` / `timeout` 三类全部返回 false。外层 failure 与内层 abort 都用穷尽 switch + `satisfies never`，未知形态 fail-closed。后两类排除由用户硬约束 `never-false-kill-legit-thinking` 授权（见本计划 README Global Constraints）：连接可能仍在合法长思考，不是“暂不支持”，放宽必须重新取得用户裁决。相对原草案的签名细化是新增显式 failure discriminated union，因为纯 gate 必须区分确定性上游死亡与三个 AbortError 子类；没有引入第四套判据。unit 测试覆盖纯组合并进入默认 `bun run test`，integration 测试用真实 production delivery sink 构造“delta 已交付但 `content_block_stop` 未到”状态，并以临时改读 `boundary.result` 的 mutation 证测试会红，锁定 gate 继续读取 delivery-level `hasEmittedRealClientContent`。另用 4.1′ 改写 decorator 证明 decorated sink 按设计解析不到 session；运行时 guard 对误传的 `undefined` fail-closed，漏救一次优先于重复内容。六类初始验收均完成独立正样本 mutation。

- [x] **Step 1: 写失败测试**

```ts
test("returns true when: not client-abort AND no semantic content delivered AND config enabled", () => { ... })
test("returns false when client already aborted (client-abort takes precedence, no point recovering)", () => { ... })
test("returns false when semantic content already delivered (this is exactly the existing continuation-retry's job, not B2's)", () => { ... })
test("returns false when config.preContentRecovery.enabled === false", () => { ... })
```

- [x] **Step 2: 跑，失败。**
- [x] **Step 3: 实现**（纯函数，组合 Plan-2 的 `hasDeliveredSemanticContent` + `state.preContentRecovery.enabled` + `classifyPostCommitAbort`；冻结范围要求三个 abort 子类全部排除，不只 client-abort）。
- [x] **Step 4: 跑，通过。**
- [x] **Step 5: 提交** → `feat(anthropic): add precontent recovery trigger gate`。

---

## Task 4.3：handler-v4.ts 接线（COMMIT 分支 catch 块）

> **Task 4.3 已完成（2026-08-08）。** 两个 streaming owner（settled-within-window 与 delayed-commit）在 `makeAnchoredSseSink` 后调用独立模块 `precontent-recovery-sink-chain.ts`，一次构造并持有 `raw delivery → recovery supervisor → live reconciling rewriting decorator`；该模块独占 `makeReconcilingSink` 能力，handler 不直接现造。链从 raw sink 解析并单独持有 `DownstreamDeliverySession`，暴露三个持久端口：raw sink 供 buffered driver（buffered 旁路仍暂缓，保留其原生 close/finalize 围栏）；supervisor sink 供 live terminal writes；reconciling sink 供 direct-live。三者共享 raw delivery 与 `AnchorState`。live driver 的 `close()` 由 supervisor 映射为 recoverable `suspendHeartbeat()`；fresh R 在消费前由 controller 显式 `resumeHeartbeat()`，缺失该调用的 mutation 已证会失去 recovery 静默期 keepalive。owner `finally` 以嵌套 `try/finally` await `sinkChain.settleFinal()` 后必执行 `detachClientAbort()`；中途抛出也关闭 heartbeat、等待异步 finalize 且不泄漏监听器。`ClientSink.finalize` 已收紧为 `void | Promise<void>`，生产调用点显式 await；live pump 内 finalize 被 supervisor 吞掉，真正终结只在 owner settleFinal。架构守卫按 `ts.resolveModuleName` 后的模块目标只允许 chain 模块 import rewriting capability，并在该模块内锁定 factory owner + raw delivery lookup；handler 仅验证两个 owner 创建/settle 链。guard 不比较 buffered 实参源码文本，故 `opts.rawSink` 等价改写不误报；`makeReconcilingSink` 直用必须新增非法 import 并被守卫拦截。direct recovery 接线只调用 `shouldAttemptPreContentRecovery`、`runPreContentRecovery`/`runResponseRecovery` 和 evaluator/publication controller；translated publication 未接。

> **挂载裁决 A（主会话 2026-07-30，已定）：** gate 保持在 `handler-v4.ts:707-726` 的 `isAbortError` 块之后；该块三个 abort 子分支全部自行 return，因此 `{kind:"abort"}` 当前没有生产构造者，只作为纯防御与 `satisfies never` 穷尽性锚点。未选 B（把 gate 上提到 abort 块之前统一裁决），因为三类 abort 在两种拓扑下都返回 false，重排微妙 catch 结构没有行为收益。若 4.3 实施中发现统一裁决确实更清晰，须回主会话请求改判，不得自行切换。
>
> **前置约束（Task 4.1′ / 4.2 review 后冻结；2026-08-06 适配 master allocation owner）：** Task 4.3 必须复用同一个 reconciling decorator，但不得让它继承 delivery identity。**wrapper identity 继承 API 已被 master 的显式 `wireAllocationPort` 取代并删除**：chain 从 raw sink 解析一次 delivery session，向 driver 与 reconciling decorator 都显式传同一个 `deliverySession.allocationPort`；绝不能从 supervisor/reconciling 装饰链反查。观测不到 raw delivery session 必须 fail-closed，否则同一条已交付流会被误判为可恢复。生产验收必须同时跑 hedge 开/关两组，锁住 winner、anchor close 与 remap 仍经 owner/reconcile 的正确次序。

**范围裁定（用户 2026-07-23 已定，不再是 open）：** `reaper-cancel` 与 `timeout`（header-wait）**排除出 B2**——用户硬约束「**绝不误杀合法长思考**」：这两类失败发生时上游连接可能仍活、上游可能正在合法 heavy-thinking（deferred-header 无上界），对其 re-dispatch 会从头重算 = **放弃并误杀正在进行的合法思考**。挂起请求本就会被 GHC 网关在 126-206s 自行 `rstCode=0`（确定性失败）终止，届时走 B2-on-RST 救援即可——不需要、也不允许用 timeout 去猜 A/B。
- **本计划裁定设计**：`shouldAttemptPreContentRecovery` 只对 **HTTPError 分支** 和 **network_error 类（非 HTTPError 的 catch 分支，含 socket reset/RST/transport-close）** 生效；`isAbortError` 的三个子分支（client-abort / reaper-cancel / timeout）**都不触发 B2**——client-abort 是客户端已走、reaper-cancel/timeout 是「连接可能仍活、上游可能在思考」（误杀风险）。这是**确定性上游死亡才重发**原则的直接落地。
- 见 README Global Constraints 的 `never-false-kill-legit-thinking` 硬约束。

- [x] **Step 1: 写失败测试**（实施完成；以下保留原始最小验收形状）

```ts
// tests/routes/messages/precontent-recovery-matrix.it.test.ts（起步，本 Task 只覆盖第一行）
test("COMMIT branch: HTTPError before any real content block → fresh recovery dispatch is attempted, and succeeds", async () => {
  // sequencedUpstream([() => httpErrorResponse(529, {...}), () => createSseResponse([msgStart, textBlock, terminal])])
  // 驱动 delayed-commit（streamCommitAfterSec 极小或 FakeClock 强制 commit）
  // 断言：客户端最终收到 ONE coherent turn（首个 HTTPError 从未到达客户端 —— 只有合成 keepalive + 拼接后的真实内容）
  // 断言：up.callCount() === 2（第一次失败 + fresh recovery 成功）
})
```

- [x] **Step 2: 跑，失败。**
- [x] **Step 3: 接线** —— 实际实现以 evaluator → owner batch publication 取代下方历史伪代码；在 `handler-v4.ts` 的 COMMIT 分支内层 `catch (error)` 块顶部，`isAbortError` 分支之前/之后（取决于哪种顺序更清晰——建议放在 `isAbortError` 检查之后、`HTTPError` 检查内部与新的 catch-all 分支内部，即两处都要加）新增：

```ts
// 伪代码骨架，实现者需按 Plan-2 的 supervisor/gate 实际签名调整
const ctx = codec.getContext()
ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })
if (error instanceof Error && isAbortError(error)) {
  // ... 现有三分支不变（client-abort / reaper-cancel / timeout）
}
if (shouldAttemptPreContentRecovery({ error, session: anthropicCandidateSnapshotSafe(driver, /* 需要 upstream 引用，pre-ready 场景没有 */), config: state.preContentRecovery })) {
  try {
    const recovered = await driver.runPreContentRecovery("post-commit-pre-content-failure")
    if (recovered.ok) {
      // 把 fresh attempt 的帧写进**同一条已构造好的 sink 链**（见下方 4 与 Task 4.1′ 的实施状态）
      // 复用 pumpAnthropicStreamingDispatch 的现有帧循环——需要重构成可传入该 sink 的形态
      // 成功 → 正常走完 pump，最终由 supervisor.settleFinal() 收口
      return
    }
    // recovered.ok===false（decideRoute reject，理论上不该发生在 recovery 路径——记录 warning）
  } catch (recoveryError) {
    // fresh recovery 本身也失败（或被 server-tool gate 拦截）→ 落回现有 writeTerminalThenSettle 路径
    // 用 recoveryError 而非原始 error 构造终态错误帧？还是原始 error？—— 待 TDD 定，倾向原始 error
    // （recoveryError 是内部机制失败，客户端不关心"我们尝试救援又失败了"的细节，只关心最终错误类型）
  }
}
// 现有 HTTPError / 其余分支逻辑不变（recovery 未触发或 recovery 失败后落到这里）
```

  **这段接线是本计划复杂度最高的单点**，实现者必须：
  1. 先确认 `pumpAnthropicStreamingDispatch` 现有的帧循环能否被抽出一个"给定 upstream+env+sink，跑到底"的可复用子函数，供"首次 attempt"和"fresh recovery attempt"两处调用（**不要复制粘贴一份新的循环**——DRY，且降低两处逻辑分叉导致的维护负担）。
  2. 确认 `anchorState`/`anchorHooks` 在 recovery 场景下必须是**同一个** `AnchorState` 实例（不能重新 `{injected:false, ...}` 初始化）——因为 anchor 是否已经注入过是"首次 attempt 期间"就确定的状态，fresh attempt 只是"接着用"。
  3. 确认 recovery 成功之后的 sink 收口时机——用 Plan-2 Task 0.5 的 supervisor，只有 fresh attempt 走完（`outcome.kind === "complete"`）才调 `supervisor.settleFinal()`。
  4. **sink 链只构造一次、primary 与 fresh recovery 共用同一实例**（Task 4.1′ 定稿的形状，取代首版的 per-frame 门面）：`原始 sink` → `createRecoverySinkSupervisor(...)`（跨 attempt 抑制局部 `close`/`finalize`）→ `liveReconcilingSink(supervised, anchorHooks, anchorState)`。`liveReconcilingSink` 是共享的**改写型** decorator（rewriting，非 pass-through，故不继承 delivery identity）。COMMIT 分支的 post-commit catch 在 `handler-v4.ts:660-760`，其 `sink`/`anchorHooks`/`anchorState` 来自 `:645` 的 `makeAnchoredSseSink` 解构；当前“已构造好的 sink 链”在 catch 中尚不存在，因为 reconciling decorator 只在 pump 内 `:1361` 的实参位置临时创建、无人持有。Task 4.3 必须先把 supervisor 与 reconciling decorator 的一次性构造上提到 `:645` 附近，再把同一实例向 primary pump 与 fresh recovery pump 穿参。**不要**在恢复路径另造 decorator 或另包一层 helper。已删除的 `spliceFreshAttemptFrame` 不存在，别再引用。

- [x] **Step 4: 跑，通过。**
- [x] **Step 5: 提交** → 实际 publication/finalization 由 Task 4 fix commits 与 Task 5 test commits 收口，提交谱系与 mutation 证据见 [tracked implementation report](task-4.3b-implementation-report.md)。

---

## Task 4.4：History settlement（新 attempt + verdict 语义）

**实施状态（2026-08-08）：完成。** P/R 的 evaluator disposition 是唯一 async settlement port；complete R 在 publication 成功后才 commit/winner，discarded/non-complete R 的 dispatch 与 candidate 都失败且不抢 P terminal。fresh R 的 initial dispatch 显式携带 `precontent-recovery` strategy，故 success/fallback 的 V2 `currentStrategy` 与 V3 dispatch 在同一语义上对齐。`RequestContext.toHistoryEntry()` 的 canonical selector 读取 pinned terminal attempt，而非最后 active R；History selector mutation 已在 context oracle 变红，C4 dual-read handler oracle 进一步锁住 V2 entry 与 immutable V3 terminal record 的 P/R 归属。以下是原始计划步骤，保留其设计依据。

**设计依据：** `runPreContentRecovery` 内部调用 `coordinator.runRecoveryFromPreReadyFailure`，这本身已经通过 `createCandidateRuntime` → `input.recording.beginCandidate` 走了标准的 History candidate 记录路径（`candidate.ts:70`）——**大部分 History 接线是"免费"的**（复用了 `DispatchRecordingPort` 现有机制）。需要新增的只是：① 首次失败的 attempt 上打一个可诊断的 reason 标记（例如 `recordAttemptFailure({ willRetry: true, nextStrategy: "precontent-recovery" })`，镜像 continuation 的 `"continuation"` nextStrategy 用法，见 `driver.ts:1443`）；② winner 候选正常走 `env.ctx.selectGenerationWinner(...)`。

**Task 4.0 的 `runResponseRecovery`（ready-态挂载点）复用的是既有 `coordinator.runRecovery`——那条路径本身已经在 `settleDispatch` 里传 `retryNextStrategy`（见 `coordinator.ts:136` `runRecovery` 内部 `settleDispatch({ verdict: "discarded", reason, retryNextStrategy: "buffered-retry" })`）打了 History 标记，但这个既有标记写死是 `"buffered-retry"` 字面量——** B2 在 ready-态触发时，若继续用这个字面量，History 上会把"B2 pre-content 恢复"误标成"buffered-retry"，造成诊断混淆。**需要给 `runRecovery` 增加一个可选的 `retryNextStrategy` 覆盖参数**（局部签名扩展，不改调用方既有行为——现有 buffered 路径调用 `runRecovery(parent, reason, env)` 不传这个新参数时保持 `"buffered-retry"` 字面量不变），B2 的调用点显式传 `"precontent-recovery"`。

**Task 4.3 接线后的 per-attempt 簿记待核项**：现有 buffered 路径在调用 `runRecovery` 前会依次执行 `commitAttemptSseEvents()`、`finalizeCurrentAttemptDuration()`、`resetSseEvents()`（并夹带同族 reset hook），以免失败 attempt 的上游原始帧被下一 attempt 覆盖、`durationMs` 停在 0；Task 4.0 的 `runResponseRecovery` 当前不做这些调用。Task 4.3 的实际挂载形态落定后，Task 4.4 必须核实簿记应由 handler 在调用前完成，还是下沉到 driver 的 recovery seam，并补 History oracle 锁住首个失败 attempt 的原始帧与非零 duration。验证必须做正样本对照：临时注入“省略 commit/finalize/reset”的 bug，确认测试确实变红，再恢复为绿；本 Task 不提前改代码。

- [x] **Step 1: 写失败测试**

```ts
// tests/routes/messages/precontent-recovery-matrix.it.test.ts（追加）
test("History: the failed pre-ready attempt is recorded with nextStrategy='precontent-recovery'; the fresh attempt is the winner", async () => {
  // 驱动 recovery 成功场景；起 createFullTestApp，请求后读 History entry
  // 断言 attempts[0]（首次失败）有 willRetry:true, nextStrategy:"precontent-recovery"
  // 断言 attempts[1]（fresh recovery）是 winner（selectedGenerationDispatch 指向它）
  // 断言 upstreamResponse 轨（首次失败 attempt）忠实记录了真实的失败字节（无合成物污染）
})
```

- [x] **Step 2: 跑，失败。**
- [x] **Step 3: 接线** —— 实际实现把 commit/discard 收口为 evaluator disposition，并在 handler publication outcome 处分配 terminal；下方旧 `recordAttemptFailure` 草案仅保留设计背景。
- [x] **Step 4: 跑，通过。**
- [x] **Step 5: 提交** → 由 Task 4 settlement fixes 与 Task 5 History/mutation tests 收口，具体提交与 C4 dual-read evidence 见 [tracked implementation report](task-4.3b-implementation-report.md)。

---

## Task 4.5：协议级回归矩阵（三模式 × 5 种失败形态）

**实施状态（HEAD `dd79edb3`）：实现/测试资产完成，最终门进行中。** `tests/routes/messages/precontent-recovery-matrix.it.test.ts` 以真实 handler 覆盖 pre-ready/ready-live、three-mode、non-complete R、owner C9 failure、abort producer、budget、History 与 ready-live clean EOF；C4 dual-read cases 分别在 empty-text R success 与 fallback 下对账 V2 entry 和 terminal-bus canonical V3 record。`tests/e2e-client/precontent-recovery.it.test.ts` 用离线 mock upstream + in-process proxy 驱动真实 `@anthropic-ai/sdk` `.messages.stream(...).finalMessage()`，并覆盖 clean EOF recovery。mutation、恢复门和精确命令已移入 [Task 4.3b 实施报告](task-4.3b-implementation-report.md)，本 plan 不重复长表。以下是原始矩阵设计步骤，保留为覆盖意图。

**这是 FINDINGS 明确要求的"必须新建"第 4 件机件**——覆盖 primary failure / recovery failure / abort / header-timeout / budget exhaustion，跨三种 keepalive mode。

- [x] **Step 1: 写失败测试**（真实 matrix 以 table-driven cases 展开，避免复制 handler setup）

```ts
// tests/routes/messages/precontent-recovery-matrix.it.test.ts（完整矩阵）
const MODES = ["ping", "enveloped_ping", "empty_text"] as const
for (const mode of MODES) {
  describe(`precontent-recovery matrix — mode=${mode}`, () => {
    test("primary pre-content failure → recovery succeeds → ONE coherent client turn", async () => { ... })
    test("primary pre-content failure → recovery ALSO fails pre-content → terminal error frame (no infinite retry)", async () => { ... })
    test("client aborts DURING the recovery fresh dispatch → settled-abort, zero further bytes, no dangling recovery candidate", async () => { ... })
    test("recovery fresh dispatch hits response-header-timeout → falls through to existing timeout error frame (not an infinite wait)", async () => { ... })
    test("recovery is gated OFF by server-execution-risk → falls through to existing terminal error immediately (no fresh dispatch attempted)", async () => { ... })
  })
}
test("generation-budget exhaustion: repeated pre-content failures across MULTIPLE requests do not leak candidate/dispatch reservations", async () => {
  // 复用 tests/pipeline/candidate-runtime.it.test.ts 的 budget 断言风格
})
```

- [x] **Step 2: 跑，失败（mutation 已实际执行）：**
  - **预测**：ping/enveloped_ping/empty_text 三模式的"recovery 成功"场景，删除 Task 4.1 的 splice 分支判断会让 empty_text 场景出现"客户端收到两个 message_start"或"index 冲突"的可观测失败——**这个预测可能不咬**（若 `reconcileLiveFrame` 的既有防护已经足够健壮，删除 splice 分支可能只是退化成"透传"而非"崩溃"）；执行期必须真跑一次删除 Task 4.1 实现后的红色状态确认，若不咬，说明测试断言粒度不够，需要加严（比如显式断言 index 序列而非只断言最终内容正确）。
- [x] **Step 3-5**：随 Task 4.1-4.4 的实现逐步补齐；当前 direct-live matrix 已绿，最终 backend/review 仍未完成。
- [x] **提交** → matrix 与 SDK coverage 已分阶段提交，具体谱系、C4 dual-read 与 mutation coverage 见 [tracked implementation report](task-4.3b-implementation-report.md)。

---

## 已实施任务状态（HEAD `dd79edb3`）

| 任务 | 状态 | 实际交付 |
|---|---|---|
| 4.3 direct handler 接线 | ✅ | pre-ready、ready transport close 与 ready clean EOF before semantic content 共享 evaluator/publication；确定性 death gate 之后才发 R，abort 直接终结。 |
| 4.4 History settlement | ✅ | evaluator result 有唯一 async disposition；discard/commit 与 generation dispatch/candidate 同步结算，terminal projection 选择 pinned terminal attempt 而非最后 active attempt。 |
| 4.5 协议与 SDK资产 | 🔄 | handler matrix、SDK、three-mode wire、abort/budget、History 与 clean EOF 已覆盖；C5 mutation table 中没有持久化 red evidence 的项仍待重跑，见实施报告。 |
| buffered B2 | ⏳ backlog | 不在 live owner batch 中旁路，保持现有 buffered retry 语义与 `max_retries=0` 裁决。 |
| translated B2 publication | ⏳ deferred | evaluator 可识别/处置 translate candidate，但没有将 translated R 写入 direct Anthropic recovery wire；保持 fail-closed。 |
| Task 5 总体验收 | 🔄 | 实现/测试资产完成；独立复评与 `bun run test:backend` 最终门进行中。 |

## 验收 Oracle（本阶段整体）

- `bun run test:backend`：**Task 5 最终门，尚未运行**；不得以 focused suite 替代。完成前必须在目标 commit 运行并记录退出码。
- `tests/e2e-client/precontent-recovery.it.test.ts`：真 SDK oracle，以 `.finalMessage()`、internal call count 与最终文本验证完整 turn；SDK parser acceptance 不替代 wire order/index oracle。
- History terminal 与 three-mode wire contract 均由独立 handler/context oracle 覆盖。
- 可复现命令、mutation red/restore 判据与 clean EOF 证据统一见 [Task 4.3b 实施报告](task-4.3b-implementation-report.md)。

## 风险

- **最高风险**：Task 4.3 的 handler 接线（帧循环复用 + supervisor 收口时机）——涉及现有 900+ 行 handler 文件的精细手术，任何时序错误都可能导致 sink 提前关闭或计时器泄漏。**强烈建议**：这个 Task 由实现者独立开一个 review 轮次（异模型 subagent 复核 sink 生命周期的每个分支，尤其 `finally` 块与 supervisor 的交互）。
- **同等高风险**：Task 4.0 的第二挂载点（live 路径 `stream-error` 分支复用 `runRecovery`）——这是一条**现状完全没有重试机制**的路径，新增重试行为本身就有较大回归面（尤其 `acc`/`streamState`/`sseEvents` 这些 handler 本地累积状态在"换一条新 upstream 流"后要不要重置——Plan-2 Task 0.5 的 sink supervisor 只管 sink 生命周期，不管这些 handler 本地累积器，需要实现者在 Task 4.0 里一并设计"recovery 后 accumulator 是否要 rebind 到新 candidate session"，参照 buffered 路径 `onAttemptReset` 的既有模式）。
- **次高风险**：`reconcileLiveFrame` 复用是否真的"零改动可用"，还是需要扩展新分支——Task 4.1 的验证清单已经点名，执行期若发现分歧，允许在 `live-reconcile.ts` 里新增分支（这是"细化已接受架构合同"范围内的局部扩展，不是新架构决策），但**不要**在 splice 函数里重新发明一套平行逻辑。
- **范围风险**：Task 4.0 的 buffered 子任务若实现期发现复杂度失控，允许降级为 backlog（已在 Task 4.0 末尾列出门控问题）——但 live 路径必须完整交付，不能同样降级（否则原始事故 req_57/58/63 的形状——live 路径 pre-ready + ready-态两种失败——救不全）。

## 未采纳方案

- **B2 fresh dispatch 参与竞速（B5 化）**：spec/FINDINGS 已明确 B2 是串行救援，B5（并发赌）是独立备选、非本计划范围——本阶段严格保持串行（`runPreContentRecovery` 是 `await`，不是 race）。
- **恢复失败后再重试第二次**：spec 明确"一次全新上游 dispatch"，未提及多次重试的预算设计——本计划遵循"恰好一次"，若用户希望支持"最多 N 次 pre-content 重试"，需要回到 spec 层面明确 budget 语义（这不是实现细节，是新的架构决策，交主会话）。
