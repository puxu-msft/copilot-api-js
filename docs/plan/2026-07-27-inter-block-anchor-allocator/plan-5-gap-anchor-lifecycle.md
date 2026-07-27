# P5 — gap anchor 生命周期（per-gap latch + close-before-real）

> **本文件是合并相位 P3M 的一部分**（round-3 blocker：原 P3/P4/P5 在测试可满足性上不可分）。相位权威 = [plan-3-remap-sites.md](plan-3-remap-sites.md)，本文件提供 **M1 / M6 / M7 / M8** 的任务细节。
> **相位内前置**：M1（可重复 anchor 生命周期，本文件「AnchorState 状态机」小节所定义的能力**前移到 M1** 落地）；M6 起的特性开门必须晚于 M2–M4。
> **承重项 5 + 6**。这是 A 真正闭合 >300s 门的部分；其余 M 步都是它的地基。

## 当前门的精确位置（`fix/client-proxy-keepalive-300s` 分支）

`delivery/session.ts` 的 `tickHeartbeat` 里：

```ts
// Fixed anchor@0 is valid only before any real block has completed. After the first
// committed block, a no-open window needs the future monotone index allocator; reusing
// index 0 would make the SDK reorder content. Until that design lands, stay on ping.
if (pendingOpenBlocks.length === 0 && semanticBlockCount === 0 && heartbeat.injectContentScaffold && !contentScaffoldAttempted) {
```

两个要拆的条件：
1. `semanticBlockCount === 0` —— **就是本相位要删的门**（其注释明写解除条件是本 allocator）。
2. `!contentScaffoldAttempted` —— **一次性 latch**，要改为 per-gap 重新武装（承重项 5）。

## Files

- Modify: `src/lib/pipeline/delivery/session.ts`（删 `semanticBlockCount===0` 门；`contentScaffoldAttempted` 改 per-gap；gap injector 的调用）
- Modify: `src/lib/anthropic/keepalive-anchor.ts`（新增**轻量 gap injector**：只 start+delta，无 message_start）
- Modify: `src/routes/messages/handler-v4.ts`（接线 gap injector）
- Modify: `src/lib/pipeline/driver.ts`（close-before-real 覆盖 gap anchor，非仅 pre-content anchor）
- Modify: `src/lib/pipeline/types.ts`（`AnchorState`：**删除** `anchorClosed` 与 `anchorBlockOpen`，新增 `openAnchorIndex?: number`——见下方「状态机（已冻结）」）
- Test: 新 `tests/pipeline/gap-anchor-lifecycle.it.test.ts`

## `AnchorState` 状态机（**已冻结**——plan review major：原文三处语义互相矛盾）

原 plan 对 `anchorClosed` 给了三种互斥说法（Files 说改为「当前 anchor 是否已关」、语义表说保留为「终局收口是否已做」、Task 5.2 又说终局也用 `openAnchorIndex` 幂等）。三者不能同时成立：多 anchor 下若 `anchorClosed` 在第一次 gap close 后永久为 true，后续终局 close 会被短路；若每个 gap 重置，它就不能充当整请求的终局 once guard；若 `openAnchorIndex` 已是唯一判据，`anchorClosed` 就是残留双轨。

**冻结裁决：`openAnchorIndex` 单一承担 per-anchor 与终局幂等；`anchorClosed`/`anchorBlockOpen` 退役。**

> **退役的时点（round-4 blocker 修正）**：这两个字段在 **M1 不删**——未迁移的 S2/S3 直接读它们，立删会当场编译红。M1 只**新增** `openAnchorIndex` 与 `closeOpenAnchor`，并由 owner 在 open/close 时**一并维护旧字段**（迁移期双写），旧分支照常工作；**删除下沉到 M5**（那时三腿已迁完，无消费者）。详见 plan-3「M1 的迁移 bridge」。

现有字段是为**单个 pre-content anchor** 设计的：

- `anchorBlockOpen`（`types.ts:444` 注释明写 "stays TRUE for the whole stream once set"）——其实是「本 generation 用过 anchor 吗」的历史标志，**不是**「当前有 anchor open 吗」。
- `anchorClosed`——universal 幂等守卫，跨全部 close-off 站点，**一次性**。

