# P1 — allocator 状态归位（frontier 成为唯一权威）

> **实施状态（2026-07-28）**：P1 已完成，原子提交 U1=`e1a2fc39`、U2=`a0890d0c`、U3=`73e1d6be`。U2 初版曾让 `pipeline/types.ts` 反向 type-import `keepalive-anchor.ts`，`circular-deps-ratchet` 实测抓到后者新加入核心 SCC；最终把 allocator interface 归回 pipeline owner、Anthropic 模块只实现契约，守卫恢复绿。后续相位不得重新引入该反向边。
>
> **前置**：P0。**产出**：`GenerationWireIndexAllocator` 挂进共享 `AnchorState`，`AnchorHooks` 的三个固定-index 帧改为 factory，**恒等**短路 primitive 就位（C3 已按 plan review blocker 修订）。
> **本相位不改任何 remap 站点**（那是 P3）——本相位结束时三处 remap 仍走旧的固定 `+1`，且**必须与 allocator 记账一致**（commit invariant，见下方「等价桥接」）。

## Files

- Modify: `src/lib/anthropic/keepalive-anchor.ts`（allocator 加 `anchorsOpened()`；`anchorStartFrame`/`anchorDeltaFrame`/`anchorStopFrame` 由零参改为收 index 参数）
- Modify: `src/lib/pipeline/types.ts`（`AnchorState` 加 `allocator`；`AnchorHooks` 的 `startFrame`/`stopFrame`/`deltaFrame` 由 `ClientFrame` 改为 `(index: number) => ClientFrame`）
- Modify: `src/routes/messages/handler-v4.ts`（`buildAnthropicAnchorHooks` 产 factory；`makeAnchoredSseSink` 创建 generation allocator 并挂进 `anchorState`）
- Modify: `src/lib/anthropic/keepalive-anchor.ts` 的两个 injector（`makeSyntheticAnchorInjector` / `makeSyntheticEnvelopeInjector`）改为向 allocator 要 index
- Test: `tests/anthropic/sequential-anchor-allocator.unit.test.ts`（扩）、新 `tests/anthropic/anchor-frame-factory.unit.test.ts`

## Interfaces

- Produces:
  - `GenerationWireIndexAllocator.anchorsOpened: () => number`（**诊断计数，仅供断言/遥测**。它**不是** C3 短路判据——判据是该块 `WireBlockMapping` 的映射恒等，见 Task 1.4 与 README「C3 的修订」）
  - `AnchorState.allocator: GenerationWireIndexAllocator`（**必填**，非可选——类型系统逼出全部构造点，见 `feedback-fix-all-comparison-sites` 的正向版）
  - `AnchorHooks.startFrame: (index: number) => ClientFrame`（同 `stopFrame` / `deltaFrame`）
- Consumes: 既有 `createAnchorIndexAllocator`（`keepalive-anchor.ts:49-62`，已 landed 未接线；U1 内**一并重命名**为 `createGenerationWireIndexAllocator`，见 README「命名」小节）

---

## Task 1.1：allocator 加 `anchorsOpened`（**诊断计数**）—— **U1 的前半，与 1.2 同一 commit**

- [x] **Step 1: 写失败测试**

```ts
// tests/anthropic/sequential-anchor-allocator.unit.test.ts（追加）
test("anchorsOpened is a DIAGNOSTIC counter — never a remap predicate", () => {
  const a = createGenerationWireIndexAllocator()
  expect(a.anchorsOpened()).toBe(0)
  a.allocateRealBlock(0)                    // 真实块不算 anchor
  expect(a.anchorsOpened()).toBe(0)
  a.allocateAnchor()
  expect(a.anchorsOpened()).toBe(1)
})
```

- [x] **Step 2**：跑，红（`anchorsOpened` 不存在，TS 报错即算红）。
- [x] **Step 3**：实现——allocator 内部 `let anchorCount = 0`，分配 anchor 时递增，暴露 `anchorsOpened: () => anchorCount`。
- [x] **Step 4**：跑，绿。
- [x] **Step 5**：**不单独提交**——本 task 的改动随 U1（Task 1.2 Step 5）一次提交。

## Task 1.2：anchor 帧改 factory（固定 index 0 → 分配的 index）—— **与 1.1 同属 U1，一个 commit**

