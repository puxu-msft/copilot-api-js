# P4 — continuation frontier 统一（双偏移作废）

> **本文件是合并相位 P3M 的一部分**（round-3 blocker：原 P3/P4/P5 在测试可满足性上不可分）。相位权威 = [plan-3-remap-sites.md](plan-3-remap-sites.md)，本文件提供 **M5** 的任务细节。
> **相位内前置**：M2–M4（三腿已走 frontier）。**产出**：`continuationOffset` 退役，续写腿的块也从同一 frontier 分配；**两条**撞车 oracle（含默认的零-anchor 分支）。
> **承重项 3 / C4**（审查 F5）+ round-1 blocker 的另一半（C3 恒等短路的续写腿分支）。

## 两条撞车路径

### 路径一：零 anchor 的续写腿（**默认路径，本轮 blocker**）

不需要任何 anchor：主腿交付 `real@0` 后被 cut → 续写腿 upstream index 从 0 重启 → C4 要求分配 wire@1；但若按 C3 的**原**表述（`anchorsOpened()===0` 即短路）会原样重发 `real@0`，与已交付块撞 index。修法见 README「C3 的修订」——短路判据改为**映射恒等**：续写腿该块的 mapping 是 upstream0 → wire1，不恒等，必须 remap。

### 路径二：有 anchor 的撞车（审查 F5 给出，逐层核实过）

前提：`anchor@0 → real@1(上游0) → gap-anchor@2 → real@3(上游1)`，随后进入续写腿，其上游 index 从 **0 重启**。

1. 第一层 `anchor.remap(frame, realBlockOffset(0))`：`realWireIndices[0] = 1` → offset 1 → wire **1**；
2. 第二层 `continuation.remap(_, continuationOffset)`，`continuationOffset = wireDeliveredBlocks = 2`（`driver.ts:1189` 只对**真实块**递增、不含 anchor；`driver.ts:1491` 快照）→ wire **3**；
3. wire 3 **已被 `real@3` 占用** → 重复 index，与本轮 blocker 同型故障（真 SDK 会静默重排 content）。

根因：`realBlockOffset(upstreamIndex)` 用 `realWireIndices[upstreamIndex]` 查表，而续写腿的上游 index 从 0 重启，**命中主腿留下的旧映射**。

## 修法（frontier 唯一权威）

续写腿的真实块**不查旧映射**，而是从 frontier **继续分配新 index**。P2 已冻结 `beginLeg(kind)` 为 serializer command，allocator 侧的 leg 语义在 P2.1 落地（分配返回**不可变 `WireBlockMapping` token**，delta/stop 按 token 查，不查 ambient「当前腿」）。本相位负责把 driver 的双偏移退役、在**每个 upstream round** 上接 `beginLeg(kind)`。

> **不为 continuation 特判**（round-2 major）：`beginLeg` 对 **continuation 与 recovery 都调**。allocator 由「已成功写出的 frontier + 空的新腿 mapping」自然得出正确结果，两类腿无需分支——也避免「recovery 忘调时靠巧合正确」的脆弱性。recovery 的两种情形见 P2「recovery / leg 边界语义」表。

> 原 plan 曾列「A. leg-scoped 映射 / B. 分配即映射」两条候选待实施期选。**该选择已在 P2.1 冻结为 B（分配即映射）**——它让分配点与消费点合一、天然支持任意多腿，且是 owner API 的自然形状。此处不再重复裁决。

## Files

- Modify: `src/lib/anthropic/keepalive-anchor.ts`（allocator 的 leg 语义在 P2.1 已落地，本相位只接线）
- Modify: `src/lib/pipeline/driver.ts`（退役 `continuationOffset` / `wireDeliveredBlocks`；`:1186` 第二层 remap 删除；`:1491` 快照删除；`:1071-1072` 声明删除）
- Modify: `src/lib/pipeline/types.ts`（`ContinuationHooks.remap` / `isContentBlockStart` 若因此无消费者则**先标注、不删**——按 `no-destructive-workspace-loss`「绝不以清理死代码为名擅自删」，交 P8 doc-sync 时统一裁决）
- Test: 新 `tests/pipeline/continuation-frontier-collision.it.test.ts`；改写 `tests/pipeline/continuation-flow.it.test.ts` 的 index 断言

---

## Task 4.1：撞车序列重放 oracle（先红）——**两个分支，含默认路径**

> 这些测试**必须先于修复写出并跑红**。若写完就绿，说明序列没被正确构造（例如 continuation 分支根本没触发），必须调整直到红。
>
> **plan review blocker 修订**：原方案只写了「有 anchor」的撞车序列，**漏掉了更常见的默认分支**——零 anchor 的续写腿。后者在 C3 原表述下会因 `anchorsOpened()===0` 而整体跳过 remap、复用主腿的 wire 0。两个分支都必须有 red-first oracle。

- [ ] **Step 1a: 写失败测试（分支一：零 anchor 续写腿 —— 默认路径，blocker 分支）**

```ts
// tests/pipeline/continuation-frontier-collision.it.test.ts
test("NO-ANCHOR continuation leg must NOT re-deliver wire 0 (default ping mode; the blocker branch)", async () => {
  // 配置：stream_keepalive_mode: ping（默认），全程无 idle 升级 → anchorsOpened()===0
  // 序列：real block (上游0) → wire 0 已交付 → mid-stream cut → 续写腿上游 index 从 0 重启
  // 断言：
  assertMonotonicWireIndices(frames)     // O-1：续写块必须落 wire 1，wire 0 只能出现一次
  expect(anchorFramesIn(frames)).toHaveLength(0)   // 前置断言：这条路径确实一个 anchor 都没有
  expect(wireShape(frames)).toEqual([...])
})
```

