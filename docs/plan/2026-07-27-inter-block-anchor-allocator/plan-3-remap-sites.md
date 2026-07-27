# P3 — 三腿的「分配 + remap」完整矩阵

> **前置**：P1（allocator 归位）、**P2**（owner API —— 无它则没有可调的分配入口）。**产出**：三条腿各自的真实块分配与 remap 全部走单一权威。
> **承重项 1**。**注意 live 腿**：冻结设计 §4.2 的改动面列了 `live-reconcile.ts`，但设计正文的机制描述（§4.1）只谈 buffered；审查 F8 指出设计对 B 的改动清单漏了 live 腿，对 A 则**包含**它。

## plan review major：原方案只枚举 remap，漏了 allocate

审查坐实的问题：原 P3.2/P3.3 只说 S2/S3 「改走 `resolveRemappedFrame`」，**没有任何具名步骤在真实 `content_block_start` 上分配**。而 `realBlockOffset(upstreamIndex)` 只有在**开块时记录过 mapping** 才能 remap 后续 delta/stop——仅把硬编码 `1` 换成 resolver **不会自动创建 mapping**，S2/S3 会读到缺失或旧 mapping，续写腿 upstream index 重启时静默复用 index。

更隐蔽的是：原 P3.1 的测试用「手工推进 allocator 到多 anchor 状态」，**测试准备替实现完成了关键动作**，因此即使生产路径漏了分配也照样绿。

## plan review round-2 blocker：P3 的红绿门曾不可满足（已重切）

第二轮审查坐实一个**循环依赖**：P3 原本要求「多 anchor 状态必须由**真实 gap 静默**驱动」，但 gap anchor 要到 P5 才开放（`semanticBlockCount===0` 门仍在、per-gap latch 与 gap injector 都不存在），而 DAG 又强制 `P3→P5`。于是 P3 阶段生产路径**最多只能有一个 pre-content anchor**，offset 恒为 1——把 remap 改回硬编码 `1` 结果完全相同，**mutation 不会红**，6 格矩阵形同虚设。

### 重切方案：测试用 **P2 的生产 owner API** 显式落 anchor，真实块仍全由生产路径分配 + remap

P3 的测试**不**等 heartbeat 决定注入，而是直接调用 `WireBlockAllocationPort.allocateAndWriteAnchor`——那是 **P5 的 heartbeat 将来要调的同一个生产 API**，经同一个 serializer、真写到 sink。测试只负责「让 wire 上出现第 N 个 anchor」这一个触发动作，**真实块的分配与 remap 一律由生产代码（driver flush / retreat / live 装饰器）完成，测试一行都不碰**。

产生 offset >= 2 的最小合法序列（每个 anchor 各自 open→close，**不违反 C2**）：

```text
anchor@0（测试经 owner API 落）→ real@1（上游0，生产分配）
anchor@2（测试经 owner API 落）→ real@3（上游1，生产分配）→ offset = 2
```

把任一站点的 remap 改回硬编码 `1`，第二个真实块会落 wire 2（已被 anchor 占用）而非 wire 3 → **O-1 转红**。维度 B（删 allocate 调用）则让 mapping 从未创建 → 同样红。

### 为什么这不会重新引入假绿（**必须论证，审查明确要求**）

| 关注点 | 处置 |
|---|---|
| 会不会像「手工推进 allocator」那样，测试替实现完成了关键动作？ | **不会**。被测的动作是**真实块的分配 + remap**，它 100% 由生产路径执行；测试只提供 anchor 这个**前置 wire 状态**。若 driver 漏调分配、或 remap 读错 mapping，测试照红。 |
| 这算不算「测试专用后门」？ | **不算**。`allocateAndWriteAnchor` 是 P2 冻结的**生产** owner API，P5 的 heartbeat 走的就是它。测试与生产的差别只在**谁触发**，不在**走哪条路径**。故无需额外守卫，既有架构守卫（生产只能经 owner API）已足够。 |
| 「谁触发 anchor」这一环由谁证明？ | 由 **P5 的 O-3** 证明：heartbeat 在真实 gap 静默下确实调用同一 owner API。P3 证「给定 anchor 已在 wire 上，三腿的 index 记账正确」，P5 证「anchor 会在该出现的时候出现」。**两者合起来无缺口**，且各自都有可满足的红绿门。 |
| 会不会造成计划自己禁止的半坏态？ | **不会**。P5 的门在 P3 期间**保持不动**，生产路径此时仍最多一个 anchor。多-anchor 状态只存在于测试进程内，不是可交付的生产行为。 |

