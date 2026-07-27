# P5 — gap anchor 生命周期（per-gap latch + close-before-real）

> **前置**：P2（临界区）、P3（remap）、P6（心跳复活）。**产出**：解除「首块后不升级」的门，gap anchor 可在任意「客户端无 open block」窗口注入并在下一真实块前关闭。
> **承重项 5 + 6**。这是 A 真正闭合 >300s 门的相位；前面全部相位都是它的地基。

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
- Modify: `src/lib/pipeline/types.ts`（`AnchorState` 的 anchor 生命周期字段语义：`anchorClosed` 从「一次性」改为「当前 anchor 是否已关」）
- Test: 新 `tests/pipeline/gap-anchor-lifecycle.it.test.ts`

## `AnchorState` 语义变更（承重，实施期最易错）

现有字段是为**单个 pre-content anchor** 设计的：

- `anchorBlockOpen`：注释明写「stays TRUE for the whole stream once set（index 0 remains reserved even after the anchor is closed）」（`types.ts:444`）——即它其实是「本 generation 用过 anchor 吗」的历史标志，**不是**「当前有 anchor open 吗」。
- `anchorClosed`：universal 幂等守卫，跨全部 close-off 站点，**一次性**。

多 anchor 下这两个语义都不够用。需要区分三件事：

| 概念 | 新字段 | 语义 |
|---|---|---|
| 本 generation 用过 anchor 吗 | `allocator.anchorsOpened() > 0` | C3 短路判据（已在 P1） |
| **当前**有 anchor open 吗 | `openAnchorIndex?: number` | undefined = 无；有值 = 该 index 的 anchor 正 open，下一真实块前须关 |
| 终局收口是否已做 | `anchorClosed` | 保留原语义供 terminal close-off 幂等 |

**`anchorBlockOpen` 的处置**：它现在的两个用途（① remap 门槛、② close-off 门槛）分别被 `allocator.anchorsOpened()>0`（C3）与 `openAnchorIndex !== undefined` 取代。故本相位**替换**它而非新增并存字段（项目「不留双轨包袱」）。grep 全站点逐处迁移（`rg -n "anchorBlockOpen" src/ tests/`），类型系统会逼出全部站点。

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
test("a gap anchor is closed BEFORE the next real content_block_start (maxOpen===1)", async () => {
  // 同上场景，用 producer harness 收全部客户端帧
  assertMaxOneBlockOpen(frames)          // O-2
  // 且精确断言 stop@gapIdx 出现在 start@nextRealIdx 之前
})
```

- [ ] **Step 2**：跑，红（当前 `closeAnchorBeforeReal` 的 `!anchorState.anchorClosed` 幂等守卫使它**只关第一个** anchor）。
- [ ] **Step 3**：实现——`driver.ts` 的 `closeAnchorBeforeReal` 改判 `openAnchorIndex !== undefined`，关闭后置 undefined（而非一次性 `anchorClosed=true`）。三条路径都要覆盖：flush 循环内 per-frame（`driver.ts` 的 `isContentBlockStart` 分支）、retreat 分支（`:1240` 附近）、live-reconcile（`live-reconcile.ts:136-141`）。
  - **终局 close-off 的幂等仍需保留**：`closeAnchorIfOpen`（`keepalive-anchor.ts:178`）+ driver 的终端 close-off + pump 的多个终端分支共享 `anchorClosed`，改成 per-anchor 后必须确保**终局只发一次 stop**。用 `openAnchorIndex` 判断即可（关完置 undefined，第二个调用者看到 undefined 短路）。
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
  assertMaxOneBlockOpen(frames)
})
```

- [ ] **Step 2**：跑，红（当前 `semanticBlockCount === 0` 门挡住，只会看到 ping）。
- [ ] **Step 3**：实现——
  - 删 `semanticBlockCount === 0` 条件（连同其「until that design lands」注释，改为指向本 plan 与 ADR D2 修订）。
  - 写轻量 gap injector（`makeGapAnchorInjector`）：`allocateAnchor()` → `writeAnchor(anchor.startFrame(idx))` → `writeKeepalive(anchor.deltaFrame(idx))`，设 `openAnchorIndex = idx`。**不发 message_start**（已在 wire 上）。**分配与两次写在同一 serializer operation**（C5，P2 已铺路）。
  - handler 接线：`injectContentAnchor` 在「已有真实块」时用 gap injector，「pre-content」时用现有 `makeSyntheticAnchorInjector`。两者共享 allocator 与 `openAnchorIndex`。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：mutation——把 `semanticBlockCount === 0` 门加回，确认 O-3 转红。
- [ ] **Step 6: 提交** → `feat(keepalive): allow gap anchors after the first committed block`

## Task 5.4：多 gap + 混合块类型

- [ ] **Step 1: 写失败测试**：三个 gap，块类型分别是 text / thinking / tool_use，断言 O-1/O-2 + anchor 数 = 3 + 每个真实块内容完整无丢失。
  - **tool_use 特别重要**：审查 F3 证实 CC 是 eager per-block 执行；gap anchor 不得推迟 tool_use 块的 stop。断言 `tool_use` 块的 `content_block_stop` 与其 deltas 之间**没有** anchor 帧插入。
- [ ] **Step 2**：跑（P5.1–5.3 后可能已绿）。若绿 → characterization，注明。
- [ ] **Step 3**：若红则修。
- [ ] **提交** → `test(anchor): multi-gap coverage across text/thinking/tool_use blocks`

## Task 5.5：默认值裁决

> 本相位落地后 `stream_keepalive_escalate_sec` 默认 200 会让**任何** >200s content-idle 的请求注入 gap anchor。这是设计意图（D2 修订版：正常 cadence 裸 ping、逼近死线才升级）。

- [ ] **Step 1**：核实 `state-defaults.ts` 的 `streamKeepaliveEscalateSec: 200` 与 `streamKeepaliveMode: "ping"` 组合在本相位后的实际行为，写一条 config-level 测试锁住「默认配置 + 短请求 = 零 anchor = 字节等价」。
- [ ] **Step 2**：跑 O-6，确认基线未变。
- [ ] **Step 3**：**不翻 `protectStreamingGeneration` 默认**（那是 ADR D4 的独立决策，且 A 是它的前置门而非它的一部分）。本计划只让 A 可用，翻默认是主会话/用户的独立裁决。
- [ ] **提交** → `test(config): lock zero-anchor byte equivalence under shipped defaults`

## P5 收口

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件对账完毕。
- [ ] O-1/O-2/O-3 绿；O-6 字节等价仍等于基线。
- [ ] `rg -n "anchorBlockOpen" src/` 零命中（已被新字段取代）。
- [ ] `semanticBlockCount === 0` 门已删，其注释已改为指向本 plan。