多 anchor 下这两个都不够用。冻结后的状态机：

| 概念 | 字段 | 语义 | 写者 | 读者 |
|---|---|---|---|---|
| 本 generation 用过 anchor 吗 | `allocator.anchorsOpened() > 0` | 单调计数，仅诊断/断言用；**不再是 remap 判据**（C3 修订） | allocator | 诊断、测试 |
| **当前**有 anchor open 吗 | `openAnchorIndex?: number` | `undefined → index → undefined` 的转移**同时**承担 per-anchor 关闭与终局 once guard：关闭时置 `undefined`，第二个调用者见 `undefined` 即短路 | gap injector（开）、三处 close-before-real + 各终局站点（关） | 同左 |
| 终局收口是否已做 | **无独立字段** | 由 `openAnchorIndex === undefined` 表达 | — | — |

**`anchorBlockOpen` 与 `anchorClosed` 最终一并删除**（项目「不留双轨包袱」）——但删除动作在 **M5**，非 M1。届时 grep 全站点逐处清理（`rg -n "anchorBlockOpen|anchorClosed" src/ tests/`），类型系统会逼出全部站点。

**exactly-once 测试要求**（本相位必须有）：终局 close-off 有多个潜在调用者——`closeAnchorIfOpen`（`keepalive-anchor.ts:178`）、driver 的终端 close-off（`driver.ts:1105`）、pump 的多个终端分支（`handler-v4.ts:1325/1423/1450/1503/1606/1644/1688`）。必须有一条测试**枚举这些站点两两组合**（或至少覆盖「driver 先关 + pump 后关」「pump 先关 + driver 后关」两序），断言客户端**恰好收到一个** `content_block_stop@anchorIdx`。

> 若实施中发现确实需要一个 generation-terminal 标志（例如某终局站点需区分「anchor 关了」与「整个请求收口了」），**另起名** `terminalClosing` / `terminalClosed`，并在此表补齐其全部写者/读者 + exactly-once 测试——**不得**复活 `anchorClosed` 的模糊语义。

---

