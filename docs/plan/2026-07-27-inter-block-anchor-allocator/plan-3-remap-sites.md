# P3 — remap 全站点接线（三处）

> **前置**：P1（allocator 归位）、P2（原子分配）。**产出**：三处 remap 站点全部改走 `resolveRemappedFrame` / frontier。
> **承重项 1**。**注意 live 腿**：冻结设计 §4.2 的改动面列了 `live-reconcile.ts`，但设计正文的机制描述（§4.1）只谈 buffered；审查 F8 指出设计对 B 的改动清单漏了 live 腿，对 A 则**包含**它。本相位把三处一并接线，不留任何一处旧偏移。

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

## Task 3.1：S1 driver buffered flush

- [ ] **Step 1: 写失败测试** —— 多 anchor 场景下 buffered flush 的 index

```ts
// tests/pipeline/remap-sites-mutation.it.test.ts
test("S1 buffered flush: with two anchors opened, the third real block lands at its frontier index", async () => {
  // 用 P2 的原子入口手工推进 allocator 到 anchor@0, real@1, anchor@2 的状态，
  // 再驱动一次 flush 携上游 index=1 的真实块 → 断言写出的是 index 3（不是 1+1=2）
})
```

- [ ] **Step 2**：跑，红（当前硬编码 `1` → 会写出 index 2）。
- [ ] **Step 3**：实现——S1 改为 `resolveRemappedFrame(frame, anchorState.allocator, anchor)`；真实块的 `allocateRealBlock` 调用点紧邻此处（`isContentBlockStart(frame)` 为真时分配）。
  - **谁调 `allocateRealBlock`**：必须**恰好一次**。候选点有二——driver flush 循环，或 delivery session 的 `applyPendingFrame`（它已在解析 `content_block_start`）。**选 driver flush**，理由：live 腿不走 driver flush（走 S3），而 delivery session 对两腿都生效会导致重复分配；且 driver 侧才知道「这是真实上游块」vs「这是 anchor 帧」。**实施期若发现该选择站不住（例如 S3 的帧也流经 delivery 的同一解析点），停下记录并回主会话——这是架构分叉，不自行改。**
- [ ] **Step 4**：跑，绿；`anchor-multiblock-lifecycle.it.test.ts` 预期仍绿（pre-content-only 场景 offset 仍是 1）。
- [ ] **Step 5: 提交** → `refactor(driver): route buffered flush remap through the allocator frontier`

## Task 3.2：S2 driver retreat 分支

> retreat 是「buffer cap 超限 → 放弃缓冲 → 剩余帧 live 写穿」。它的 anchor 语义已由 `retreat-anchor-collision.it.test.ts` 锁住（避免双 message_start + index 撞车）。

- [ ] **Step 1: 写失败测试**：retreat 发生在 **gap anchor 已开过一次之后**，断言写穿的真实块 index 走 frontier。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——S2 同样改走 `resolveRemappedFrame`。
- [ ] **Step 4**：跑，绿 + `retreat-anchor-collision.it.test.ts` 回归。若该文件的断言写死了 `+1`，**改写为 frontier 断言（非删除）**。
- [ ] **Step 5: 提交** → `refactor(driver): route retreat write-through remap through the allocator frontier`

## Task 3.3：S3 live-reconcile（设计正文漏、审查补）

> **为什么 live 腿仍要接**：块级 buffered 是既定终态，但 ① 迁移期 live 仍是当前生产默认（`protectStreamingGeneration: false`）；② retreat 之后的续流走 live 写穿；③ 留一个算 `+1` 的站点就是 C4 的反例，未来必然被误读。项目「无向后兼容负担 / 不留双轨包袱」。

- [ ] **Step 1: 写失败测试**：live 路径下多 anchor 场景的 index。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——`reconcileLiveFrame` 需要访问 allocator。它已收 `state: AnchorState`（P1.3 起 allocator 就在里面），故**无需改签名**，只把 `hooks.remap(frame, 1)` 换成 `resolveRemappedFrame(frame, state.allocator, hooks)`。
  - **注意 `hooks` 是 `ReconcileHooks` 不是 `AnchorHooks`**：核实两者的 `remap` 签名一致后直接复用；若不一致，扩 `ReconcileHooks` 而非在 live 侧另写一份判断逻辑（单一权威）。
- [ ] **Step 4**：跑，绿 + `live-reconcile-collision.it.test.ts` / `live-post-commit-anchor-closeoff.http.test.ts` 回归（结构断言按需改写）。
- [ ] **Step 5: 提交** → `refactor(live-reconcile): route live remap through the allocator frontier`

## Task 3.4：退役 P1 的桥接断言 + mutation 矩阵

- [ ] **Step 1**：把 P1 的 `anchor-allocator-bridge.it.test.ts` 从「offset 恒等于固定 1」改写为「offset 等于 frontier 记账值」（**改写非删除**，它现在锁的是 C4）。
- [ ] **Step 2**：建 mutation 矩阵——对 S1/S2/S3 各做一次**独立** mutation（把该站点改回硬编码 `1`），逐一确认**至少一条测试转红**。三个站点三次 mutation，逐条记录哪条测试咬住了它。
  - 若某站点的 mutation **不打红任何测试**，说明该站点无覆盖 → 补测试，不得跳过（`plan 红绿预测可能错、执行期真跑验证`）。
- [ ] **Step 3**：把矩阵结果写进本文件下方「mutation 矩阵」表。
- [ ] **提交** → `test(anchor): mutation matrix proving all three remap sites are covered`

## Task 3.5：golden 重捕

- [ ] **Step 1**：先跑 O-1/O-2 确认新 wire 结构正确（**顺序不可颠倒**——先证结构对，再改 golden）。
- [ ] **Step 2**：重捕 `tests/pipeline/buffered-anchor-golden.it.test.ts` 与受影响的 `c0-live-anchored-direct-stream-golden.http.test.ts`。
  - **预期**：pre-content-only 场景**不应有字节变化**（allocator 在该场景算出的 offset 就是 1）。**若这两个 golden 意外变红，那是回归信号而非预期重捕**——停下查根因，不要重捕。
- [ ] **Step 3**：重捕（如确有预期变化）单独一个 commit，与实现 commit 分离，让 diff 可审。
- [ ] **提交** → `test(anchor): re-capture goldens for the frontier wire`（仅在确有预期变化时）

## mutation 矩阵（实施期填写）

| 站点 | mutation | 转红的测试 | 备注 |
|---|---|---|---|
| S1 driver flush | `resolveRemappedFrame` → `anchor.remap(frame, 1)` | _待填_ | |
| S2 driver retreat | 同上 | _待填_ | |
| S3 live-reconcile | 同上 | _待填_ | |

## P3 收口

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件与基线对账（每处差异归因为「预期改写」或「回归已修」）。
- [ ] O-1/O-2 绿；O-6 字节等价**仍等于基线**（本相位对无-anchor 请求应零字节变化）。
- [ ] `rg -n "remap\(.*, 1\)" src/` 零命中。