**若实施中发现 owner API 无法作为测试 seam 驱动某一腿**（例如该腿的 sink 拿不到 port），则退路是：把 P3 的三站点与 P5 的开门**合并为一个原子 commit**，提交前一次性过全部 oracle——**不得**维持「分相位但门不可满足」的现状。这条退路**须停下回报**后再走，因为它改变相位边界。

| 腿 | start 帧谁分配？ | delta / stop 如何查 mapping？ | 如何保证同一块不重复分配？ |
|---|---|---|---|
| **S1** driver buffered flush（`driver.ts:1185`） | flush 循环内 `anchor.isContentBlockStart(frame)` 为真时经 owner API `withAllocatedRealBlock(upstreamIndex, …)` | 非 start 帧走 `resolveRemappedFrame`，按该块的 **leg token + mapping** 查 | 一个 upstream 块只有一个 start 帧；重复分配会被 3.4 维度 B 的 mutation 咬住 |
| **S2** driver retreat（`driver.ts:1242`） | retreat 写穿循环内同样在 start 帧上调 owner API（**原 plan 漏此步**） | 同 S1 | 同 S1；retreat 前已 flush 的块**不得**再分配（buffer 已清空，结构上不会重入——**须有测试**） |
| **S3** live-reconcile（`live-reconcile.ts:141`） | 装饰器 `makeReconcilingSink` 经 `getDownstreamDeliverySession(inner)` 取 port，在**一个 transaction** 内完成「close-off stop + 分配 + remapped start」（见下方 S3 专节） | 同 S1 | live 腿逐帧透传，一个块一个 start |

### S3 专节（**round-2 major：原方案站不住，已重做**）

原方案写「`reconcileLiveFrame` 是纯函数 → 分配归装饰器」，方向对但**与冻结的 owner API 形状不兼容**。planner 复核了三条代码事实：

1. **port 可达**（reviewer 结论成立）：`makeDeliverySseSink` 返回 `delivery.clientSink`，`deliveryBySink` 正以它为 key（`session.ts:262`）；而 `makeReconcilingSink(inner, …)` 的 `inner` **就是**这个原 delivery sink（`handler-v4.ts:1206-1207`）。故装饰器可经 `getDownstreamDeliverySession(inner)` 拿到 session。**不需要**让 wrapped sink 再注册一次。
2. **真正的冲突在 provenance**：`reconcileLiveFrame` 对首个真实 start 返回**两帧** `[stopFrame, remapped]`（`live-reconcile.ts:139-141`），且装饰器靠**位置**区分它们——`frames[0]` 走 `writeAnchor`（打 `synthetic:"anchor"`），其余走 `write`（不打标）（`:171-174`）。而原 `allocateAndWriteRealBlock(upstreamIndex, build)` 的 `build` 只返回 `ReadonlyArray<ClientFrame>`，**丢失 provenance**，owner 无从知道哪帧该走哪个底层 port。
3. **拆成两次写会破坏原子性**：若装饰器先单独写 stop 再调 port 写 start，就是**两个 serializer operation**，heartbeat 可插进中间——正是 C5 要消灭的形状。（注：今天的装饰器确实是两次 `await`，但今天没有分配动作，所以只是顺序问题；引入分配后它就成了 TOCTOU。）

**重做后的 API 形状**（P2「Interfaces」是权威定义，此处只摘要其对 S3 的意义）：

```ts
withAllocatedRealBlock(
  upstreamIndex: number,
  build: (ctx: { mapping: WireBlockMapping }) => ReadonlyArray<DeliveryFrame>,
): Promise<WireBlockMapping | undefined>
```

关键点：callback 返回**带 provenance 的 `DeliveryFrame`**（而非裸 `ClientFrame`），owner 据此把 close-off 路由到 `writeAnchor`、真实帧路由到 `write`，**不再靠数组位置猜**；`ctx.mapping` 是该块的**不可变 token**，其 `remap()` 在恒等时返回原对象（C3）。

S1/S2 用它时 callback 只返回一帧（remapped start，provenance = 真实帧）；S3 用它时按需返回两帧（close-off stop 带 `syntheticKind:"anchor"` + remapped start）。**三腿共用同一个 owner API，无特例分支。**

> **S3 不再有「拿不到就停」的模糊退路**——port 可达性已由上述代码事实确认，S3 是冻结的必做范围。仅当实施时发现 `DeliveryFrame` 的构造在装饰器侧不可行（例如缺 sequence/observedAt 来源）才停下回报。

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

> **测试纪律（两轮 review 综合）**：被测动作 = **真实块的分配 + remap**，必须 100% 由生产路径完成——**禁止**手工推进 allocator（那会让测试准备替实现干活，生产漏分配照样绿）。但 anchor 这个**前置 wire 状态**由测试经 **P2 的生产 owner API** `allocateAndWriteAnchor` 落下（理由与防假绿论证见本文件头部「round-2 blocker」小节）——**不是**等 heartbeat，因为 gap anchor 要到 P5 才开放，等它会造成红绿门不可满足。

