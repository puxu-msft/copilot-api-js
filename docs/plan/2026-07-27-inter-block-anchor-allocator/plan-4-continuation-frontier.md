# P4 — continuation frontier 统一（双偏移作废）

> **前置**：P3（三处 remap 已走 frontier）。**产出**：`continuationOffset` 退役，续写腿的块也从同一 frontier 分配；撞车序列有专门 oracle。
> **承重项 3 / C4**（审查 F5）。

## 撞车序列（审查给出的具体失败路径，逐层核实过）

前提：`anchor@0 → real@1(上游0) → gap-anchor@2 → real@3(上游1)`，随后进入续写腿，其上游 index 从 **0 重启**。

1. 第一层 `anchor.remap(frame, realBlockOffset(0))`：`realWireIndices[0] = 1` → offset 1 → wire **1**；
2. 第二层 `continuation.remap(_, continuationOffset)`，`continuationOffset = wireDeliveredBlocks = 2`（`driver.ts:1189` 只对**真实块**递增、不含 anchor；`driver.ts:1491` 快照）→ wire **3**；
3. wire 3 **已被 `real@3` 占用** → 重复 index，与本轮 blocker 同型故障（真 SDK 会静默重排 content）。

根因：`realBlockOffset(upstreamIndex)` 用 `realWireIndices[upstreamIndex]` 查表，而续写腿的上游 index 从 0 重启，**命中主腿留下的旧映射**。

## 修法（frontier 唯一权威）

续写腿的真实块**不查旧映射**，而是从 frontier **继续分配新 index**。即 allocator 需要区分「同一腿内的上游 index」与「跨腿的上游 index 重启」。两条候选：

- **A. leg-scoped 映射**：allocator 维护 `legBase`，`onLegStart()` 时记下当前 frontier 与该腿的上游起点；`realBlockOffset(upstreamIndex)` 查的是**当前腿**的映射表。
- **B. 分配即映射**：彻底放弃「按 upstreamIndex 查表」，改为 `allocateRealBlock(upstreamIndex)` 在**开块时**分配并记录，remap 时按「该腿的第 k 个真实块」查。

**推荐 B**，理由：A 仍保留「查表」这一间接层，续写腿重启只是重启的一种；B 让分配点与消费点合一，且天然支持任意多腿。**但这是实现细节层的选择，不是架构合同**——实施期以 oracle 为准，若 B 在 retreat/recovery 腿上站不住则回落 A 并在本文件记录理由。

## Files

- Modify: `src/lib/anthropic/keepalive-anchor.ts`（allocator 加 leg 语义）
- Modify: `src/lib/pipeline/driver.ts`（退役 `continuationOffset` / `wireDeliveredBlocks`；`:1186` 第二层 remap 删除；`:1491` 快照删除；`:1071-1072` 声明删除）
- Modify: `src/lib/pipeline/types.ts`（`ContinuationHooks.remap` / `isContentBlockStart` 若因此无消费者则**先标注、不删**——按 `no-destructive-workspace-loss`「绝不以清理死代码为名擅自删」，交 P8 doc-sync 时统一裁决）
- Test: 新 `tests/pipeline/continuation-frontier-collision.it.test.ts`；改写 `tests/pipeline/continuation-flow.it.test.ts` 的 index 断言

---

## Task 4.1：撞车序列重放 oracle（先红）

