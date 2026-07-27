# P3 — 三腿的「分配 + remap」完整矩阵

> **前置**：P1（allocator 归位）、**P2**（owner API —— 无它则没有可调的分配入口）。**产出**：三条腿各自的真实块分配与 remap 全部走单一权威。
> **承重项 1**。**注意 live 腿**：冻结设计 §4.2 的改动面列了 `live-reconcile.ts`，但设计正文的机制描述（§4.1）只谈 buffered；审查 F8 指出设计对 B 的改动清单漏了 live 腿，对 A 则**包含**它。

## plan review major：原方案只枚举 remap，漏了 allocate

审查坐实的问题：原 P3.2/P3.3 只说 S2/S3 「改走 `resolveRemappedFrame`」，**没有任何具名步骤在真实 `content_block_start` 上分配**。而 `realBlockOffset(upstreamIndex)` 只有在**开块时记录过 mapping** 才能 remap 后续 delta/stop——仅把硬编码 `1` 换成 resolver **不会自动创建 mapping**，S2/S3 会读到缺失或旧 mapping，续写腿 upstream index 重启时静默复用 index。

更隐蔽的是：原 P3.1 的测试用「手工推进 allocator 到多 anchor 状态」，**测试准备替实现完成了关键动作**，因此即使生产路径漏了分配也照样绿。

**故本相位改为「分配 + remap」的完整矩阵**，每条腿都必须具名回答三个问题：

| 腿 | start 帧谁分配？ | delta / stop 如何查 mapping？ | 如何保证同一块不重复分配？ |
|---|---|---|---|
| **S1** driver buffered flush（`driver.ts:1185`） | flush 循环内 `anchor.isContentBlockStart(frame)` 为真时经 owner API `allocateAndWriteRealBlock(upstreamIndex, …)` | 非 start 帧走 `resolveRemappedFrame`，查**当前腿**的 `realBlockOffset(upstreamIndex)` | 一个 upstream 块只有一个 start 帧；且分配后 mapping 已存在，重复分配会被 Task 3.4 的守卫测试咬住 |
| **S2** driver retreat（`driver.ts:1242`） | retreat 写穿循环内同样在 start 帧上调 owner API（**原 plan 漏此步**） | 同 S1 | 同 S1；另需注意 retreat 前已 flush 的块**不得**再分配一次（buffer 已清空，结构上不会重入——**须有测试**） |
| **S3** live-reconcile（`live-reconcile.ts:141`） | `reconcileLiveFrame` 见到真实 `content_block_start` 时分配（**原 plan 漏此步**）。注意它是**纯函数 + 装饰器**结构，分配是副作用 → 由装饰器 `makeReconcilingSink` 在写出前经 owner API 完成 | 同 S1 | live 腿逐帧透传，一个块一个 start |

**若某条腿的结构无法接入 owner API**（例如 S3 的纯函数边界），**停下回报**——这是 P2 owner 形状的真实性检验，不是实现细节。

## 三个站点（master 精确行号）

| # | 站点 | 当前代码 | 触发条件 |
|---|---|---|---|
| S1 | driver buffered flush | `driver.ts:1185` `let outFrame = injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame` | 每次 boundary/terminal flush 的每一帧 |
| S2 | driver retreat 分支 | `driver.ts:1242` `await sink.write(anchorState.injected && anchor && anchorState.anchorBlockOpen ? anchor.remap(toWrite, 1) : toWrite)` | buffer cap 超限后的 live 写穿 |
| S3 | live-reconcile | `live-reconcile.ts:141` `out.push(hooks.remap(frame, 1))` | live 路径（非 buffered）的每一真实帧 |

三处都是硬编码 `1`。C4：这个 `1` 与 `continuationOffset` 两个独立偏移都要被 frontier 取代（continuation 侧在 P4）。

## Files

- Modify: `src/lib/pipeline/driver.ts`（S1 + S2）
- Modify: `src/lib/anthropic/live-reconcile.ts`（S3）
- Modify: `src/lib/pipeline/types.ts`（若 `ReconcileHooks` 需要携 allocator 访问）
- Test: 改写 `tests/pipeline/retreat-anchor-collision.it.test.ts`、`tests/pipeline/live-reconcile-collision.it.test.ts`、`tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` 的 index 断言；新 `tests/pipeline/remap-sites-mutation.it.test.ts`

---

## Task 3.1：S1 driver buffered flush（分配 + remap）

> **测试纪律（plan review major）**：断言必须建立在**生产路径自己完成的分配**上。原方案「手工推进 allocator 到多 anchor 状态」会让测试准备替实现完成关键动作，即使生产漏了分配也照样绿——**禁止**。多 anchor 状态必须由**真实的 gap 静默**驱动出来（FakeClock 推进过 deadline），不是手工 `allocateAnchor()`。

- [ ] **Step 1: 写失败测试** —— 多 anchor 场景，全部状态由生产路径产生

```ts
// tests/pipeline/remap-sites-mutation.it.test.ts
test("S1 buffered flush allocates and remaps real blocks itself (no hand-primed allocator)", async () => {
  // gated upstream + FakeClock：真实块 → 过 deadline 静默（生产路径开 gap anchor）→ 第二个真实块
  // 断言 assertMonotonicWireIndices(frames) 且第二块落 frontier 值
  // 前置断言：allocator 的 anchorsOpened() 由生产路径推进（>0），非测试手工设置
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API `allocateAndWriteRealBlock`；非 start 帧走 `resolveRemappedFrame`。
- [ ] **Step 4**：跑，绿；`anchor-multiblock-lifecycle.it.test.ts` 预期仍绿（pre-content-only 场景 offset 仍是 1）。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap buffered-flush blocks via the frontier owner`

## Task 3.2：S2 driver retreat 分支（分配 + remap）