- [ ] **Step 1: 写失败测试** —— offset >= 2 的场景，真实块全由生产路径分配 + remap

```ts
// tests/pipeline/remap-sites-mutation.it.test.ts
test("S1 buffered flush allocates and remaps real blocks itself at frontier offset >= 2", async () => {
  // 前置（测试经生产 owner API 落 anchor，不碰 allocator 内部）：
  //   await port.allocateAndWriteAnchor(...)         → anchor@0
  //   驱动上游真实块（上游 index 0）                  → 生产分配 wire@1
  //   await port.allocateAndWriteAnchor(...)         → anchor@2
  //   驱动上游真实块（上游 index 1）                  → 生产分配 wire@3   ← offset 2
  assertMonotonicWireIndices(frames)   // 硬编码 +1 会让第二块落已被占用的 wire@2 → 红
  assertBlockProtocolState(frames)
  // 前置断言：两个 anchor 确实在 wire 上（证明场景真的建立起来了）
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——start 帧经 owner API `withAllocatedRealBlock`；非 start 帧走 `resolveRemappedFrame`。
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

- [ ] **Step 1: 写失败测试**（**用生产 delivery sink，非 raw sink**）：live 路径下 offset >= 2 的场景（anchor 经 owner API 落，真实块由生产路径分配 + remap），断言：
  - `assertMonotonicWireIndices` + `assertBlockProtocolState`（delta/stop 必须落在同一 wire index，orphan delta 会被咬住）；
  - **close-off stop 带 `synthetic:"anchor"` 标记**，remapped start **不带**标记（C7；这是本 task 最容易在重构中丢的东西）；
  - close-off 与 real start **在同一个 serializer transaction 内**——用一个在两帧之间尝试插入 keepalive 的探针证明它插不进去。
- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——
  - **取 port**：装饰器经 `getDownstreamDeliverySession(inner)` 拿 session 的 allocation port。`inner` 就是原 delivery sink（`handler-v4.ts:1206-1207` → `makeDeliverySseSink` 返回的 `delivery.clientSink`，正是 `deliveryBySink` 的 key，`session.ts:262`），故可达。
  - **一个 transaction 出两帧**：装饰器在见到真实 `content_block_start` 时调 `withAllocatedRealBlock(upstreamIndex, ({ remap }) => [...])`，callback 返回**带 provenance 的 `DeliveryFrame`**：需要 close-off 时返回 `[anchorStop(synthetic:"anchor"), remap(start)(真实)]`，否则只返回 `[remap(start)]`。owner 按 provenance 路由到 `writeAnchor` / `write`，**不再靠数组位置猜**。
  - **`reconcileLiveFrame` 保持纯函数**：它继续负责「要不要 close-off」+ remap 变换，只是 remap 改用绑定到本块 mapping 的 `resolveRemappedFrame`；**副作用（分配 + 写）全在装饰器的 transaction 内**。
  - **非 start 帧**（delta/stop/终止符）仍走装饰器的普通 write 路径，remap 按该块 mapping 查。
  - **注意 `hooks` 是 `ReconcileHooks` 不是 `AnchorHooks`**：核实两者 `remap` 签名一致后直接复用；若不一致，扩 `ReconcileHooks` 而非在 live 侧另写判断逻辑（单一权威）。
- [ ] **Step 4**：跑，绿 + `live-reconcile-collision.it.test.ts` / `live-post-commit-anchor-closeoff.http.test.ts` 回归（结构断言按需改写）。
- [ ] **Step 5**：mutation——把两帧拆成两次独立写（今天的形状），确认「transaction 内不可插入」的断言转红。
- [ ] **Step 6: 提交** → `refactor(live-reconcile): allocate, close off and remap live blocks in one wire transaction`

## Task 3.4：退役 P1 的桥接断言 + **双维** mutation 矩阵

- [ ] **Step 1**：把 P1 的 `anchor-allocator-bridge.it.test.ts` 从「offset 恒等于固定 1」改写为「offset 等于 frontier 记账值」（**改写非删除**，它现在锁的是 C4）。
- [ ] **Step 2**：建 **6 格** mutation 矩阵——三条腿 × 两个维度（plan review major：只 mutate remap 不足以证明分配已接线）：
  - **维度 A（remap）**：把该站点的 `resolveRemappedFrame` 改回硬编码 `anchor.remap(frame, 1)`。
  - **维度 B（allocate）**：**删除**该站点的 `withAllocatedRealBlock` 调用（保留 remap）。这一维专门咬「mapping 从未被创建」的漏接线——原 plan 完全没有它。
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
