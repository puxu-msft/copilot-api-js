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
/** Immutable handle for one allocated wire block. Delta/stop remaps resolve against THIS, never an ambient "current leg". */
export interface WireBlockMapping {
  readonly wireIndex: number
  readonly upstreamIndex: number
  readonly leg: LegToken
  /** Remap a content_block_* frame of this block onto its wire index (identity when they already match). */
  remap(frame: ClientFrame): ClientFrame
}

/**
 * Generation-scoped wire-index allocation bound to the wire write itself (C5 + C9).
 *
 * Every allocation happens INSIDE one serializer operation together with the frames that consume it,
 * so no concurrent heartbeat tick or driver flush can interleave between allocating an index and
 * writing it. Callers never hold an allocated-but-unwritten index.
 */
export interface WireBlockAllocationPort {
  /**
   * Allocate the next wire index for a SYNTHETIC anchor and write its frames atomically.
   * Returns the index written, or undefined when the session refused — in which case NOTHING was
   * allocated and NOTHING was written (C9).
   */
  allocateAndWriteAnchor(build: (index: number) => ReadonlyArray<DeliveryFrame>): Promise<number | undefined>
  /**
   * Allocate the next wire index for a REAL upstream block and write EVERY frame belonging to the
   * same wire transaction, atomically.
   *
   * The callback returns DeliveryFrames — i.e. frames CARRYING provenance — so the owner routes a
   * synthetic close-off through `writeAnchor` and real block frames through `write` without guessing
   * from array position. This is what lets the live decorator emit `[anchor_stop, real_start]` as ONE
   * transaction (see P3 S3 专节) instead of two enqueues.
   */
  withAllocatedRealBlock(
    upstreamIndex: number,
    build: (ctx: { mapping: WireBlockMapping }) => ReadonlyArray<DeliveryFrame>,
  ): Promise<WireBlockMapping | undefined>
  /**
   * Fence a leg boundary (continuation / recovery / any new upstream round). Serialized like every
   * other owner operation: it establishes AFTER all successful writes of the previous leg and BEFORE
   * any allocation of the next one.
   */
  beginLeg(kind: "continuation" | "recovery"): Promise<LegToken>
}
```

**冻结的语义要点**（实施期不得自行改，要改回主会话）：

1. **事务性分配（C9，round-2 major 收紧）**：分配是**预留**，在同一 operation 的帧成功写出**之前对任何读者不可见**——`realBlockOffset` / mapping 查询都查不到它。写失败时必须**同时回滚** frontier、anchor 计数、current-leg mapping 与 `openAnchorIndex`，不留 provisional 残留。**理由**：transparent recovery 正是会观察这类残留的路径（见下方 recovery 语义）。
2. **delta / stop 不分配**：只按**该块的 `WireBlockMapping`（不可变 token）**查，**不查 ambient「current leg」**——消除跨 `await` 的可变全局状态（round-2 major）。只有 `content_block_start` 触发分配。
3. **owner 唯一**：`ClientSink` 上不暴露任何裸分配入口；低阶 `allocateAnchor` / `allocateRealBlock` / `on*Open` 降级为**测试专用**，由架构守卫锁住（Task 2.1 Step 5）。**这条对 P5.3 同样生效**——gap injector 必须走 `allocateAndWriteAnchor`，不得裸调（round-2 major）。
4. **`beginLeg` 是 serializer command**（`Promise<LegToken>`，非同步裸方法）：它在**前一腿全部成功写出之后、下一腿任一分配之前**建立 fence。否则 continuation dispatch 与在飞的 heartbeat anchor operation、前腿排队中的 delta/stop 之间没有顺序合同（round-2 major）。

### recovery / leg 边界语义（**round-2 major，本轮冻结**）

代码事实：transparent retry 只在 `!committedAny` 时发生（`driver.ts:1408`），故被丢弃的 attempt **必然没有真实块写出**。但它**可能已经写出过 pre-content anchor**（anchor 走 `writeAnchor` 绕过 buffer，不受 `committedAny` 约束）。两种情形的正确 index：

| 情形 | recovery 前 frontier | recovery 首块（upstream 0）应落 | 恒等？ |
|---|---|---|---|
| attempt0 无 anchor，首块前截断 | 0 | wire **0** | 是 → 原对象直返 |
| attempt0 已写 pre-content anchor@0，首块前截断 | 1 | wire **1** | 否 → 必须 remap |

**冻结裁决**：**所有** upstream round（continuation **与** recovery）都调 `beginLeg(kind)`，**不为 continuation 特判**。allocator 由「已成功写出的 frontier + 空的新腿 mapping」自然得出正确结果——上表两行都自动成立，无需分支。这样也避免了「recovery 忘了调 beginLeg 时靠巧合正确」的脆弱性（reviewer 指出的正是这一点）。

`kind` 只用于诊断/遥测，**不参与 index 计算**。

> **P3.1 停点的处置**：原「谁调 `allocateRealBlock`」的执行期停点，**在本相位被前移消解**——答案由 owner API 冻结：driver flush 与 live 装饰器各自在自己的真实块 `content_block_start` 上调 `withAllocatedRealBlock`，delivery session 是唯一 owner。审查指出该问题决定 C5 owner 与 S1/S2/S3 接线，不该留到实现期才发现，**已采纳**。S3 的可达性已由代码事实确认（见 P3「S3 专节」），不再是停点。

---

## Task 2.1：allocator 侧的原子分配 + leg 语义

> 这是 owner API 的**底层**：allocator 自身的原子入口。owner API（Task 2.2）在 serializer operation 内调它。

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/sequential-anchor-allocator.unit.test.ts（追加）
// 注：本 task 测的是 allocator 的【低阶层】，它由 owner API 在 serializer 内独占调用；
//     低阶 API 本身是测试专用（架构守卫锁住生产路径不得直接用）。
test("allocateAnchor / allocateRealBlock are atomic: peek and commit cannot interleave", () => {
  const a = createGenerationWireIndexAllocator()
  expect(a.allocateAnchor()).toBe(0)                    // 返回并已提交
  expect(a.allocateRealBlock(0).wireIndex).toBe(1)      // 返回不可变 WireBlockMapping
  expect(a.allocateAnchor()).toBe(2)
  expect(a.allocateRealBlock(1).wireIndex).toBe(3)
})
test("mappings are immutable tokens — a later leg cannot change how an earlier block resolves", () => {
  const a = createGenerationWireIndexAllocator()
  const m0 = a.allocateRealBlock(0)                     // 主腿 upstream 0 → wire 0（恒等）
  a.beginLeg("continuation")
  const m1 = a.allocateRealBlock(0)                     // 该腿 upstream 0 → wire 1
  expect(m0.wireIndex).toBe(0)                          // ← 旧 token 不受新腿影响
  expect(m1.wireIndex).toBe(1)
  expect(m0.remap(startFrame(0))).toBe(startFrame(0))   // 恒等 → 原对象（C3）
})
test("a rolled-back allocation leaves no visible mapping", () => {
  // 低阶层的 reserve/rollback 原语（owner 的事务在其上构建）
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现原子入口 + leg 语义（同步函数，内部 peek+advance 之间**无 await**）+ reserve/rollback 原语。**分配返回不可变 `WireBlockMapping` token**，delta/stop 按 token 查——**不再有 ambient「current leg」查询**（round-2 major：跨 `await` 的可变全局状态正是 `beginLeg` 竞态的来源）。
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
- [ ] **Step 3**：实现 owner API（`allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg`），全部走 `serializer.enqueue` 的单个 operation。
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

## Task 2.2c：事务回滚 + recovery 腿 oracle（**round-2 major**）

> C9 原表述只说「write 失败不推进 frontier」，不够——审查指出：若 owner 先同步 allocate 再 write，失败时**不仅要退 frontier，还要退当前腿 mapping**，否则 recovery 腿会查到失败块留下的 provisional mapping。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/allocation-transaction.it.test.ts
test("a failed start write rolls back frontier, anchor count, leg mapping and openAnchorIndex", async () => {
  // 让 sink.write 在 start 帧上抛错 → 断言：
  //   ① 下一次分配拿到【同一个】index（frontier 未推进）
  //   ② 失败块的 mapping 不可被后续 delta 查到（realBlockOffset / mapping 查询均查不到）
  //   ③ anchorsOpened() 未增长；openAnchorIndex 未被置上
})
test("an allocated-but-unwritten index is INVISIBLE to readers mid-transaction", async () => {
  // 在 build callback 内部（帧尚未写出）从另一路径查询 mapping → 必须查不到
})

// recovery 两支（表格两行各一条）
test("recovery leg with NO prior anchor: upstream0 -> wire0, frame returned by reference (identity)", async () => {
  // attempt0 无 anchor、首块前截断 → recovery
})
test("recovery leg AFTER a pre-content anchor was written: upstream0 -> wire1 (must remap)", async () => {
  // attempt0 已写 anchor@0（frontier=1）、首块前截断 → recovery 首块必须落 wire1
  // 这条是「recovery 忘调 beginLeg 会靠巧合正确」的反例锁
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现事务语义（预留对读者不可见 + 失败全量回滚）+ 所有 upstream round 都调 `beginLeg(kind)`。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：mutation——去掉 mapping 回滚（只退 frontier），确认「失败块 mapping 不可查」那条转红。
- [ ] **提交** → `feat(delivery): transactional allocation with full rollback and explicit leg fences`

## Task 2.2d：`beginLeg` fence 时序 oracle（**round-2 major**）

- [ ] **Step 1: 写失败测试**

```ts
test("beginLeg fences AFTER the previous leg's queued writes and BEFORE the next leg's allocations", async () => {
  // 构造：前腿的 delta/stop 仍在 serializer 队列中 → 同时触发 continuation 的 beginLeg
  // 断言：① 前腿排队帧仍按【前腿】mapping 解析（不会漂到新腿）
  //       ② 新腿的首次分配发生在这些写之后
})
test("an in-flight heartbeat anchor operation interleaved with beginLeg keeps the frontier monotonic", async () => {
  // heartbeat anchor operation 先入队、beginLeg 后入队（及反序）两种交错
  assertMonotonicWireIndices(frames)
})
```

- [ ] **Step 2**：跑，红（同步裸 `beginLeg` 会让前腿排队帧查到新腿）。
- [ ] **Step 3**：实现——`beginLeg` 改为 serializer command；delta/stop 按**不可变 `WireBlockMapping` token** 查，不查 ambient current leg。
- [ ] **Step 4**：跑，绿；**连跑 15 次**。
- [ ] **提交** → `fix(delivery): serialize leg fences and resolve remaps through immutable block mappings`

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