> 这是「`AnchorHooks.startFrame/stopFrame/deltaFrame` 当前固定 index 0，需改为按已分配 index 生成」（承重项 1）的落点。
>
> **U1 边界**：1.1 与 1.2 **必须同一个 commit**——`AnchorHooks` 的类型改动会打红全部构造点，拆开则中间 commit 不编译，违反 commit invariant。两者的失败测试可以分别先写，但只提交一次。

- [x] **Step 1: 写失败测试**

```ts
// tests/anthropic/anchor-frame-factory.unit.test.ts
test("anchor frames carry the allocated index, not a hardcoded 0", () => {
  expect(JSON.parse(anchorStartFrame(2).data as string)).toMatchObject({ type: "content_block_start", index: 2 })
  expect(JSON.parse(anchorDeltaFrame(2).data as string)).toMatchObject({ type: "content_block_delta", index: 2 })
  expect(JSON.parse(anchorStopFrame(2).data as string)).toMatchObject({ type: "content_block_stop", index: 2 })
})
test("index 0 remains byte-identical to the pre-change fixed frames", () => {
  // 锁住 pre-content anchor 场景的字节等价（C8 的组成部分）
  expect(anchorStartFrame(0).data).toBe('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}')
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现——三个 builder 收 `index: number`。**`ANCHOR_INDEX = 0` 常量的处置**：grep 全站点（`rg -n "ANCHOR_INDEX" src/ tests/`），把每个引用迁到显式 index；常量本身**保留**为 `PRE_CONTENT_ANCHOR_INDEX = 0` 并加注释说明它现在只是「frontier 的起点恰为 0」的可读别名，不再是协议常量。（不删——它是 pre-content 场景 golden 可读性的锚点；若 grep 后确认零引用则删，按 `broken-reference-supply-vs-delete` 的消费者契约判。）
- [x] **Step 4**：跑，绿；`AnchorHooks` 的类型改动会打红 `handler-v4.ts` 的 `buildAnthropicAnchorHooks` 与全部构造 `AnchorHooks` 的测试——**这些是类型系统逼出的全站点，逐处改，不得用 `as any` 绕过**。
- [x] **Step 5: 提交（U1 一次提交，含 Task 1.1 + 1.2 全部改动）** → `refactor(anchor): index-parameterized anchor frame factories and the anchorsOpened counter`

## Task 1.3：allocator 挂进 `AnchorState`，generation 级唯一

> 失效条件（设计 §4.7）：「不同腿重建 allocator」。故 allocator 必须在**每请求恰好创建一次**，且被 sink/driver/live-reconcile/continuation 全部读到同一个实例。

- [x] **Step 1: 写失败测试**

```ts
// tests/anthropic/anchor-allocator-identity.it.test.ts
test("one generation has exactly one allocator, shared across every leg", async () => {
  // 通过 makeAnchoredSseSink 构造 → 取回 anchorState.allocator 的引用
  // 驱动一次 buffered 请求（含一次 continuation leg）
  // 断言：driver / live-reconcile / injector 观察到的 allocator 是 SAME OBJECT
  //       （用一个探针 allocator 包装，记录每次 on*Open 的调用者标签）
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现——`AnchorState` 加**必填** `allocator: GenerationWireIndexAllocator`；`makeAnchoredSseSink`（`handler-v4.ts:1046-1090`）创建 `createGenerationWireIndexAllocator()` 放进 `anchorState`；**同一 commit 内**把两个 injector 的 anchor index 改为向 allocator 取（U2 的原子性要求：injector 要 index 必须在 allocator 可达之后）。
  - **注意**：`driver.ts:1090` 有一个 fallback `opts.anchorState ?? { injected: false, ... }`（`ping` 模式不 thread anchorState 时的驱动本地对象）。该 fallback 也必须带一个 allocator——用**同一个 `createGenerationWireIndexAllocator()`**，它在无 anchor 主腿上给出恒等 mapping（upstream i → wire i），天然满足 C3 的恒等短路。
- [x] **Step 4**：跑，绿 + 全量 `test:fast` 回归。
- [x] **Step 5: 提交（U2）** → `feat(anchor): thread a generation-scoped index allocator through AnchorState`

## Task 1.4：**恒等**短路（承重项 2 / C3——**已按 plan review blocker 修订**）—— **U3，独立 commit**

> **这是本计划风险控制的核心，也是本轮 blocker 的所在**。审查 F6 原本的建议是「`anchorsOpened === 0` 即无条件短路」，GPT plan review 证明该判据与 C4 冲突：**无 anchor 的续写腿**会因此跳过 remap、复用主腿已交付的 wire 0。修订后的判据是**映射恒等**——见 README「C3 的修订」小节的四场景表。
>
> 短路仍然必要（它把「记账错误」的爆炸半径限回真正需要 remap 的请求），但**它的成立条件必须自己也经得起对抗检验**（README 记的教训）。

- [x] **Step 1: 写失败测试** —— 四场景全覆盖，**含 blocker 分支**

```ts
// tests/pipeline/anchor-remap-short-circuit.unit.test.ts
// 场景 A：无 anchor 主腿 → 恒等 → 原对象直返（O-6 字节等价的机制保证）
test("no-anchor PRIMARY leg: structurally bypassed — the SAME frame object is returned", () => {
  const a = createGenerationWireIndexAllocator()
  const m = a.allocateRealBlock(0)                     // upstream 0 → wire 0 → 恒等
  const frame = realStartFrame(0)
  expect(resolveRemappedFrame(frame, m)).toBe(frame)   // 引用相等
})

// 场景 B：无 anchor 续写腿 —— BLOCKER 分支，原判据在此写出重复的 wire 0
test("no-anchor CONTINUATION leg: MUST remap even though anchorsOpened()===0", () => {
  const a = createGenerationWireIndexAllocator()
  a.allocateRealBlock(0)                               // 主腿 real@0
  a.beginLeg("continuation", src)                           // 续写腿：upstream index 重启
  const m = a.allocateRealBlock(0)                     // 该腿 upstream 0 → wire 1
  const frame = realStartFrame(0)
  const out = resolveRemappedFrame(frame, m)
  expect(a.anchorsOpened()).toBe(0)                    // 前置断言：确实没有任何 anchor
  expect(out).not.toBe(frame)                          // 不得短路
  expect(JSON.parse(out.data as string).index).toBe(1)
})

// 场景 C：无 anchor RECOVERY 腿，但此前写过 pre-content anchor（P2 recovery 表第二行）
test("no-anchor RECOVERY leg after an anchor was written: MUST remap", () => {
  const a = createGenerationWireIndexAllocator()
  a.allocateAnchor()                                   // pre-content anchor@0（attempt0 已写到 wire）
  a.beginLeg("recovery", src)                               // attempt0 首块前截断 → recovery
  const m = a.allocateRealBlock(0)                     // upstream 0 → wire 1
  expect(resolveRemappedFrame(realStartFrame(0), m)).not.toBe(realStartFrame(0))
})

// 场景 D：有 anchor 的主腿 → 一律 remap
test("anchor opened on the primary leg: remap engages", () => { /* ... */ })
```

- [x] **Step 2**：跑，红。**场景 B 是 blocker 的回归锁**——它必须在 primitive 写好前就红。
- [x] **Step 3**：实现共享 primitive（`fix-all-comparison-sites`：抽单一原语而非在三处 remap 各写一遍判断）：

```ts
// src/lib/anthropic/keepalive-anchor.ts
/**
 * The SINGLE decision point for "does this real block frame need a wire-index remap?".
 *
 * Short-circuits ONLY when the block's mapping is the IDENTITY (`wireIndex === upstreamIndex`).
 * That holds for a no-anchor PRIMARY leg — the overwhelmingly common case — whose frames are then
 * returned OBJECT-UNCHANGED, so the code path stays byte-identical to the pre-allocator behaviour
 * (C8/O-6).
 *
 * It does NOT hold merely because no anchor was opened: a continuation or recovery leg restarts its
 * upstream index at 0 while the frontier has already moved past it, so such frames MUST still be
 * remapped even though `anchorsOpened() === 0`. Short-circuiting on the anchor count alone
 * re-delivers wire 0 — the exact index-reuse failure this plan exists to prevent (README "C3 的修订").
 *
 * Takes the block's own immutable mapping rather than the allocator, so the decision never depends
 * on an ambient "current leg" that could shift across an await (P2 token model).
 */
export function resolveRemappedFrame(frame: ClientFrame, mapping: WireBlockMapping): ClientFrame
```

实现要点：判据读该块 **`WireBlockMapping` 的实际映射**（`mapping.wireIndex === mapping.upstreamIndex`）而非 anchor 计数——恒等本身就是充要条件，天然覆盖四个场景，且不依赖任何 ambient「当前腿」状态（P2 冻结的 token 模型）。`anchorsOpened()` 保留作**诊断与断言**用途，**不是**短路判据。

- [x] **Step 4**：跑，四场景全绿。
- [x] **Step 5**：加**架构守卫**，防止未来有人绕过 primitive 自己算 offset：

```ts
// tests/architecture/anchor-remap-single-authority.unit.test.ts
test("no source file computes an anchor remap offset outside resolveRemappedFrame", () => {
  // grep src/ 源码形状：除 keepalive-anchor.ts 外，不得出现 `.remap(` 后跟字面量数字
  // 正样本对照：故意在一个临时字符串里放 `.remap(frame, 1)` 证明检查会命中
})
test("no source file gates a remap on anchorsOpened() — the predicate is offset identity", () => {
  // 锁住 blocker 不复发：anchorsOpened() 不得出现在任何 remap 分支条件里
})
```

- [x] **Step 6: 提交** → `feat(anchor): single-authority remap primitive gated on mapping identity`

## 等价桥接与 commit invariant（**已按 plan review major 重排**）

审查坐实两处次序矛盾：① P1.2 要求两个 injector「向 allocator 要 index」，但 allocator 到 P1.3 才挂进共享 state——按原顺序 P1.2 无法独立提交；② P1 收口原本要求「`onRealBlockOpen` 已在生产正确调用」才能证明桥接，但**真实块的分配要到 P3.1 才接线**（且依赖 P2 的 owner API），于是桥接测试只能靠测试手工推进 allocator——那正是「测试准备替实现完成关键动作」的假绿。

**重排后的原子提交单元**：

| 单元 | 内容 | 为何原子 |
|---|---|---|
| **U1 = Task 1.1 + 1.2**（一个 commit） | allocator 加 `anchorsOpened()`；三个 anchor 帧改 index-parameterized factory；`AnchorHooks` 类型随之改；**全部构造点同步改** | 类型改动会打红所有 `AnchorHooks` 构造点，拆开则中间 commit 不编译 |
| **U2 = Task 1.3**（一个 commit） | allocator 挂进 `AnchorState`（必填）+ generation owner 创建 + **pre-content anchor 的分配接线**（injector 经 allocator 取 index） | injector 要 index 必须在 allocator 可达之后；两者同 commit 才有意义 |
| **U3 = Task 1.4**（一个 commit） | 恒等短路 primitive + 架构守卫 | 纯新增，不改调用方 |

**P1 期间成立的 commit invariant（精确表述，不夸大）**：

- **anchor 侧**：pre-content anchor 的 index 由 allocator 分配（U2 起），生产路径真实推进 frontier。
- **真实块侧**：**尚未**接线（P3.1 才接，它依赖 P2 的 owner API）。故 P1 期间 `realBlockOffset` **没有生产消费者** —— 三处 remap 仍读固定 `1`。
- 因此 P1 的桥接断言**只能也只应**覆盖 anchor 侧：**pre-content-only 场景下 allocator 分配给 anchor 的 index === 0**，等价于旧的 `ANCHOR_INDEX = 0`，wire 字节不变（O-6）。
- **绝不允许**的中间态：allocator 已按 frontier 分配多个 anchor，但某处 remap 还在算 `+1`。这由相位顺序保证——**gap anchor（多 anchor 的唯一来源）在 P5，remap 切换在 P3，P3 早于 P5**。

- [x] **Step**: 写桥接断言 `tests/pipeline/anchor-allocator-bridge.it.test.ts`——断言 pre-content anchor 场景下 allocator 分配的 index 为 0 且 wire 字节与 P0 基线一致。**不**断言真实块 offset（那时还没接线，断了就是自欺）。
- [x] **随 U2 一并提交**（**不单独成 commit**——它验证的正是 U2 的 pre-content 分配接线，与之同属一个语义单元；round-2 minor：原文单列一次提交与收口的「恰好三个 commit」矛盾）。

## P1 收口

- [x] `typecheck` + `test:fast` 绿；anchor 全套件与 P0 基线同 pass 数（或差异已逐条归因）。
- [x] O-1 / O-2 仍绿；O-6 字节等价仍等于 P0 捕获的 base 基线（**本相位不应改变任何 wire 字节**）。
- [x] `rg -n "ANCHOR_INDEX" src/ tests/` 结果已逐处交代。
- [x] **恰好三个 commit（U1 / U2 / U3）**，每个终态都 typecheck + test:fast 绿。
- [x] 桥接断言**只覆盖 anchor 侧**（真实块分配尚未接线，不得伪造该维度的断言）。
