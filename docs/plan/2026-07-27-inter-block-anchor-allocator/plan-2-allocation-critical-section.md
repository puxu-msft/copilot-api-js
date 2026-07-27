# P2 — 分配临界区（heartbeat vs flush 的并发缝）

> **前置**：P1 + **P6**（plan review major：两者共享 `delivery/session.ts` 的 heartbeat 生命周期语义，见 Task 2.2b）。**产出**：唯一 owner API，使 index 分配与 wire 写出在同一 serializer operation 内原子完成。
> **承重项 4**（设计 §4.4 第 4 点 / 审查 F7）。

## 问题的精确形状

两个并发写者共享 allocator：

1. **心跳 tick**（`delivery/session.ts:107-129` `tickHeartbeat`）——异步注入 gap anchor，要 `nextAnchorIndex()` + `onAnchorOpen()`；
2. **driver flush**（`driver.ts:1139-1199` `flushBufferedFrames`）——循环里每个 `await sink.write(outFrame)` 都是一个让点，真实块要 `onRealBlockOpen()` + 读 `realBlockOffset()`。

`suspendHeartbeat`（`driver.ts:1269/1293`）只清定时器、**不等待在飞的 injector**。现有代码靠 injector「首个 `await` 前同步翻 state」躲开该 TOCTOU（`keepalive-anchor.ts:241-249` 的长注释即此教训）。但 A 引入的是**带返回值的分配动作**（`nextAnchorIndex()` → 写帧 → `onAnchorOpen()`），比布尔翻转更难原子化：若 injector 在 `nextAnchorIndex()` 与 `onAnchorOpen()` 之间让出，flush 拿到同一个 index，两块撞车。

## Files

- Modify: `src/lib/pipeline/delivery/session.ts`（**暴露 generation-scoped 分配-写出 owner API**；gap anchor 注入走它）
- Modify: `src/lib/pipeline/delivery/types.ts`（owner API 的类型）
- Modify: `src/lib/anthropic/keepalive-anchor.ts`（injector 改调 owner API）
- Modify: `src/lib/pipeline/driver.ts`（flush 循环内真实块经 owner API 分配 + 写出）
- Test: 新 `tests/pipeline/anchor-allocation-race.it.test.ts`

## Interfaces（**plan review major：必须先定可执行接口，不能只描述意图**）

审查坐实的问题：`delivery/serializer.ts` 的 `enqueue` 被 `createDownstreamDeliverySession` **私有持有**（`session.ts:56`），`ClientSink.write*` 各自 enqueue **一次**。因此「先 `allocateAnchor()` 再分别 `writeAnchor()` / `writeKeepalive()`」是**队列外分配 + 两个 operation**，既不满足 C5，也挡不住 TOCTOU。原 plan 同时写「进 serializer」和「driver 侧紧邻 `sink.write`」自相矛盾——后者发生在 `sink.write` **之前**，根本不在队列内。

**冻结方案：由 delivery session 暴露唯一 owner API，在一个 `enqueue` callback 内完成「分配 → 状态提交 → 帧写出」。**

```ts
// src/lib/pipeline/delivery/types.ts
/**
 * Generation-scoped wire-index allocation bound to the wire write itself (C5 + C9).
 *
 * The allocator advance and the frames that consume the allocated index are performed inside ONE
 * serializer operation, so no concurrent heartbeat tick or driver flush can interleave between the
 * allocation and its write. Callers therefore never hold an allocated-but-unwritten index.
 */
export interface WireBlockAllocationPort {
  /**
   * Allocate the next wire index for a SYNTHETIC anchor and write its frames (start + first delta)
   * atomically. Returns the index actually written, or undefined when the session refused (closed /
   * terminating / heartbeat stopped) — in which case NOTHING was allocated (C9).
   */
  allocateAndWriteAnchor(build: (index: number) => { start: ClientFrame; delta: ClientFrame }): Promise<number | undefined>
  /**
   * Allocate the next wire index for a REAL upstream block and write the already-remapped frames
   * atomically. `upstreamIndex` records the leg-local mapping used by later delta/stop remaps.
   */
  allocateAndWriteRealBlock(upstreamIndex: number, build: (index: number) => ReadonlyArray<ClientFrame>): Promise<number | undefined>
  /** Begin a new leg (continuation): subsequent upstream indices restart at 0 against the current frontier. */
  beginLeg(): void
}
```

**冻结的语义要点**（实施期不得自行改，要改回主会话）：