> 这条测试**必须先于修复写出并跑红**——它是审查给的具体失败序列，若写完就绿，说明序列没被正确构造（例如 continuation 分支根本没触发），必须调整直到红。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/continuation-frontier-collision.it.test.ts
test("continuation leg restarting its upstream index MUST NOT land on an occupied wire index", async () => {
  // 构造完整序列（用真 runResponseBufferedSink + 真 anchor injector + FakeClock）：
  //   pre-content anchor  → wire 0
  //   real block (上游0)  → wire 1
  //   >deadline 静默 → gap anchor → wire 2
  //   real block (上游1)  → wire 3
  //   mid-stream cut 触发 continuation → 续写腿上游 index 从 0 重启
  // 断言：
  assertMonotonicWireIndices(frames)      // O-1：续写块必须落 wire 4，不得落已占用的 3
  assertMaxOneBlockOpen(frames)           // O-2
  expect(wireShape(frames)).toEqual([...]) // 精确形状
})
test("POSITIVE CONTROL: the harness reproduces the documented collision on the pre-fix accounting", async () => {
  // 注入一个仍按 `realBlockOffset + continuationOffset` 双偏移计算的 fake，断言 O-1 会红
  // ——证明这条 oracle 真的能咬住审查描述的故障，而不是「续写分支根本没跑到」
})
```

- [ ] **Step 2**：跑，**主测试必须红**（当前双偏移会算出已占用的 wire 3）。若绿，先查 continuation 分支是否真的进入（`continuationCount` / `onContinuationLeg` 探针），修 harness 而非改断言。
- [ ] **Step 3**：（不实现，本 task 只建 oracle）
- [ ] **提交** → `test(continuation): reproduce the documented anchor×continuation wire-index collision`

## Task 4.2：frontier 取代双偏移

- [ ] **Step 1**：（oracle 已在 4.1）
- [ ] **Step 2**：确认 4.1 红。
- [ ] **Step 3**：实现——
  - allocator 加 leg 语义（推荐 B：分配即映射）；driver 在进入续写腿时（`driver.ts:1491` 附近）调 `allocator.onLegStart()` 而非快照 `continuationOffset`。
  - 删除 `driver.ts:1186` 的第二层 `continuation.remap(outFrame, continuationOffset)`。
  - 删除 `wireDeliveredBlocks` / `continuationOffset` 的声明与递增（`:1071-1072`、`:1189`、`:1491`）。
  - `ContinuationHooks.remap` 若因此零消费者：**加 `@deprecated` 注释说明「wire index 唯一权威已迁至 allocator frontier」并保留**，交 P8.6 统一裁决是否删。理由：reviewer 的「无消费者可安全删除」类断言必须亲自复核，而跨格式（Responses/CC）续写腿可能仍在用——实施期 `rg -n "continuation.*remap" src/` 逐处核实。
- [ ] **Step 4**：跑，4.1 转绿 + `continuation-flow.it.test.ts` 回归（其 index 断言按需**改写**）。
- [ ] **Step 5**：mutation——把 `onLegStart()` 注释掉，确认 4.1 转红。
- [ ] **Step 6: 提交** → `fix(continuation): make the allocator frontier the sole wire-index authority`

## Task 4.3：跨格式核实（Responses / CC 续写腿）

> ADR D4：续写覆盖 Anthropic + Responses(HTTP/WS) + CC。本改造动的是 driver 层的共享 `runResponseBufferedSink`，故**必须核实**其它格式的续写腿是否也吃这条路径、是否因删 `continuationOffset` 而破。

- [ ] **Step 1**：`rg -n "continuation" src/routes/responses/ src/routes/chat-completions/` 核实各格式的 continuation 接线。
- [ ] **Step 2**：跑各格式的续写测试（`tests/e2e-client/continuation-sdk.it.test.ts`、`tests/responses/ws-buffered.it.test.ts` 等）。
- [ ] **Step 3**：若某格式因删 `continuationOffset` 而破——**这是真分叉**：要么该格式也接 allocator（Anthropic-specific 的 anchor hooks 在别的格式上是 undefined，此时 allocator 走 C3 短路、frontier 退化为纯计数，应可行），要么保留 `continuationOffset` 作为无-anchor 格式的路径（**但这违反 C4 的「单一权威」**）。停下记录 + 回主会话，不自行选。
- [ ] **提交** → `test(continuation): verify the frontier migration across every continuation-enabled format`

## P4 收口

- [ ] `typecheck` + `test:fast` 绿；O-1/O-2/O-6 绿。
- [ ] `rg -n "continuationOffset|wireDeliveredBlocks" src/` 零命中（或残留处已逐一交代）。
- [ ] 4.1 的 positive control 与主测试双向都验证过。
