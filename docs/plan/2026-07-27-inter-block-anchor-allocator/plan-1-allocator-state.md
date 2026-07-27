# P1 — allocator 状态归位（frontier 成为唯一权威）

> **前置**：P0。**产出**：`AnchorIndexAllocator` 挂进共享 `AnchorState`，`AnchorHooks` 的三个固定-index 帧改为 factory，`anchorsOpened === 0` 结构性短路就位。
> **本相位不改任何 remap 站点**（那是 P3）——本相位结束时三处 remap 仍走旧的固定 `+1`，且**必须与 allocator 记账一致**（commit invariant，见下方「等价桥接」）。

## Files

- Modify: `src/lib/anthropic/keepalive-anchor.ts`（allocator 加 `anchorsOpened()`；`anchorStartFrame`/`anchorDeltaFrame`/`anchorStopFrame` 由零参改为收 index 参数）
- Modify: `src/lib/pipeline/types.ts`（`AnchorState` 加 `allocator`；`AnchorHooks` 的 `startFrame`/`stopFrame`/`deltaFrame` 由 `ClientFrame` 改为 `(index: number) => ClientFrame`）
- Modify: `src/routes/messages/handler-v4.ts`（`buildAnthropicAnchorHooks` 产 factory；`makeAnchoredSseSink` 创建 generation allocator 并挂进 `anchorState`）
- Modify: `src/lib/anthropic/keepalive-anchor.ts` 的两个 injector（`makeSyntheticAnchorInjector` / `makeSyntheticEnvelopeInjector`）改为向 allocator 要 index
- Test: `tests/anthropic/sequential-anchor-allocator.unit.test.ts`（扩）、新 `tests/anthropic/anchor-frame-factory.unit.test.ts`

## Interfaces

- Produces:
  - `AnchorIndexAllocator.anchorsOpened: () => number`（C3 结构性短路的判据）
  - `AnchorState.allocator: AnchorIndexAllocator`（**必填**，非可选——类型系统逼出全部构造点，见 `feedback-fix-all-comparison-sites` 的正向版）
  - `AnchorHooks.startFrame: (index: number) => ClientFrame`（同 `stopFrame` / `deltaFrame`）
- Consumes: 既有 `createAnchorIndexAllocator`（`keepalive-anchor.ts:49-62`，已 landed 未接线）

---

