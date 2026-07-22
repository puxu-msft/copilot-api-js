# Plan-1: 顺序 anchor index 分配重写（承重①）

> **依赖门:** G1（代理产出侧红-绿基线）+ G2（300s 死线重置分支决策）。G2 FAIL → 本相位形状须重议（见 plan-G）。
> **审查 Critical-1:** 打破 `ANCHOR_INDEX=0` + 固定 `remap(,1)` 模型，改为运行时递增 index 分配，anchor 穿插 0/2/4…、任一时刻单块 open。完成前 spec 未竟部分（Anthropic 块级 CLI-safe）。

## 实现期改造图（2026-07-22 读透 coexist 状态机后落，Task 1.1 已 landed 13211ca3）

**Task 1.1 ✅ landed**：`createAnchorIndexAllocator`（`keepalive-anchor.ts`，运行时递增 wire 计数 + 真实块 upstream→wire 映射，`realBlockOffset(upstreamIndex)`）。3 test。纯新增未接线。

**coexist 现状（`client-sink.ts` tick :409-445 + `keepalive-anchor.ts` injector）——三处互锁要反转：**
1. **anchor 生命周期反转**：coexist 里 `injectAnchor` 只在 pre-content（tick :417 守卫 `openBlockStack.length===0 && !anchorAttempted && !everOpenedRealBlock`）注入 anchor@0，之后 anchor **留栈底**、真实块 push 栈顶 = 两块并存。顺序模型：pre-content anchor 在**第一个真实块到达前** emit `content_block_stop@anchorIdx`（injector 或 driver/reconcile 的「首个真实 content_block_start 前」钩子），栈清空。
2. **gap anchor 放开**：tick :417 的 `!everOpenedRealBlock` 守卫**禁止**真实块后再注入 anchor——顺序模型要允许「真实块之间 idle 时新开一个 anchor 块」（新 wire index，来自 allocator），delta 保活，下一真实帧到达时关闭。`anchorAttempted` latch 语义须改为 per-gap 复位。
3. **remap 走 allocator**：`driver.ts:1095/1142` + `live-reconcile.ts:132` 的 `anchor.remap(frame, 1)` → `anchor.remap(frame, allocator.realBlockOffset(upstreamIndex))`。**allocator 须挂在 `AnchorState`（共享对象）** 上，让 sink（记块开关）、driver、reconcile 读同一个；`noteBlockState`/`writeAnchor`/`write` 在开真实块/anchor 块时调 `allocator.onRealBlockOpen()`/`onAnchorOpen()`。

**验证（行为 oracle，非 typecheck 绿）**：① G1 `exp/block-level-anchor-sequential/produce-oracle.ts`——生产 sink 确实产出「单块 open + 穿插 anchor + gap text_delta」；② 既有 anchor 测试套件（`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 等）逐条判「预期变化 vs 回归」——coexist 断言「两块并存」的会红，须改写为顺序断言（非删）；③ 真 CLI e2e `exp/block-level-anchor-sequential/run.ts` 仍 numTurns=1。

**风险**：这是协议关键流式代码 + 互锁不变量网，typecheck 绿 ≠ 协议对。改点分散在 injector 的 await-前同步翻 state（`makeSyntheticAnchorInjector` :168-198）、tick 守卫、driver commit/retreat 两 remap、reconcile close-off。**续接会话务必先跑既有 anchor 测试套件建 red-green 基线，再逐不变量改。**

---

**Files:**
- Modify: `src/lib/anthropic/keepalive-anchor.ts`（`ANCHOR_INDEX` 常量 → 分配器;`remapAnthropicBlockIndex` offset 参数改运行时）
- Modify: `src/lib/pipeline/driver.ts:1095,1142`（`remap(frame, 1)` → `remap(frame, anchorState.currentOffset)`）
- Modify: `src/lib/anthropic/live-reconcile.ts:132`（同步）
- Modify: `src/lib/pipeline/client-sink.ts`（`noteBlockState` 顺序策略:pre-content close-on-first-real + gap 新开 anchor）
- Test: `tests/anthropic/sequential-anchor.unit.test.ts` + `exp/block-level-anchor-sequential/produce-oracle.ts`（G1 转绿）

**Interfaces:**
- Consumes: `CommittedBlocksLedger`（P0，续写块 index 接续）
- Produces: `AnchorIndexAllocator = { nextAnchorIndex(): number; nextRealIndex(): number; realBlockOffset(upstreamIndex: number): number; onRealBlockOpen(): void; onAnchorOpen(): void }`（sink/driver 共读的运行时 index 状态，取代 `ANCHOR_INDEX=0` 常量 + 固定 +1;`realBlockOffset` = 该真实块的 wire index − 上游帧自带 index，供 remap 用。**精确 API 在 P1 实现期依 G1 产出定稿**）

---

### Task 1.1: index 分配器（取代 ANCHOR_INDEX 常量）

- [ ] **Step 1: 写失败测试** —— 顺序序列的 index 分配

```ts
// tests/anthropic/sequential-anchor.unit.test.ts
import { expect, test } from "bun:test"
import { createAnchorIndexAllocator } from "~/lib/anthropic/keepalive-anchor"