- [ ] **Step 1b: 写失败测试（分支二：有 anchor 的撞车序列 —— 审查 F5 给的序列）**

```ts
test("continuation leg restarting its upstream index MUST NOT land on an occupied wire index", async () => {
  // pre-content anchor → wire 0；real (上游0) → wire 1；gap anchor → wire 2；real (上游1) → wire 3
  // 进入续写腿，上游 index 从 0 重启 → 必须落 wire 4（旧双偏移会算出已占用的 wire 3）
  assertMonotonicWireIndices(frames)
  assertBlockProtocolState(frames)
})
```

- [ ] **Step 1c: 两个 positive control**

```ts
test("POSITIVE CONTROL A: the harness reproduces the wire-0 reuse under an anchorsOpened-gated short circuit", async () => {
  // 注入一个按【原】C3 判据（anchorsOpened()===0 即短路）的 fake resolver，断言分支一的 O-1 会红
  // ——证明这条 oracle 真能咬住 blocker，而不是「续写腿根本没跑到」
})
test("POSITIVE CONTROL B: the harness reproduces the documented collision on the pre-fix double offset", async () => {
  // 注入仍按 realBlockOffset + continuationOffset 双偏移计算的 fake，断言分支二的 O-1 会红
})
```

- [ ] **Step 2**：跑，**两个主测试都必须红**。若分支一意外绿，先查 continuation 分支是否真的进入（`continuationCount` / `onContinuationLeg` 探针），修 harness 而非改断言。
- [ ] **Step 3**：（不实现，本 task 只建 oracle）
- [ ] **提交** → `test(continuation): red-first oracles for wire-index reuse on both the anchored and no-anchor legs`

## Task 4.2：frontier 取代双偏移

- [ ] **Step 1**：（oracle 已在 4.1）
- [ ] **Step 2**：确认 4.1 红。
- [ ] **Step 3**：实现——
  - driver 在进入**每个新 upstream round** 时调 `await port.beginLeg(kind)`——续写腿在 `driver.ts:1491` 附近（取代快照 `continuationOffset`）；**transparent recovery 腿同样要调**（`driver.ts:1409` 附近的 `attempt++` 分支），见 P2 recovery 表。
  - 删除 `driver.ts:1186` 的第二层 `continuation.remap(outFrame, continuationOffset)`。
  - 删除 `wireDeliveredBlocks` / `continuationOffset` 的声明与递增（`:1071-1072`、`:1189`、`:1491`）。
  - `ContinuationHooks.remap` 若因此零消费者：**加 `@deprecated` 注释说明「wire index 唯一权威已迁至 allocator frontier」并保留**，交 P8.6 统一裁决是否删。理由：reviewer 的「无消费者可安全删除」类断言必须亲自复核，而跨格式（Responses/CC）续写腿可能仍在用——实施期 `rg -n "continuation.*remap" src/` 逐处核实。
- [ ] **Step 4**：跑，4.1 转绿 + `continuation-flow.it.test.ts` 回归（其 index 断言按需**改写**）。
- [ ] **Step 5**：mutation——把 `beginLeg()` 注释掉，确认 4.1 转红；**另一格**：只在 continuation 调而 recovery 不调，确认 P2.2c 的 recovery 第二支转红。
- [ ] **Step 6: 提交** → `fix(continuation): make the allocator frontier the sole wire-index authority`

## Task 4.3：跨格式核实（Responses / CC 续写腿）

> ADR D4：续写覆盖 Anthropic + Responses(HTTP/WS) + CC。本改造动的是 driver 层的共享 `runResponseBufferedSink`，故**必须核实**其它格式的续写腿是否也吃这条路径、是否因删 `continuationOffset` 而破。

- [ ] **Step 1**：`rg -n "continuation" src/routes/responses/ src/routes/chat-completions/` 核实各格式的 continuation 接线。**已知事实（planner 核实）**：`ContinuationHooks` 目前**只有** Anthropic handler 构造（`handler-v4.ts:1280`），故本 task 很可能是**核实无事**而非真分叉。
- [ ] **Step 2**：跑各格式的续写测试（`tests/e2e-client/continuation-sdk.it.test.ts`、`tests/responses/ws-buffered.it.test.ts` 等）。
- [ ] **Step 3**：**先确认真实消费者，再判断是否真分叉**：
  - 若 grep + 测试确认**无其它格式消费** `continuationOffset` → 直接删，不停。**不得**为不存在的消费者保留双权威（那正是 C4 要消灭的东西）。
  - 若确有其它格式在用且因删而破 → **这才是真分叉**：要么该格式也接 allocator（其 anchor hooks 为 undefined 时 frontier 退化为纯计数，应可行），要么保留 `continuationOffset`（**违反 C4**）。停下记录 + 回主会话，不自行选。
- [ ] **提交** → `test(continuation): verify the frontier migration across every continuation-enabled format`

## M5 收口

- [ ] `typecheck` + `test:fast` 绿；O-1/O-2/O-6 绿。
- [ ] `rg -n "continuationOffset|wireDeliveredBlocks" src/` 零命中（或残留处已逐一交代）。
- [ ] 4.1 **两条**主测试（零 anchor 续写腿 + 有 anchor 撞车）与**两个** positive control 双向都验证过。
- [ ] `beginLeg()` 的两格 mutation（全删 / 仅 recovery 漏调）分别打红 4.1 与 P2.2c recovery 支。
