# P2 — 分配临界区（heartbeat vs flush 的并发缝）

> **前置**：P1。**产出**：index 分配与 wire 写出在同一临界区内原子完成；FakeClock 让点 oracle 锁死。
> **承重项 4**（设计 §4.4 第 4 点 / 审查 F7）。

## 问题的精确形状

两个并发写者共享 allocator：

1. **心跳 tick**（`delivery/session.ts:107-129` `tickHeartbeat`）——异步注入 gap anchor，要 `nextAnchorIndex()` + `onAnchorOpen()`；
2. **driver flush**（`driver.ts:1139-1199` `flushBufferedFrames`）——循环里每个 `await sink.write(outFrame)` 都是一个让点，真实块要 `onRealBlockOpen()` + 读 `realBlockOffset()`。

`suspendHeartbeat`（`driver.ts:1269/1293`）只清定时器、**不等待在飞的 injector**。现有代码靠 injector「首个 `await` 前同步翻 state」躲开该 TOCTOU（`keepalive-anchor.ts:241-249` 的长注释即此教训）。但 A 引入的是**带返回值的分配动作**（`nextAnchorIndex()` → 写帧 → `onAnchorOpen()`），比布尔翻转更难原子化：若 injector 在 `nextAnchorIndex()` 与 `onAnchorOpen()` 之间让出，flush 拿到同一个 index，两块撞车。

## Files

- Modify: `src/lib/pipeline/delivery/session.ts`（gap anchor 注入走 serializer；或提供 `allocateAndWrite` 原子入口）
- Modify: `src/lib/anthropic/keepalive-anchor.ts`（injector 的分配-提交次序）
- Modify: `src/lib/pipeline/driver.ts`（flush 循环内真实块的分配点）
- Test: 新 `tests/pipeline/anchor-allocation-race.it.test.ts`

## Interfaces

- Produces: `AnchorIndexAllocator.allocateAnchor(): number`（**原子**：peek + commit 合一，返回已提交的 index）、`allocateRealBlock(upstreamIndex: number): number`（同）
- 保留 `nextAnchorIndex`/`nextRealIndex`/`onAnchorOpen`/`onRealBlockOpen` 作为低阶 API 仅供测试，**生产路径一律用原子入口**（架构守卫锁）

---

## Task 2.1：原子分配入口

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
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现两个原子入口（同步函数，内部 peek+advance 之间**无 await**——JS 单线程下同步函数天然原子，关键是**禁止调用方在两步之间让出**，故合一）。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：架构守卫——`tests/architecture/anchor-remap-single-authority.unit.test.ts`（P1.4 建的）扩一条：`src/` 下除 `keepalive-anchor.ts` 外不得出现 `nextAnchorIndex(`/`nextRealIndex(`/`onAnchorOpen(`/`onRealBlockOpen(`。带正样本对照。
- [ ] **提交** → `feat(anchor): atomic allocate entry points; peek/commit split is test-only`

## Task 2.2：分配点移入 delivery serializer

> C5 的两条合法实现之一：**分配发生在 delivery serializer 内部**（与写出同一临界区）。这是首选，因为 `createDeliverySerializer`（`delivery/serializer.ts`）已经是 delivery 的单写者队列，所有 wire 写都过它（`session.ts:73-84` 的 `write`）。

- [ ] **Step 1: 写失败测试** —— FakeClock 让 tick 恰落在 flush 的 `await sink.write` 让点

```ts
// tests/pipeline/anchor-allocation-race.it.test.ts
test("a heartbeat tick landing inside a flush await yields no duplicate and no skipped wire index", async () => {
  // 构造：gated upstream 产两个真实块；FakeClock 把心跳间隔设成会在 flush 循环的第 N 个
  // await 处到期（用一个 instrumented sink，其 write 在第 N 次调用时 await 一个可控 gate，
  // 并在 gate 打开前推进 FakeClock 触发 tick）。
  // 断言：assertMonotonicWireIndices(frames)  ← O-1
  //       assertMaxOneBlockOpen(frames)       ← O-2
  //       且 anchor 与真实块的 index 集合不相交
})
test("POSITIVE CONTROL: the same harness DOES catch a deliberately non-atomic allocator", async () => {
  // 注入一个把 peek 与 commit 之间插入 await 的 fake allocator，断言上面的 oracle 会红。
  // ——证明这个并发 harness 真的能咬住竞态，而不是「碰巧没撞上」（pass-null-clean-not-self-validating）
})
```

- [ ] **Step 2**：跑，红（至少正样本对照那条必须红；主测试若**当前就绿**，说明竞态窗口没被构造出来——**不得**据此认为安全，必须调整 harness 直到正样本对照能咬住）。
- [ ] **Step 3**：实现——gap anchor 的「分配 index + 写 start 帧」进 `serializer.enqueue` 的**同一个** operation；driver flush 侧的真实块分配同理（分配紧邻 `sink.write` 且中间无 await）。
- [ ] **Step 4**：跑，绿；**连跑 15 次**确认确定性（`for i in {1..15}; do bun test tests/pipeline/anchor-allocation-race.it.test.ts || break; done`）——时序测试必须实证确定性，非跑一次算数。
- [ ] **Step 5: 提交** → `fix(anchor): allocate wire indices inside the delivery serializer critical section`

## Task 2.3：`suspendHeartbeat` 与在飞 injector 的交接

> `suspendHeartbeat` 不等待在飞注入。P2.2 把分配移进 serializer 后，在飞的 injector operation 已经排在队列里，flush 的写也排在队列里——**顺序由队列保证**，不会撞 index。但仍需锁住一条不变量：suspend 之后不得有**新的** anchor 被分配。

- [ ] **Step 1: 写失败测试**：suspend 后推进 FakeClock 超过 deadline，断言 `allocator.anchorsOpened()` 不再增长。
- [ ] **Step 2**：跑（可能已绿——`armHeartbeat` 的 `heartbeatSuspended` 守卫已覆盖）。**若已绿**，降级为 characterization 测试并在此注明「现有守卫已覆盖，本测试锁住它不被回归」，不伪造红。
- [ ] **Step 3**：若红则实现。
- [ ] **提交** → `test(anchor): lock that a suspended heartbeat allocates no further anchors`

## P2 收口

- [ ] `typecheck` + `test:fast` 绿；O-1/O-2/O-6 仍绿。
- [ ] 并发 oracle 连跑 15 次全绿。
- [ ] 架构守卫锁住「生产路径只用原子入口」。