test("sequential index allocation: anchor@0, real@1, gap-anchor@2, real@3", () => {
  const a = createAnchorIndexAllocator()
  expect(a.nextAnchorIndex()).toBe(0)  // pre-content anchor
  a.onAnchorOpen()
  expect(a.nextRealIndex()).toBe(1)    // real block after anchor closed
  a.onRealBlockOpen()
  expect(a.nextAnchorIndex()).toBe(2)  // gap anchor
  a.onAnchorOpen()
  expect(a.nextRealIndex()).toBe(3)
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现分配器**（单调递增计数器；`nextAnchorIndex`/`nextRealIndex` 返回当前计数并递增，`onAnchorOpen`/`onRealBlockOpen` 记账）。保留 `remapAnthropicBlockIndex(frame, offset)` 签名，但 offset 由调用方传运行时值。**删/弃用** `ANCHOR_INDEX = 0` 常量（grep 全站点 `ANCHOR_INDEX` 逐处迁移）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(anchor): runtime-incrementing sequential index allocator`。

### Task 1.2: sink 顺序策略（noteBlockState）

- [ ] **Step 1: 写失败测试** —— 单块 open 不变量 + gap 新开 anchor 发 text_delta（非裸 ping）

```ts
test("at most one block open at any time; gap keepalive is text_delta not bare ping", async () => {
  // 驱动 sink：pre-content anchor → 真实块 → gap tick → 真实块
  // 断言 openSet 大小恒 ≤ 1；gap tick 产出 content_block_delta text_delta，非 pingFrame
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 改 `noteBlockState`**:pre-content anchor 在首个真实 `content_block_start` 到达时先 emit `content_block_stop@anchor` 再开真实块;心跳 tick 无 open 块且已过首字节前 → 新开 `content_block_start@gapIndex(text)` + `text_delta` + 待下一真实帧到达时 close。单槽 `openBlock` 足够（不需块栈）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(sink): sequential-anchor block strategy (single-open invariant)`。

### Task 1.3: driver/live-reconcile 三处 remap 接运行时 offset

- [ ] **Step 1: 写失败测试** —— buffered 提交 + retreat + live 三路径 index 正确

```ts
test("driver.remap uses runtime offset so real blocks land at sequential indices", () => { /* ... */ })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 改** `driver.ts:1095/1142` + `live-reconcile.ts:132`:`anchor.remap(frame, 1)` → `anchor.remap(frame, allocator.realBlockOffset(upstreamIndex))`。retreat 分支（:1142）多锚点重映射语义按分配器状态。
- [ ] **Step 4: 跑，通过 + 回归**（现有 anchor 测试仍绿）。
- [ ] **Step 5: 提交** → `refactor(driver): sequential-anchor runtime offset at all remap sites`。

### Task 1.4: G1 produce-oracle 转绿（代理产出侧验收）

- [ ] **Step 1:** 跑 `bun run exp/block-level-anchor-sequential/produce-oracle.ts` → 现应 **PASS**（P1 前是 FAIL 基线）。断言代理**确实产出**顺序 wire（index 单调、单块 open、gap text_delta）。
- [ ] **Step 2:** 跑 `bun run exp/block-level-anchor-sequential/run.ts`（真 CLI）仍 PASS（回归）。
- [ ] **Step 3:** FINDINGS 记 G1 转绿。提交。

### P1 收口

- [ ] `bun run test:fast` + `typecheck` 绿;grep 确认 `ANCHOR_INDEX` 无残留固定引用;coexist 相关死码评估（skill `empirical-verification` 活路径证明）。
- [ ] **默认不翻**（P1 只让顺序 anchor 可产出;默认 on 留 P7，须 G2 PASS 后）。