## Task 5.1：per-gap latch（承重项 5）

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/gap-anchor-lifecycle.it.test.ts
test("the content anchor latch re-arms per gap: N gaps produce N anchors", async () => {
  // delivery session + contentDeadlineMs=200_000，FakeClock：
  //   过 deadline → gap anchor #1 → 真实块（关 anchor）→ 再过 deadline → gap anchor #2 → 真实块
  // 断言 scaffoldCalls === 2（今天是 1：一次性 latch）
})
```

- [ ] **Step 2**：跑，红（当前 `contentScaffoldAttempted` 一次性）。
- [ ] **Step 3**：实现——latch 在「真实块开启」时重新武装（`applyPendingFrame` 见到非 synthetic 的 `content_block_start` 时 `contentScaffoldAttempted = false`）。**注意**：不要在「anchor 关闭」时重置——那样心跳可能在同一 gap 内连开多个 anchor。判据是「有过新真实内容」而非「anchor 关了」。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5: 提交** → `feat(keepalive): re-arm the content anchor latch once per gap`

## Task 5.2：close-before-real 覆盖 gap anchor（承重项 6 / C2）

- [ ] **Step 1: 写失败测试**

```ts
test("a gap anchor is closed BEFORE the next real content_block_start", async () => {
  // 同上场景，用 producer harness 收全部客户端帧
  assertBlockProtocolState(frames)       // O-2（升级后：含 delta/stop 归属 + 终局无悬挂）
  // 且精确断言 stop@gapIdx 出现在 start@nextRealIdx 之前
})
test("the anchor stop is emitted EXACTLY ONCE no matter which terminus fires first", async () => {
  // 枚举终局站点两两组合（至少「driver 先关 + pump 后关」「pump 先关 + driver 后关」两序）
  // 断言客户端恰好收到一个 content_block_stop@anchorIdx
})
```

- [ ] **Step 2**：跑，红（当前 `closeAnchorBeforeReal` 的 `!anchorState.anchorClosed` 幂等守卫使它**只关第一个** anchor）。
- [ ] **Step 3**：实现——**所有 close 一律经 owner 的 `closeOpenAnchor`**（round-4 blocker：生产代码不得在 owner 外读写 `openAnchorIndex` 或自行写 anchor stop 帧）：
  - **close-before-real**（本 task 的主体）：三条路径各自取 port 后调 `closeOpenAnchor(buildStop, "before-real")` —— flush 循环内 per-frame（`driver.ts` 的 `isContentBlockStart` 分支）、retreat 分支（`:1240` 附近）、live 装饰器（`live-reconcile.ts:136-141`，随 M4 的 transaction 一并做）。
  - **终局 close**（8 个 handler 站点 + driver 2 处）：**已在 M1 迁移完毕**（见 plan-3「M1 的逐站点 close 迁移」表），本 task 不重复迁移，只需确认其回归仍绿。
  - **exactly-once 由 API 保证**：第二个调用者见 `openAnchorIndex === undefined` 得 `"none"`，取代原先跨站点共享 `anchorClosed` 的手工幂等。
- [ ] **Step 4**：跑，绿 + 全部 close-off 测试回归（`live-pump-terminal-anchor-closeoff.http.test.ts`、`live-post-commit-anchor-closeoff.http.test.ts`、`anchor-multiblock-lifecycle.it.test.ts (c′)`）。
- [ ] **Step 5**：mutation——注释掉 gap anchor 的 close-before-real，确认 O-2 转红。
- [ ] **Step 6: 提交** → `fix(anchor): close every gap anchor before the next real block`

## Task 5.3：删 `semanticBlockCount === 0` 门 + 轻量 gap injector

> 现有 `makeSyntheticAnchorInjector` 会处理 message_start 前奏（真实/合成/已转发三分支）。gap 场景下 message_start **必然已转发**（首块已提交），故走的是 `state.messageStartForwarded` 分支——功能上可复用。但它的 latch 语义（`state.injected` / `contentAnchorInjected`）是为一次性设计的。

- [ ] **Step 1: 写失败测试** —— O-3 精确形状

```ts
test("real@0 -> gap-anchor@1 -> real@2 (the canonical inter-block shape)", async () => {
  // gated upstream：真实块 → 过 deadline 的静默 → 真实块
  expect(wireShape(frames)).toEqual([
    "message_start",
    "real_start@0", "real_delta@0", "real_stop@0",
    "anchor_start@1", "keepalive_delta@1", "anchor_stop@1",
    "real_start@2", "real_delta@2", "real_stop@2",
    "message_delta", "message_stop",
  ])
  assertMonotonicWireIndices(frames)
  assertBlockProtocolState(frames)
})
```

- [ ] **Step 2**：跑，红（当前 `semanticBlockCount === 0` 门挡住，只会看到 ping）。
- [ ] **Step 3**：实现——
  - 删 `semanticBlockCount === 0` 条件（连同其「until that design lands」注释，改为指向本 plan 与 ADR D2 修订）。
  - 写轻量 gap injector（`makeGapAnchorInjector`）：**只调 `port.allocateAndWriteAnchor(index => [...])`**（round-2 major：原写法 `allocateAnchor() → writeAnchor() → writeKeepalive()` 正是 P2 用整节否决的「队列外分配 + 两个 operation」，且第二帧写失败会留下已推进的 frontier——**与 P2 自己冻结的 owner-only 契约正面冲突**）。callback 内生成带 provenance 的两帧：`start`（`synthetic:"anchor"`）+ `delta`（`synthetic:"keepalive"`）。**不发 message_start**（已在 wire 上）。成功返回后再据其结果置 `openAnchorIndex`；返回 undefined 则什么都不做（C9：未分配未写出）。
  - handler 接线：`injectContentAnchor` 在「已有真实块」时用 gap injector，「pre-content」时用现有 `makeSyntheticAnchorInjector`。两者共享 allocator 与 `openAnchorIndex`。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：mutation——把 `semanticBlockCount === 0` 门加回，确认 O-3 转红。
- [ ] **Step 5b**：**架构守卫 mutation（round-2 major）**——把 gap injector 改回「裸 `allocateAnchor()` + 两次 write」，确认 P2 建立的架构守卫（生产路径只能经 owner API）**转红**。这防止计划后半自己绕过 P2 冻结的契约。
- [ ] **Step 6: 提交** → `feat(keepalive): allow gap anchors after the first committed block`

## Task 5.4：续写腿内的 gap 静默（**跨相位集成缝**，用户 2026-07-27 裁决升格为独立 task）

> **为什么必须是独立 task 而非交给 P8 合并态审**：这正是本项目吃过亏的形状——**跨 phase 集成缝只在合并态才被发现，代价最高**（记忆 `cross-phase-integration-seam-only-caught-at-merged-state`：Phase A 的契约被下游漏接线，逐 task 审看不到）。P4（leg 语义）与 P5（gap anchor 生命周期）各自的 oracle 都只覆盖自己那一侧：P4 测「续写腿的块从 frontier 分配」，P5 测「gap 静默产生 anchor」，**两者的交叉——续写腿进行中发生 gap 静默——没有任何一侧覆盖**。指望 reviewer 事后挑是把最贵的缺陷留到最后。

**交叉点的具体形状**（实施期要验的就是这些）：

1. 续写腿开始后、其首块到达前的静默 → 此时客户端轨无 open block（主腿末块已闭合），gap anchor 会被注入。该 anchor 的 wire index 必须来自 frontier（在主腿最后一块之后），且续写腿首块要排在它之后。
2. 续写腿两块之间的静默 → 同 1，但 anchor 落在续写腿内部。
3. gap anchor 已 open 时**恰好**发生 mid-stream cut 触发续写 → anchor 必须在续写腿首块前被关闭（C2），且不得被计入续写的合成 assistant 前缀（C6 说 anchor 绕 buffer，**但这条要在续写腿上重新验证**——C6 的核实是在主腿场景做的）。
4. per-gap latch（5.1）跨腿的行为：续写腿的首个真实块是否正确重新武装 latch。

- [ ] **Step 1: 写失败测试**（red-first，覆盖上述 4 个形状）

```ts
// tests/pipeline/continuation-gap-anchor-seam.it.test.ts
test("gap silence INSIDE a continuation leg still yields a frontier-allocated anchor", async () => {
  // 真 runResponseBufferedSink + 真 anchor injector + continuation hooks + FakeClock
  // 主腿：real@0 → mid-stream cut → 续写腿开始 → 过 deadline 的静默 → 续写腿首块
  // 断言：
  assertMonotonicWireIndices(frames)   // O-1：anchor 落 wire 1、续写块落 wire 2，无复用无跳号
  assertBlockProtocolState(frames)     // O-2
  expect(wireShape(frames)).toEqual([...])
})
test("an OPEN gap anchor at the moment of a cut is closed before the continuation leg's first block", async () => {
  // 形状 3：断言 anchor_stop 出现在续写腿首个 real_start 之前
})
test("the gap anchor never enters the continuation's synthetic assistant prefix", async () => {
  // 形状 3 的 C6 复验：抓 continuation 请求体，断言其 assistant 前缀不含空 text block
  // （C6 在主腿已核实；本条是在续写腿上的独立验证，不复用那次结论）
})
test("the per-gap latch re-arms across the leg boundary", async () => {
  // 形状 4：主腿一个 gap + 续写腿一个 gap → 两个 anchor
})
```

- [ ] **Step 2**：跑。**四条里至少一条应当红**——若全绿，先怀疑 harness 没真正进入续写腿（用 `continuationCount` / `onContinuationLeg` 探针确认），修 harness 而非改断言。若确认进入了续写腿且全绿，降级为 characterization 并**明确注明**「交叉行为由 P4+P5 各自的实现自然满足，本测试锁住它不被回归」。
- [ ] **Step 3**：按红的形状修实现。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：**交叉 mutation 矩阵**（plan review major：原「任一侧 mutation 让本文件转红」**不能证明**测试咬住的是交叉——删 `beginLeg()` 会让纯 continuation 断言红、破坏 latch reset 会让纯多-gap 计数红，「同文件至少一条红」最多证明该文件同时含两侧测试）。

  指定**同一条**交叉测试（推荐「主腿 gap + 续写腿 gap + upstream index 重启」那条，它同时依赖 P4 的 leg 语义与 P5 的 latch），建 4 格矩阵：

  | mutation | 同一条交叉测试的预期 | 两条单侧 control 的预期 |
  |---|---|---|
  | 删除 P4 `beginLeg()` | **红**，且失败原因明确是「续写腿块落在已占用 index」 | P4.1 的纯 continuation 测试也红（预期） |
  | 删除 P5 跨腿 latch re-arm | **红**，且失败原因明确是「续写腿的 gap 没有产生 anchor」 | P5.1 的纯多-gap 测试也红（预期） |

  验收判据是**同一条交叉测试对两个 mutation 分别以不同的、可辨识的原因失败**；再加两条单侧 control，证明该 mutation 不是**只**被 P4.1 / P5.1 的既有性质捕获。若交叉测试对某个 mutation 不红，说明它并未真正依赖那一侧 → 重构场景，不得跳过。

- [ ] **Step 6**：把矩阵结果填进下方表。
- [ ] **Step 7: 提交** → `test(anchor): cover the continuation-leg × gap-anchor integration seam`

### 交叉 mutation 矩阵（实施期填写）

| mutation | 交叉测试是否红 | 失败原因（须可辨识且不同） | 单侧 control 是否也红 |
|---|---|---|---|
| 删 P4 `beginLeg()` | _待填_ | _待填_ | _待填_ |
| 删 P5 跨腿 latch re-arm | _待填_ | _待填_ | _待填_ |

## Task 5.5：多 gap + 混合块类型

- [ ] **Step 1: 写失败测试**：三个 gap，块类型分别是 text / thinking / tool_use，断言 O-1/O-2 + anchor 数 = 3 + 每个真实块内容完整无丢失。
  - **tool_use 特别重要**：审查 F3 证实 CC 是 eager per-block 执行；gap anchor 不得推迟 tool_use 块的 stop。断言 `tool_use` 块的 `content_block_stop` 与其 deltas 之间**没有** anchor 帧插入。
- [ ] **Step 2**：跑（P5.1–5.3 后可能已绿）。若绿 → characterization，注明。
- [ ] **Step 3**：若红则修。
- [ ] **提交** → `test(anchor): multi-gap coverage across text/thinking/tool_use blocks`

## Task 5.6：默认值裁决

> 本相位落地后 `stream_keepalive_escalate_sec` 默认 200 会让**任何** >200s content-idle 的请求注入 gap anchor。这是设计意图（D2 修订版：正常 cadence 裸 ping、逼近死线才升级）。

- [ ] **Step 1**：核实 `state-defaults.ts` 的 `streamKeepaliveEscalateSec: 200` 与 `streamKeepaliveMode: "ping"` 组合在本相位后的实际行为，写一条 config-level 测试锁住「默认配置 + 短请求 = 零 anchor = 字节等价」。
- [ ] **Step 2**：跑 O-6，确认基线未变。
- [ ] **Step 3**：**不翻 `protectStreamingGeneration` 默认**（那是 ADR D4 的独立决策，且 A 是它的前置门而非它的一部分）。本计划只让 A 可用，翻默认是主会话/用户的独立裁决。
- [ ] **提交** → `test(config): lock zero-anchor byte equivalence under shipped defaults`

## M1 / M6–M8 收口

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件对账完毕。
- [ ] O-1/O-2/O-3 绿；O-6 字节等价仍等于 P0 捕获的 base 基线。
- [ ] `rg -n "anchorBlockOpen|anchorClosed" src/` **零命中**（由 **M5** 完成删除；M1–M4 期间它们仍存在且被 owner 双写维护，属**有明确终点的迁移期双轨**，非遗留包袱）。
- [ ] anchor stop 的 **exactly-once** 测试绿（终局站点两两组合）。
- [ ] `semanticBlockCount === 0` 门已删，其注释已改为指向本 plan。
- [ ] **Task 5.4 的交叉 mutation 矩阵填满**：同一条交叉测试对两个 mutation 分别以**可辨识的不同原因**失败，且两条单侧 control 也在位。