1. **失败即不推进**（C9）：write 抛出 / session 拒绝时，frontier **不得**前进——分配与写出要么都发生、要么都不发生。实现上先写后 commit，或写失败时回滚计数；**具体手法自选，但该不变量必须有测试**。
2. **delta / stop 不分配**：它们只**查**该腿已记录的 mapping。只有 `content_block_start` 触发分配。
3. **owner 唯一**：`ClientSink` 上不再暴露任何「裸分配」入口；`nextAnchorIndex` / `onAnchorOpen` 等低阶 API 降级为**测试专用**，由架构守卫锁住（Task 2.1 Step 5）。

> **P3.1 停点的处置**：原「谁调 `allocateRealBlock`」的执行期停点，**在本相位被前移消解**——答案由 owner API 冻结：driver flush 与 live-reconcile 各自在自己的真实块 `content_block_start` 上调 `allocateAndWriteRealBlock`，delivery session 是唯一 owner。审查指出该问题决定 C5 owner 与 S1/S2/S3 接线，不该留到实现期才发现，**已采纳**。若 P2 落地时发现该 owner 形状站不住（例如 live 腿的装饰器结构无法接入），**那才是真分叉，停下回报**。

---

## Task 2.1：allocator 侧的原子分配 + leg 语义

> 这是 owner API 的**底层**：allocator 自身的原子入口。owner API（Task 2.2）在 serializer operation 内调它。

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/sequential-anchor-allocator.unit.test.ts（追加）
test("allocateAnchor / allocateRealBlock are atomic: peek and commit cannot interleave", () => {
  const a = createAnchorIndexAllocator()
  expect(a.allocateAnchor()).toBe(0)        // 返回并已提交
  expect(a.allocateRealBlock(0)).toBe(1)
  expect(a.allocateAnchor()).toBe(2)
  expect(a.allocateRealBlock(1)).toBe(3)
  expect(a.realBlockOffset(0)).toBe(1)
  expect(a.realBlockOffset(1)).toBe(2)
})
test("beginLeg restarts leg-local upstream indices against the CURRENT frontier (C3/C4)", () => {
  const a = createAnchorIndexAllocator()
  a.allocateRealBlock(0)                    // 主腿 upstream 0 → wire 0；offset 0（恒等）
  expect(a.realBlockOffset(0)).toBe(0)
  a.beginLeg()                              // 续写腿
  expect(a.allocateRealBlock(0)).toBe(1)    // 该腿 upstream 0 → wire 1
  expect(a.realBlockOffset(0)).toBe(1)      // ← 查的是【当前腿】的 mapping，不是主腿的旧映射
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现原子入口 + leg 语义（同步函数，内部 peek+advance 之间**无 await**）。`realBlockOffset` 必须查**当前腿**的 mapping——这是 blocker 修复的底层支撑（README「C3 的修订」）。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：架构守卫——`tests/architecture/anchor-remap-single-authority.unit.test.ts`（P1.4 建的）扩一条：`src/` 下除 `keepalive-anchor.ts` 与 `delivery/session.ts` 外不得出现 `nextAnchorIndex(`/`nextRealIndex(`/`onAnchorOpen(`/`onRealBlockOpen(`/`allocateAnchor(`/`allocateRealBlock(`（生产路径只能经 owner API）。带正样本对照。
- [ ] **提交** → `feat(anchor): atomic allocate entries with leg-local mapping; peek/commit split is test-only`

## Task 2.2：owner API 落地 + 让点 oracle

> C5 的唯一合法实现：分配与写出在**同一个 `enqueue` callback** 内。`createDeliverySerializer`（`delivery/serializer.ts`）已是 delivery 的单写者队列，所有 wire 写都过它（`session.ts:73-84`）。

- [ ] **Step 1: 写失败测试** —— FakeClock 让 tick 恰落在 flush 的 `await sink.write` 让点

```ts
// tests/pipeline/anchor-allocation-race.it.test.ts
test("a heartbeat tick landing inside a flush await yields no duplicate and no skipped wire index", async () => {
  // instrumented sink：其 write 在第 N 次调用时 await 一个可控 gate；
  // gate 打开前推进 FakeClock 触发 tick（tick 会走 allocateAndWriteAnchor）
  assertMonotonicWireIndices(frames)   // O-1
  assertBlockProtocolState(frames)     // O-2（升级后的完整协议状态 oracle）
  // 且 anchor 与真实块的 index 集合不相交
})
test("POSITIVE CONTROL: the harness DOES catch an allocation performed OUTSIDE the serializer", async () => {
  // 注入一个「先 allocate，再分别 write」的 fake owner（= 原 plan 描述的非法形状），
  // 断言上面的 oracle 会红 —— 证明这个并发 harness 真能咬住队列外分配，
  // 而不是「碰巧没撞上」（pass-null-clean-not-self-validating）
})
test("a write failure does NOT advance the frontier (C9)", async () => {
  // sink.write 抛错 → 断言下一次分配拿到的仍是同一个 index，wire 上无空洞
})
```

- [ ] **Step 2**：跑，红（至少正样本对照必须红；主测试若**当前就绿**，说明竞态窗口没构造出来——**不得**据此认为安全，调整 harness 直到正样本对照能咬住）。
- [ ] **Step 3**：实现 owner API（`allocateAndWriteAnchor` / `allocateAndWriteRealBlock` / `beginLeg`），全部走 `serializer.enqueue` 的单个 operation。
- [ ] **Step 4**：跑，绿；**连跑 15 次**确认确定性（`for i in {1..15}; do bun test tests/pipeline/anchor-allocation-race.it.test.ts || break; done`）——时序测试必须实证确定性，非跑一次算数。
- [ ] **Step 5: 提交** → `feat(delivery): atomic wire-index allocation bound to the wire write`

## Task 2.2b：P2 × P6 交叉门（**plan review major：两者并非无代码重叠**）

> 审查坐实：P2 与 P6 都改 `delivery/session.ts`，且改的正是**同一组语义**——heartbeat operation 的入队、挂起、恢复与 flush 交接。P6 改变「boundary commit 后 heartbeat 是否继续入队」，直接**扩大 P2 竞态的可达状态**。故 README 原称「无代码重叠、可并行」是事实错误。
>
> **依赖裁决**：P2 必须基于**含 P6** 的 base 实施（DAG 已补 `P6 → P2`）。若 P6 独立先合并 master，则 allocator worktree 必须 rebase/merge 到含 P6 的 master 后再做 P2——否则会在旧 heartbeat 生命周期上写竞态 oracle，合并后测试语义失效。

- [ ] **Step 1: 写失败测试** —— 只有在 P6 修复后才可达的状态

```ts
// tests/pipeline/allocation-race-after-boundary-commit.it.test.ts
test("after a boundary commit resumes the heartbeat, a tick landing in the next flush await still allocates safely", async () => {
  // 这个场景在 P6 之前【不可达】：boundary commit 后心跳已死，tick 根本不会再来
  // 序列：真实块提交（suspend → freeze → resume）→ 心跳复活 → 下一次 flush 的 await 让点上 tick 触发
  assertMonotonicWireIndices(frames)
  assertBlockProtocolState(frames)
  // 且 anchor 不得插入真实块的 deltas 中间
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：修（若 P2.2 的 owner API 已正确，此条可能直接绿 → 降级为 characterization 并注明「P6 打开的新可达状态由 owner API 天然覆盖，本测试锁住它」）。
- [ ] **Step 4**：连跑 15 次。
- [ ] **提交** → `test(delivery): allocation safety in the heartbeat states P6 makes reachable`

## Task 2.3：`suspendHeartbeat` 与在飞 injector 的交接

> `suspendHeartbeat` 不等待在飞注入。P2.2 把分配移进 serializer 后，在飞的 injector operation 已经排在队列里，flush 的写也排在队列里——**顺序由队列保证**，不会撞 index。但仍需锁住一条不变量：suspend 之后不得有**新的** anchor 被分配。

- [ ] **Step 1: 写失败测试**：suspend 后推进 FakeClock 超过 deadline，断言 `allocator.anchorsOpened()` 不再增长。
- [ ] **Step 2**：跑（可能已绿——`armHeartbeat` 的 `heartbeatSuspended` 守卫已覆盖）。**若已绿**，降级为 characterization 测试并在此注明「现有守卫已覆盖，本测试锁住它不被回归」，不伪造红。
- [ ] **Step 3**：若红则实现。
- [ ] **提交** → `test(anchor): lock that a suspended heartbeat allocates no further anchors`

## P2 收口

- [ ] `typecheck` + `test:fast` 绿；O-1/O-2/O-6 仍绿。
- [ ] 并发 oracle（2.2 + 2.2b）各连跑 15 次全绿。
- [ ] 架构守卫锁住「生产路径只经 owner API 分配」。
- [ ] **C9 有测试**：write 失败不推进 frontier。
- [ ] **P3.1 原停点已消解**：owner 形状已冻结（若实施中发现站不住，那才是真分叉 → 停下回报）。