## Task 1.1：allocator 加 `anchorsOpened`（C3 的判据）

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/sequential-anchor-allocator.unit.test.ts（追加）
test("anchorsOpened is the structural short-circuit predicate", () => {
  const a = createAnchorIndexAllocator()
  expect(a.anchorsOpened()).toBe(0)
  a.onRealBlockOpen()                       // 真实块不算 anchor
  expect(a.anchorsOpened()).toBe(0)
  expect(a.realBlockOffset(0)).toBe(0)      // 无 anchor → offset 恒 0（byte-equivalent 路径）
  a.onAnchorOpen()
  expect(a.anchorsOpened()).toBe(1)
})
```

- [ ] **Step 2**：跑，红（`anchorsOpened` 不存在，TS 报错即算红）。
- [ ] **Step 3**：实现——allocator 内部 `let anchorCount = 0`，`onAnchorOpen` 递增，暴露 `anchorsOpened: () => anchorCount`。
- [ ] **Step 4**：跑，绿。
- [ ] **Step 5: 提交** → `feat(anchor): expose anchorsOpened as the allocator short-circuit predicate`

## Task 1.2：anchor 帧改 factory（固定 index 0 → 分配的 index）

> 这是「`AnchorHooks.startFrame/stopFrame/deltaFrame` 当前固定 index 0，需改为按已分配 index 生成」（承重项 1）的落点。

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——三个 builder 收 `index: number`。**`ANCHOR_INDEX = 0` 常量的处置**：grep 全站点（`rg -n "ANCHOR_INDEX" src/ tests/`），把每个引用迁到显式 index；常量本身**保留**为 `PRE_CONTENT_ANCHOR_INDEX = 0` 并加注释说明它现在只是「frontier 的起点恰为 0」的可读别名，不再是协议常量。（不删——它是 pre-content 场景 golden 可读性的锚点；若 grep 后确认零引用则删，按 `broken-reference-supply-vs-delete` 的消费者契约判。）
- [ ] **Step 4**：跑，绿；`AnchorHooks` 的类型改动会打红 `handler-v4.ts` 的 `buildAnthropicAnchorHooks` 与全部构造 `AnchorHooks` 的测试——**这些是类型系统逼出的全站点，逐处改，不得用 `as any` 绕过**。
- [ ] **Step 5: 提交** → `refactor(anchor): make anchor frames index-parameterized factories`

## Task 1.3：allocator 挂进 `AnchorState`，generation 级唯一

> 失效条件（设计 §4.7）：「不同腿重建 allocator」。故 allocator 必须在**每请求恰好创建一次**，且被 sink/driver/live-reconcile/continuation 全部读到同一个实例。

- [ ] **Step 1: 写失败测试**

```ts
// tests/anthropic/anchor-allocator-identity.it.test.ts
test("one generation has exactly one allocator, shared across every leg", async () => {
  // 通过 makeAnchoredSseSink 构造 → 取回 anchorState.allocator 的引用
  // 驱动一次 buffered 请求（含一次 continuation leg）
  // 断言：driver / live-reconcile / injector 观察到的 allocator 是 SAME OBJECT
  //       （用一个探针 allocator 包装，记录每次 on*Open 的调用者标签）
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现——`AnchorState` 加**必填** `allocator: AnchorIndexAllocator`；`makeAnchoredSseSink`（`handler-v4.ts:1046-1090`）创建 `createAnchorIndexAllocator()` 放进 `anchorState`。
  - **注意**：`driver.ts:1090` 有一个 fallback `opts.anchorState ?? { injected: false, ... }`（`ping` 模式不 thread anchorState 时的驱动本地对象）。该 fallback 也必须带一个 allocator——用**同一个 `createAnchorIndexAllocator()`**，它在无 anchor 时 `anchorsOpened()===0`、`realBlockOffset` 恒 0，天然走 C3 短路。
- [ ] **Step 4**：跑，绿 + 全量 `test:fast` 回归。
- [ ] **Step 5: 提交** → `feat(anchor): thread a generation-scoped index allocator through AnchorState`

## Task 1.4：`anchorsOpened === 0` 结构性短路（承重项 2 / C3）

> **这是本计划风险控制的核心**。审查 F6：A 把今天被 `injected && anchor && anchorBlockOpen` 三重门挡住的死 remap 路径变成每请求热路径；记账错一处，受害的不再只是升级过的请求，而是**全部**普通短请求，且症状是静默重排。

- [ ] **Step 1: 写失败测试** —— 正/负样本对照（`pass-null-clean-not-self-validating`：不能只测「没开 anchor 时结果一样」，要**证明检查确实触达了两条不同的代码路径**）

```ts
// tests/pipeline/anchor-remap-short-circuit.unit.test.ts
test("NEGATIVE (no anchor opened): remap is structurally bypassed — the SAME frame object is returned", () => {
  const allocator = createAnchorIndexAllocator()
  allocator.onRealBlockOpen()
  const frame = realStartFrame(0)
  const out = resolveRemappedFrame(frame, allocator, anchorHooks)   // 待实现的共享 primitive
  expect(out).toBe(frame)                 // 引用相等 —— 不是「值相等」，是 structural bypass 的证据
})
test("POSITIVE (anchor opened): remap engages and shifts the index", () => {
  const allocator = createAnchorIndexAllocator()
  allocator.onAnchorOpen()                // anchor@0
  allocator.onRealBlockOpen()             // real@1
  const frame = realStartFrame(0)
  const out = resolveRemappedFrame(frame, allocator, anchorHooks)
  expect(out).not.toBe(frame)
  expect(JSON.parse(out.data as string).index).toBe(1)
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：实现一个**共享 primitive**（`fix-all-comparison-sites`：归一化/索引 bug 几乎总在多比较点复发，故抽单一原语而非在三处 remap 各写一遍判断）：

```ts
// src/lib/anthropic/keepalive-anchor.ts
/**
 * The SINGLE decision point for "does this real block frame need a wire-index remap?".
 * Structural short-circuit (C3): a generation that never opened an anchor returns the frame
 * OBJECT UNCHANGED — the code path is identical to the pre-allocator behaviour, so a普通短请求
 * cannot be corrupted by an index-accounting bug. Every remap site (driver buffered flush,
 * driver retreat, live-reconcile) MUST route through this, never re-derive the condition.
 */
export function resolveRemappedFrame(frame, allocator, anchor): ClientFrame
```

- [ ] **Step 4**：跑，绿。
- [ ] **Step 5**：加一条**架构守卫**测试，防止未来有人绕过 primitive 自己算 offset：

```ts
// tests/architecture/anchor-remap-single-authority.unit.test.ts
test("no source file computes an anchor remap offset outside resolveRemappedFrame", () => {
  // grep src/ 源码形状：除 keepalive-anchor.ts 外，不得出现 `.remap(` 后跟字面量数字
  // （正样本对照：故意在一个临时字符串里放 `.remap(frame, 1)` 证明检查会命中）
})
```

- [ ] **Step 6: 提交** → `feat(anchor): single-authority remap primitive with a structural no-anchor bypass`

## 等价桥接（commit invariant，本相位承重）

本相位结束时 allocator 已在记账，但三处 remap **仍未切换**（P3 才切）。为保证每个中间 commit 的终态不变量成立：

- Task 1.3 落地后，allocator 的 `onAnchorOpen`/`onRealBlockOpen` **必须已被正确调用**（sink 开块时），否则 P3 一切就错。
- 但 remap 仍读固定 `1` → 此时必须成立：**pre-content-only 场景下 `allocator.realBlockOffset(i) === 1` 恒等于旧的固定 `1`**。
- 因此 P1 收口必须有一条**桥接断言**测试：在当前（pre-content-only）行为下，对每个真实块断言 `allocator.realBlockOffset(upstreamIndex) === (anchorBlockOpen ? 1 : 0)`。这条测试在 P5 引入 gap anchor 后会**按设计失效**（多 anchor 时 offset 会 >1），届时改写为「offset 等于 frontier 记账值」——在 P3 的 Task 3.4 处理。
- **绝不允许**的中间态：allocator 已按 frontier 分配（多 anchor），但某个 remap 站点还在算 `+1`。P5 必须在 P3 之后。

- [ ] **Step**: 写桥接断言 `tests/pipeline/anchor-allocator-bridge.it.test.ts`，跑绿。
- [ ] **提交** → `test(anchor): assert allocator accounting matches the legacy fixed offset (bridge invariant)`

## P1 收口

- [ ] `typecheck` + `test:fast` 绿；anchor 全套件与 P0 基线同 pass 数（或差异已逐条归因）。
- [ ] O-1 / O-2 仍绿；O-6 字节等价仍等于基线（**本相位不应改变任何 wire 字节**）。
- [ ] `rg -n "ANCHOR_INDEX" src/ tests/` 结果已逐处交代。