> retreat 是「buffer cap 超限 → 放弃缓冲 → 剩余帧 live 写穿」。它的 anchor 语义已由 `retreat-anchor-collision.it.test.ts` 锁住（避免双 message_start + index 撞车）。

- [ ] **Step 1: 写失败测试**：retreat 发生在 **gap anchor 已开过一次之后**，断言写穿的真实块 index 走 frontier；**并断言 retreat 前已 flush 的块没有被二次分配**（frontier 无跳号）。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API 分配（**原 plan 漏此步**），其余帧走 `resolveRemappedFrame`。
- [ ] **Step 4**：跑，绿 + `retreat-anchor-collision.it.test.ts` 回归。若该文件的断言写死了 `+1`，**改写为 frontier 断言（非删除）**。
- [ ] **Step 5: 提交** → `refactor(driver): allocate and remap retreat write-through blocks via the frontier owner`

## Task 3.3：S3 live-reconcile（设计正文漏、审查补）

> **为什么 live 腿仍要接**：块级 buffered 是既定终态，但 ① 迁移期 live 仍是当前生产默认（`protectStreamingGeneration: false`）；② retreat 之后的续流走 live 写穿；③ 留一个算 `+1` 的站点就是 C4 的反例，未来必然被误读。项目「无向后兼容负担 / 不留双轨包袱」。

- [ ] **Step 1: 写失败测试**：live 路径下多 anchor 场景的 index，**且 delta/stop 必须落在同一 wire index 上**（O-2 升级后的协议状态断言会咬住 orphan delta）。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——分两半：
  - **分配**（副作用）：`reconcileLiveFrame` 是**纯函数**（其 docstring 明写 "PURE except for the state-flag flips"），不能在里面做 wire 写。故分配由装饰器 `makeReconcilingSink`（`live-reconcile.ts:163`）在写出前经 owner API 完成。
  - **remap**（纯变换）：`reconcileLiveFrame` 内把 `hooks.remap(frame, 1)` 换成 `resolveRemappedFrame(frame, state.allocator, hooks)`。它已收 `state: AnchorState`（P1.3 起 allocator 在其中），**无需改签名**。
  - **注意 `hooks` 是 `ReconcileHooks` 不是 `AnchorHooks`**：核实两者 `remap` 签名一致后直接复用；若不一致，扩 `ReconcileHooks` 而非在 live 侧另写判断逻辑（单一权威）。
  - **若装饰器结构无法接入 owner API**（例如它拿不到 delivery session），**停下回报**——这是 P2 owner 形状的真实性检验。
- [ ] **Step 4**：跑，绿 + `live-reconcile-collision.it.test.ts` / `live-post-commit-anchor-closeoff.http.test.ts` 回归（结构断言按需改写）。
- [ ] **Step 5: 提交** → `refactor(live-reconcile): allocate and remap live blocks via the frontier owner`

## Task 3.4：退役 P1 的桥接断言 + **双维** mutation 矩阵

- [ ] **Step 1**：把 P1 的 `anchor-allocator-bridge.it.test.ts` 从「offset 恒等于固定 1」改写为「offset 等于 frontier 记账值」（**改写非删除**，它现在锁的是 C4）。
- [ ] **Step 2**：建 **6 格** mutation 矩阵——三条腿 × 两个维度（plan review major：只 mutate remap 不足以证明分配已接线）：
  - **维度 A（remap）**：把该站点的 `resolveRemappedFrame` 改回硬编码 `anchor.remap(frame, 1)`。
  - **维度 B（allocate）**：**删除**该站点的 `allocateAndWriteRealBlock` 调用（保留 remap）。这一维专门咬「mapping 从未被创建」的漏接线——原 plan 完全没有它。
  - 每格逐一确认**至少一条测试转红**，并记录是哪条。某格不打红 → 该维度无覆盖，补测试，不得跳过（`plan 红绿预测可能错、执行期真跑验证`）。
- [ ] **Step 3**：把矩阵结果写进本文件下方表。
- [ ] **提交** → `test(anchor): 6-cell mutation matrix over allocation and remap on all three legs`

## Task 3.5：golden 重捕

- [ ] **Step 1**：先跑 O-1/O-2 确认新 wire 结构正确（**顺序不可颠倒**——先证结构对，再改 golden）。
- [ ] **Step 2**：重捕 `tests/pipeline/buffered-anchor-golden.it.test.ts` 与受影响的 `c0-live-anchored-direct-stream-golden.http.test.ts`。
  - **预期**：pre-content-only 场景**不应有字节变化**（allocator 在该场景算出的 offset 就是 1）。**若这两个 golden 意外变红，那是回归信号而非预期重捕**——停下查根因，不要重捕。
- [ ] **Step 3**：重捕（如确有预期变化）单独一个 commit，与实现 commit 分离，让 diff 可审。
- [ ] **提交** → `test(anchor): re-capture goldens for the frontier wire`（仅在确有预期变化时）

## mutation 矩阵（实施期填写；**6 格**）

| 站点 | 维度 A：remap 改回硬编码 `1` | 维度 B：删除 allocate 调用 |
|---|---|---|
| S1 driver flush | _待填：转红的测试_ | _待填_ |
| S2 driver retreat | _待填_ | _待填_ |
| S3 live-reconcile | _待填_ | _待填_ |

## P3 收口

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件与基线对账（每处差异归因为「预期改写」或「回归已修」）。
- [ ] O-1/O-2 绿；O-6 字节等价**仍等于 P0 捕获的 base 基线**（本相位对无-anchor **主腿**请求应零字节变化）。
- [ ] `rg -n "remap\(.*, 1\)" src/` 零命中。
- [ ] **6 格 mutation 矩阵填满**，无空格（空格 = 该维度无覆盖）。
