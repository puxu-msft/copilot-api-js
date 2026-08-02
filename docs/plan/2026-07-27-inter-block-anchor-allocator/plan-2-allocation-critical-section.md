# P2 — 分配临界区（heartbeat vs flush 的并发缝）

> **实施状态（2026-07-28）**：P2 已完成（Task 2.1–2.3），owner/C9/C10/C11 leg fence 与架构守卫均落地；标准 `unit it http` 在隔离 worktree、16 shards、复制同基线 native history-search artifact 后连续三轮 `6550/6550`，三组时序 oracle 各 15/15。后续 debugger 在独立 worktree 连跑 40 轮（含 `load=35` 过载与禁 transpiler cache），固定 17 条 anchor 失败簇出现 0 次；review 阶段曾见的同簇来自两个审查任务共用 worktree 时的生产源码 mutation 污染，不记为 flaky、不改变排空/时序结构。两个原不可达 oracle 已按主会话裁决移到真实可达相位：P2.2b 的“恢复 tick 真分配”→M6；C11 History 三腿 merged-state→M2/M3/M4（M4 统一收口）。
>
> **前置**：P1 + **P6**（plan review major：两者共享 `delivery/session.ts` 的 heartbeat 生命周期语义，见 Task 2.2b）。**产出**：唯一 owner API，使 index 分配与 wire 写出在同一 serializer operation 内原子完成。
> **承重项 4**（设计 §4.4 第 4 点 / 审查 F7）。

## 问题的精确形状

两个并发写者共享 allocator：

1. **心跳 tick**（`delivery/session.ts:107-129` `tickHeartbeat`）——异步注入 gap anchor，要 `nextAnchorIndex()` + `onAnchorOpen()`；
2. **driver flush**（`driver.ts:1139-1199` `flushBufferedFrames`）——循环里每个 `await sink.write(outFrame)` 都是一个让点，真实块要 `onRealBlockOpen()` + 读 `realBlockOffset()`。

`suspendHeartbeat`（`driver.ts:1269/1293`）只清定时器、**不等待在飞的 injector**。现有代码靠 injector「首个 `await` 前同步翻 state」躲开该 TOCTOU（`keepalive-anchor.ts:241-249` 的长注释即此教训）。但 A 引入的是**带返回值的分配动作**（`nextAnchorIndex()` → 写帧 → `onAnchorOpen()`），比布尔翻转更难原子化：若 injector 在 `nextAnchorIndex()` 与 `onAnchorOpen()` 之间让出，flush 拿到同一个 index，两块撞车。

## Files

- Modify: `src/lib/pipeline/delivery/session.ts`（**暴露 generation-scoped 分配-写出 owner API**；接收注入的 `wireState`；私有 envelope builder 按 `WireWriteSpec.kind` 铸造信封）
- Modify: `src/lib/pipeline/delivery/types.ts`（owner API + `WireWriteSpec`/`WireEnvelopeFactory`/`WireBlockMapping` + session options 加 `wireState`）
- Modify: `src/lib/pipeline/client-sink.ts`（`makeDeliverySseSink` 透传 `wireState`）
- Modify: `src/routes/messages/handler-v4.ts`（**唯一创建点**：建 `GenerationWireState`，同时给 `AnchorState` 与 delivery session）
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
  /** Remap a content_block_* frame of this block onto its wire index (identity when they already match → same object). */
  remap(frame: ClientFrame): ClientFrame
}

/**
 * What a caller wants written. The caller supplies CONTENT and semantic KIND only; the delivery
 * owner mints the envelope (sequence, monotonic timestamp, provenance) — callers such as the live
 * decorator neither hold the delivery clock nor mint sequence numbers, and forging that metadata
 * would put envelope responsibility in the wrong layer (richest-data-flow).
 *
 * `real` frames carry the REAL candidate/dispatch identity supplied at wire-state construction; they
 * are NOT flattened to the `"legacy"` placeholder (see "provenance 的真实上下文" below).
 */
export type WireWriteSpec =
  | { readonly kind: "real"; readonly frame: ClientFrame }
  | { readonly kind: "anchor"; readonly frame: ClientFrame }
  | { readonly kind: "keepalive"; readonly frame: ClientFrame }

/** Declarative sugar handed to build callbacks. */
export interface WireEnvelopeFactory {
  real(frame: ClientFrame): WireWriteSpec
  anchor(frame: ClientFrame): WireWriteSpec
  keepalive(frame: ClientFrame): WireWriteSpec
}

/**
 * Generation-scoped wire-index allocation bound to the wire write itself (C5 + C9).
 *
 * Every allocation happens INSIDE one serializer operation together with the frames that consume it,
 * so no concurrent heartbeat tick or driver flush can interleave between allocating an index and
 * writing it. Callers never hold an allocated-but-unwritten index.
 *
 * NOTE on atomicity (C9): a serializer prevents INTERLEAVING, it cannot make two SSE writes
 * transactional — the first frame may already have reached the client when the second fails. The
 * commit point is therefore the FIRST attempted external write; see C9's two-stage semantics.
 */
export type OwnerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "delivery-finished" }

export interface WireBlockAllocationPort {
  /** Allocate the next wire index for a SYNTHETIC anchor and write its frames in one operation. */
  allocateAndWriteAnchor(build: (ctx: { wireIndex: number; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>): Promise<OwnerResult<number>>
  /**
   * Allocate the next wire index for a REAL upstream block and write EVERY frame belonging to the
   * same wire transaction. Lets the live decorator emit `[anchor_stop, real_start]` as ONE
   * transaction with correct markers (see P3M "S3 专节") instead of two enqueues.
   */
  withAllocatedRealBlock(
    upstreamIndex: number,
    build: (ctx: { mapping: WireBlockMapping; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>,
  ): Promise<OwnerResult<WireBlockMapping>>
  /**
   * Open a leg and bind the identity its frames were produced by. Serialized like every other owner
   * operation: establishes AFTER all successful writes of the previous leg and BEFORE any allocation
   * of the next one.
   *
   * EVERY leg goes through here — `primary` included, not just the retry-ish ones — because this is
   * also where the real candidate/dispatch identity enters the wire state (C11). A `primary` leg that
   * skipped it would have to fall back to the placeholder identity, which is precisely the wrong
   * degradation: the driver does hold the real handles.
   */
  beginLeg(kind: "primary" | "continuation" | "recovery", source: { candidateId: string; dispatchId: string }): Promise<OwnerResult<LegToken>>
  /**
   * Close the currently open synthetic anchor, if any — the SINGLE close authority (round-4 blocker).
   *
   * Runs inside one serializer operation: reads `openAnchorIndex`, builds the stop frame at THAT
   * index, writes it with anchor provenance, and clears the state. Idempotent by construction — a
   * second caller observes `undefined` and gets `"none"`, which is what makes the terminal close
   * exactly-once across the 8 handler sites and the driver's own terminus.
   *
   * `mode`:
   *   - `"before-real"` — mid-stream close ahead of the next real block (C2). The stream continues.
   *   - `"terminal"`    — the request is ending. Fused with the PERMANENT heartbeat stop in the SAME
   *                       owner command, so no tick can interleave between the stop frame and the
   *                       terminus (P6 owns the recoverable-freeze vs permanent-close distinction;
   *                       this mode takes the permanent one).
   */
  closeOpenAnchor(
    buildStop: (index: number, envelope: WireEnvelopeFactory) => WireWriteSpec,
    mode: "before-real" | "terminal",
  ): Promise<OwnerResult<"closed" | "none">>
  /**
   * Write a NON-START frame of an already-allocated block — delta / stop / anything carrying a block
   * index that was not itself an allocation (round-5 major).
   *
   * The owner does all four steps inside one serializer operation: look the block's mapping up by
   * (`leg`, `upstreamIndex`), remap the frame onto its wire index, write it, and — when the frame is
   * that block's `content_block_stop` and the write SUCCEEDED — release the mapping (C10 ③).
   *
   * The leg is passed EXPLICITLY, never read from an ambient "current leg" the owner remembers: a
   * later leg restarts its upstream indices at 0, so an ambient lookup resolves an early frame of the
   * previous leg against the new one. Removing that ambient state is the whole reason delta/stop
   * resolve through immutable tokens; taking `LegToken` here keeps that property instead of quietly
   * reintroducing the race `beginLeg`'s fence was built to close.
   *
   * Callers never touch the mapping registry: without this the lookup/remap/release triple would be
   * re-implemented at each of the three legs, which is exactly how C10's storage decision leaks back
   * into ambient per-leg state.
   *
   * A missing mapping is an ERROR, never a passthrough (C10): it means the block's start was never
   * registered, so writing the frame unremapped would silently land it on a stale index — the R1
   * silent-reordering failure this plan exists to prevent.
   */
  writeBlockFrame(leg: LegToken, upstreamIndex: number, frame: ClientFrame): Promise<OwnerResult<"written" | "no-mapping">>
}
```

**实施期补充裁决（2026-07-28）**：五个入口对 session 非 open 统一返回 `{ok:false, reason:"delivery-finished"}`；只有这一种预期终态进入 `OwnerResult`。未配置 `wireState`、reservation 重入、无 active leg 写 real 等接线错误继续 throw。driver 的四个 `beginLeg` 站点显式 narrow `OwnerResult`，delivery-finished 映射为 `settled-abort`。live 装饰器不注册成 owner：handler 从未装饰 raw delivery sink 取得 port，经 `RunResponseOpts.wireAllocationPort` 显式下传给 driver（production live oracle 锁住）。

### mapping token 的生命周期（**round-4 major：四点冻结**）

delta/stop 按不可变 token 查（round-2 裁决），但 token **存哪、怎么查、何时释放、retreat 怎么共享**没写死，M2–M4 会各做各的假设。四点冻结：

| # | 问题 | 冻结答案 |
|---|---|---|
| 1 | **存放** | 存在 `GenerationWireState`：`Map<LegToken, Map<upstreamIndex, WireBlockMapping>>`。**不是** allocator 的 ambient「current leg」单槽（那正是 round-2 否决的全局查询），也**不是** driver / 装饰器各自的局部 Map（retreat 与 buffered→live 切换必须共享同一份）。登记时机 = start 帧**成功 commit 之后**（C9：commit point 前不可见）。 |
| 2 | **查询** | delta/stop 按 **(当前 leg token, 帧自带的 upstream index)** 精确查。**必须支持同腿多块并存**（上游 parallel tool_calls 的 coexist index）——故是 per-leg Map 而非单槽。 |
| 3 | **释放** | 该块的 `content_block_stop` **成功写出后**删除其条目。（close-before-real 关的是 anchor，不在此列。） |
| 4 | **retreat 共享** | retreat **不换 leg**，沿用同一 leg map：buffered 阶段登记的 mapping 在 live 写穿阶段照常可查。这正是 S2 必须与 S1 共享状态的原因。 |
| 5 | **谁执行**（round-5 major，round-6 收紧签名） | 查询 / remap / 释放**全部在 owner 内**，经 `writeBlockFrame(leg, upstreamIndex, frame)`——三腿递**显式 `LegToken`** + upstream index + frame，**owner 不记「当前腿」**（ambient 当前腿正是 round-3 决议要消除的东西）。**架构守卫**：owner 外不得直接读写 mapping registry（`src/` 下对该 Map 的访问有且仅有 delivery owner 一处，带正样本对照）。否则「存哪」的裁决会在三腿各自的实现里被绕开。 |

**missing mapping 必须显式报错，绝不原样透传**——查不到 token 说明 start 漏登记（M2–M4 漏接线正是这个形状）。静默透传会让帧落在旧 index 上，就是 R1 的静默重排。配测试：人为删除 mapping 后，后续 delta 必须抛可辨识错误而非被写出。

### provenance 的真实上下文（**round-5 major：planner 上轮的保守是错的，前提经核实不成立**）

我上轮倾向「照实沿用 `asDeliveryFrame` 的 `candidateId:"legacy"` 并注明是既有行为」，理由是「诚实退化优于伪称完整」。**方向对，但前提不成立**——reviewer 核实、planner 复核确认：**driver 实际拿得到真实 handle**。

代码事实：`runResponseBufferedSink` 在进入 flush 循环前已持有

```ts
const unhedgedBinding = generation?.bindings.get(upstream)          // driver.ts:1039
if (unhedgedBinding) env.ctx.selectGenerationWinner(unhedgedBinding.candidate.candidate, unhedgedBinding.candidate.dispatch)   // :1040
```

即 `candidate` / `dispatch` 在 flush 的作用域内**可达**（continuation 腿另有 `generation?.bindings.get(current)`，`:1426`）。

**故裁决：生产路径传真实上下文，只有兼容 helper 才退化。**

| 路径 | provenance |
|---|---|
| driver flush / retreat（S1/S2） | **真实** `{ kind:"candidate", candidateId, dispatchId }`，取自当前 binding |
| live 装饰器（S3） | **真实**——同一 `GenerationWireState` 携带当前 candidate 上下文，装饰器无需自己知道 |
| synthetic anchor / keepalive | `{ kind:"synthetic", syntheticKind }`（本就正确，C7） |
| 既有兼容 helper `asDeliveryFrame` | 保留 `"legacy"` —— 它服务的是**尚未接线的旧调用点**，**这是其退化边界，须在代码注释里写明**，不得扩散到新路径 |

**这正是记忆 `methodology-degradation-advice-scoped-to-target-has-equivalent` 的应用**：「别继承退化」只在**目标真有对应值**时成立——这里目标**有**，所以照抄 `legacy` 是**错误的退化**（会把真实身份信息丢进 History，违反 richest-data-flow：后端存储必须完整）。

#### primary leg 的初始化时机（**round-6 major：原方案只覆盖 continuation/recovery，primary 无初始化点**）

`beginLeg` 是身份进入 wire state 的唯一入口，故 **primary 也必须调**。但 primary 有一处时序坑，必须写死：

**sink 早于 binding 存在**。两条 stream 路径都先 `makeAnchoredSseSink`（settled-within-window `handler-v4.ts:552`；**delayed-commit `:624`——它在上游 settle 之前就建 sink**），而真实 candidate/dispatch 要等 driver 建立 binding 才有（`driver.ts:1039-1040` 的 `generation?.bindings.get(upstream)`）。**delayed-commit 的 pre-response 窗口尤其明显**：注入器可能在 binding 存在之前就已注入 anchor。

冻结的时序：

| 时点 | 状态 | 说明 |
|---|---|---|
| sink 构造（`:552` / `:624`） | **无 leg、无身份** | wire state 已创建但尚未 `beginLeg`；此时只可能写 **synthetic** 帧（anchor / keepalive / synthetic message_start），它们走 `syntheticKind` provenance（C7），**不需要** candidate 身份 |
| driver 取得 binding 后、**首个真实块分配之前** | `await port.beginLeg("primary", { candidateId, dispatchId })` | driver 在 `runResponseBufferedSink` / `runResponseSink` 入口处（`driver.ts:1039-1040` 已算出 handle 的同一位置）调用 |
| 此后 | 有 leg、有身份 | 真实块经 `withAllocatedRealBlock` 分配，`real` 帧带真实身份 |

**不变量**：`withAllocatedRealBlock` / `writeBlockFrame` 在**没有活跃 leg 时必须拒绝**（返回错误而非退化为 placeholder）——真实块出现前必然已 `beginLeg`。这条把「primary 忘了初始化」变成**显式失败**而非静默 `"legacy"`。

> **为何 synthetic 帧不需要等 leg**：它们的 provenance 是 `{kind:"synthetic", syntheticKind}`，本就与 candidate 无关（C7）。这也正是 pre-response anchor 能在 binding 之前合法写出的原因——**没有被退化的身份，只有本就不适用的字段**。

- [x] **接线**：`GenerationWireState` 承载「当前 leg 的 candidate/dispatch」，**唯一写入点是 `beginLeg`**；owner 铸造 `real` 信封时读它。
- [x] **oracle（三腿全覆盖，按真实相位可达性拆分；2026-07-28 主会话裁决）**：P2 已完成 owner 三腿 provenance、production 三腿 `beginLeg` 接线、无 active leg 拒绝、`"legacy"` 唯一边界守卫；**History generation 轨的 production merged-state oracle 移入 P3M M2/M3/M4**。理由：P2 时 S1/S2/S3 仍走旧 `sink.write` / live decorator，真实块要到 M2/M3/M4 才分别迁入 `withAllocatedRealBlock` / `writeBlockFrame`；此时手工写 History 只能自证 owner、不能证 production 接线。M2 补 buffered-flush 腿、M3 补 retreat 腿、M4 补 live 腿并统一断言 primary/recovery/continuation 三腿均为真实 candidate/dispatch、均非 `"legacy"`、主腿 ≠ 续写腿；**M4 未完成统一断言即视为未完成**。另单测 delayed-commit 路径：pre-response anchor 在 `beginLeg` 之前写出且带 `synthetic` provenance（不是退化的 candidate 身份）。
- [x] **负样本**：无活跃 leg 时调 `withAllocatedRealBlock` / `writeBlockFrame` **必须拒绝**（不得退化为 placeholder 身份）。
- [x] **守卫**：`src/` 下 `"legacy"` 字面量的出现有且仅有既有兼容 helper 一处（带正样本对照）。

### 注入路径（**round-3 major：P1 handler-owned state 与 P2 session-owned port 之间的接线空洞，本轮冻结**）

审查坐实的空洞：P1 把 allocator 放进 handler-owned `AnchorState`，而 P2 让 delivery session 的 port 成为唯一分配 owner——但 `CreateDownstreamDeliverySessionOptions`（`session.ts:25-29`）**只有 `sink` / `monotonicNow` / `heartbeat`，没有任何 allocator 注入位**，`makeDeliverySseSink` 建 session 时也不接触 `AnchorState`。没有显式接线，实施者只能新建第二个 allocator、闭包偷 handler state、或搞 ambient singleton——**三条都破坏「generation 唯一权威」**。

**冻结的注入路径**（谁创建 / 谁持有 / 如何保证唯一）：

```text
handler-v4.ts  makeAnchoredSseSink()
  └─ 创建 ONE  GenerationWireState { allocator, openAnchorIndex, … }   ← 唯一创建点
       ├─ 放进 handler 的 AnchorState（driver / injector / live 装饰器经它读）
       └─ 作为 makeDeliverySseSink(stream, { …, wireState }) 的入参
            └─ createDownstreamDeliverySession({ sink, monotonicNow, heartbeat, wireState })
                 └─ session 用它构造 WireBlockAllocationPort（唯一分配 owner）
                      └─ getDownstreamDeliverySession(sink).allocationPort  ← 装饰器/driver 取用
```

要点：

1. **`GenerationWireState` 是 wire 状态的 SSOT**——同时持有 allocator 与 `openAnchorIndex`（M1 把后者前移进 owner 后，二者天然同属一个对象，也解决了「C9 要求回滚 `openAnchorIndex` 但 session 看不见它」的矛盾）。
2. **恰好创建一次**，在 handler 的 `makeAnchoredSseSink`；`AnchorState.allocator` 与 session port 引用**同一对象**。
3. **session 不自建**：`wireState` 为必填（`ping` 模式也传——其 allocator 全程恒等映射，天然走 C3 短路）。
4. 需改的 files：`delivery/types.ts`（options + port 类型）、`delivery/session.ts`（构造与 port）、`client-sink.ts`（`makeDeliverySseSink` 透传）、`handler-v4.ts`（创建 + 双向传递）。

**守卫（防第二个 allocator 实例）**：

- [x] identity oracle：一次请求中，driver、live 装饰器、injector、session port 四处读到的 allocator **是同一引用**（`toBe` 引用相等，非值相等）。
- [x] 架构守卫：`src/` 下 `createGenerationWireIndexAllocator(` 的调用点**有且仅有** `handler-v4.ts` 一处（带正样本对照——故意加第二处应转红）。

**冻结的语义要点**（实施期不得自行改，要改回主会话）：

1. **commit point = 首次外部 write（C9，round-3 blocker 重写）**：serializer 只能保证**不交错**，**不能**让两次底层 SSE write 具备数据库式原子性——`writeToSink` 对多帧仍逐个 `await`，第一帧可能已到客户端、第二帧才抛错。**已发出的字节撤销不了**，故原「多帧失败全回滚」是物理上不成立的合同（会在 partial write 后复用客户端已见的 index）。两段语义：

   | 阶段 | 判据 | 行为 |
   |---|---|---|
   | **commit point 之前** | session 拒绝、build callback 抛错、**尚未尝试任何 wire write** | 零外部副作用 → 预留对读者始终不可见 → **全回滚**（frontier、anchor 计数、leg mapping、`openAnchorIndex`） |
   | **commit point 之后** | 任一帧**已尝试或已成功**写出 | index **永久消费、绝不复用**；失败 → 返回 `write-error`/`client-abort`、**终止 delivery**、**禁止后续分配**；已尝试的输出忠实记录（richest-data-flow） |

   即：**reservation 不可见 → 首帧写出前 commit → 此后只进不退**。partial delivery 是既成事实，计划**不承诺**该情形下的 wire 无洞——承诺的是「绝不复用已可见的 index」+「不静默继续」。

   **两类边界状态的归属（round-4 major 补齐）**——不写死的话「两段」定义虽对、执行边界仍会被写错：

   | 状态 | 归属 | 实现约束 |
   |---|---|---|
   | operation **已入队、尚未开始执行** | commit point **之前** | **不得在 `enqueue` 调用时预留**——reservation 必须发生在 operation **开始执行时**。若排队期间 session 进入 terminating/closed，operation 开始时**重新检查**并按「session 拒绝、零分配」处理 |
   | operation 执行中**收到 abort** | 看是否已调底层 write：**首个 `writeToSink` 调用之前**观察到 → pre-commit 全回滚；**已调用但 promise 未 settle** → **算 post-commit**，index 永久消费 | **commit 标志必须在调用 `writeToSink` 之前【同步】置位**，不是 await 成功之后——否则「已尝试」这一档会漏 |
2. **delta / stop 不分配**：只按**该块的 `WireBlockMapping`（不可变 token）**查，**不查 ambient「current leg」**——消除跨 `await` 的可变全局状态（round-2 major）。只有 `content_block_start` 触发分配。
3. **owner 唯一**：`ClientSink` 上不暴露任何裸分配入口；低阶 `allocateAnchor` / `allocateRealBlock` / `on*Open` 降级为**测试专用**，由架构守卫锁住（Task 2.1 Step 5）。**这条对 P5.3 同样生效**——gap injector 必须走 `allocateAndWriteAnchor`，不得裸调（round-2 major）。
4. **`beginLeg` 是 serializer command**（`Promise<LegToken>`，非同步裸方法）：它在**前一腿全部成功写出之后、下一腿任一分配之前**建立 fence。否则 continuation dispatch 与在飞的 heartbeat anchor operation、前腿排队中的 delta/stop 之间没有顺序合同（round-2 major）。

### recovery / leg 边界语义（**round-2 major，本轮冻结**）

代码事实：transparent retry 只在 `!committedAny` 时发生（`driver.ts:1408`），故被丢弃的 attempt **必然没有真实块写出**。但它**可能已经写出过 pre-content anchor**（anchor 走 `writeAnchor` 绕过 buffer，不受 `committedAny` 约束）。两种情形的正确 index：

| 情形 | recovery 前 frontier | recovery 首块（upstream 0）应落 | 恒等？ |
|---|---|---|---|
| attempt0 无 anchor，首块前截断 | 0 | wire **0** | 是 → 原对象直返 |
| attempt0 已写 pre-content anchor@0，首块前截断 | 1 | wire **1** | 否 → 必须 remap |

**冻结裁决**：**所有** upstream round（**primary**、continuation、recovery）都调 `beginLeg(kind, source)`，**不为任何一类特判**。allocator 由「已成功写出的 frontier + 空的新腿 mapping」自然得出正确结果——上表两行都自动成立，无需分支。这样也避免了「recovery 忘了调 beginLeg 时靠巧合正确」的脆弱性（reviewer 指出的正是这一点）。

`kind` 只用于诊断/遥测，**不参与 index 计算**。

> **P3.1 停点的处置**：原「谁调 `allocateRealBlock`」的执行期停点，**在本相位被前移消解**——答案由 owner API 冻结：driver flush 与 live 装饰器各自在自己的真实块 `content_block_start` 上调 `withAllocatedRealBlock`，delivery session 是唯一 owner。审查指出该问题决定 C5 owner 与 S1/S2/S3 接线，不该留到实现期才发现，**已采纳**。S3 的可达性已由代码事实确认（见 P3「S3 专节」），不再是停点。

---

## Task 2.1：allocator 侧的原子分配 + leg 语义

> 这是 owner API 的**底层**：allocator 自身的原子入口。owner API（Task 2.2）在 serializer operation 内调它。

- [x] **Step 1: 写失败测试**

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
  a.beginLeg("continuation", src)
  const m1 = a.allocateRealBlock(0)                     // 该腿 upstream 0 → wire 1
  expect(m0.wireIndex).toBe(0)                          // ← 旧 token 不受新腿影响
  expect(m1.wireIndex).toBe(1)
  expect(m0.remap(startFrame(0))).toBe(startFrame(0))   // 恒等 → 原对象（C3）
})
test("a rolled-back allocation leaves no visible mapping", () => {
  // 低阶层的 reserve/rollback 原语（owner 的事务在其上构建）
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现原子入口 + leg 语义（同步函数，内部 peek+advance 之间**无 await**）+ reserve/rollback 原语。**分配返回不可变 `WireBlockMapping` token**，delta/stop 按 token 查——**不再有 ambient「current leg」查询**（round-2 major：跨 `await` 的可变全局状态正是 `beginLeg` 竞态的来源）。
- [x] **Step 4**：跑，绿。
- [x] **Step 5**：架构守卫——`tests/architecture/anchor-remap-single-authority.unit.test.ts`（P1.4 建的）扩一条：`src/` 下除 `keepalive-anchor.ts` 与 `delivery/session.ts` 外不得出现 `nextAnchorIndex(`/`nextRealIndex(`/`onAnchorOpen(`/`onRealBlockOpen(`/`allocateAnchor(`/`allocateRealBlock(`（生产路径只能经 owner API）。带正样本对照。
- [x] **提交** → `feat(anchor): atomic allocate entries with leg-local mapping; peek/commit split is test-only`

## Task 2.2：owner API 落地 + 让点 oracle

> C5 的唯一合法实现：分配与写出在**同一个 `enqueue` callback** 内。`createDeliverySerializer`（`delivery/serializer.ts`）已是 delivery 的单写者队列，所有 wire 写都过它（`session.ts:73-84`）。

- [x] **Step 1: 写失败测试** —— FakeClock 让 tick 恰落在 flush 的 `await sink.write` 让点

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
// C9 两段语义（round-4 major：原「任何 write failure 都不推进 frontier」与新 C9 档 2/3 正面冲突，已改写）
test("a session/build refusal BEFORE any write does not advance the frontier", async () => {
  // build callback 抛错 / session 拒绝 → 下一次分配拿到【同一个】index（pre-commit 全回滚）
})
test("a FAILED first write consumes the index permanently and refuses further allocation", async () => {
  // sink.write 抛错 → 后续分配【不得】拿到同一 index；delivery 已终止
  // 详细三档见 Task 2.2c —— 此处只锁「P2.2 的并发 harness 也遵守同一语义」
})
```

- [x] **Step 2**：跑，红（至少正样本对照必须红；主测试若**当前就绿**，说明竞态窗口没构造出来——**不得**据此认为安全，调整 harness 直到正样本对照能咬住）。
- [x] **Step 3**：实现 owner API（`allocateAndWriteAnchor` / `withAllocatedRealBlock` / `beginLeg`），全部走 `serializer.enqueue` 的单个 operation。
- [x] **Step 4**：跑，绿；**连跑 15 次**确认确定性（`for i in {1..15}; do bun test tests/pipeline/anchor-allocation-race.it.test.ts || break; done`）——时序测试必须实证确定性，非跑一次算数。
- [x] **Step 5: 提交** → `feat(delivery): atomic wire-index allocation bound to the wire write`

## Task 2.2b：P2 × P6 交叉门（**plan review major：两者并非无代码重叠**）

> 审查坐实：P2 与 P6 都改 `delivery/session.ts`，且改的正是**同一组语义**——heartbeat operation 的入队、挂起、恢复与 flush 交接。P6 改变「boundary commit 后 heartbeat 是否继续入队」，直接**扩大 P2 竞态的可达状态**。故 README 原称「无代码重叠、可并行」是事实错误。
>
> **依赖裁决**：P2 必须基于**含 P6** 的 base 实施（DAG 已补 `P6 → P2`）。若 P6 独立先合并 master，则 allocator worktree 必须 rebase/merge 到含 P6 的 master 后再做 P2——否则会在旧 heartbeat 生命周期上写竞态 oracle，合并后测试语义失效。

> **实施期可达性拆分（2026-07-28 主会话裁决）**：原测试把两种不同相位才可达的事实合在了一条里。P6 已让 boundary commit 后 heartbeat 恢复，但当前 `semanticBlockCount === 0` 门仍禁止首块后的 tick 调 `allocateAndWriteAnchor`；该门按硬序只能在 P3M **M6**（晚于 M2–M4）删除。故 P2 期要求“恢复后的 tick 真分配 gap anchor”不可满足，不得手工补状态或提前开门。
>
> 拆成两层，覆盖不减少：① **P2 留下**当前可达 characterization——boundary 后 heartbeat 确实恢复、当前门仍将 tick 路由成 ping，且 owner serializer 在该恢复状态下继续保持不交错；② **移入 M6 O-3**——删门后同一恢复 tick 必须真实进入 `allocateAndWriteAnchor`，配“加回门” mutation。P3M 权威 `plan-3-remap-sites.md` 的 M6 行同步记录该移入项。

- [x] **Step 1: 写 characterization 测试** —— P6 后、M6 前真实可达状态

```ts
// tests/pipeline/allocation-race-after-boundary-commit.it.test.ts
test("after a boundary commit resumes heartbeat, the pre-M6 gate emits ping while owner work remains serialized", async () => {
  // 真实块提交（suspend → freeze → resume）→ 等本 session 自己的 writeCount/ledger 到达 boundary
  // → 下一 tick 确实发生；M6 前必须是 ping、不得分配 anchor（semanticBlockCount===0 门仍在）
  // → 与下一 owner operation 交错时 O-1/O-2 仍成立。
})
```

- [x] **Step 2**：当前代码应直接绿，注明为 characterization；其正向能力由 P6 测试先证明 heartbeat 真恢复，且断言 tick 产出 ping，不能以“无输出”假绿。
- [x] **Step 3**：连跑 15 次；就绪门只读本 session 自己的 ledger/writeCount，不读全局 timer 计数。
- [x] **Step 4**：mutation——临时恢复 P6 旧缺陷（让 freeze 永久 stop）时，本测试必须因“恢复 tick 未出现”转红。
- [x] **提交** → `test(delivery): characterize pre-M6 allocation safety after heartbeat resume`

## Task 2.2c：commit-point 三档 oracle + recovery 腿（**round-3 blocker 重写**）

> C9 的两段语义必须有**三档**测试，因为「失败」在 commit point 前后行为**相反**：前者要求全回滚、后者要求永不回滚。只测其一会让另一半悄悄反向。

- [x] **Step 1: 写失败测试**

```ts
// tests/pipeline/allocation-commit-point.it.test.ts
// ── 档 1：commit point 之前（零外部副作用）→ 全回滚 ──
test("build callback throwing BEFORE any wire write rolls back everything", async () => {
  // build 内直接抛错 → 断言：frontier 未推进（下次分配拿同一 index）、
  //                        anchorsOpened() 未增、mapping 不可查、openAnchorIndex 未置
})
test("a session refusal allocates nothing", async () => { /* 已 terminating/closed */ })

// ── 档 2：第一帧写失败（commit point 已到）→ 永久消费 + 终止 ──
test("a failed FIRST frame consumes the index permanently and terminates delivery", async () => {
  // 断言：① 返回 write-error/client-abort
  //       ② 后续分配【不得】拿到同一 index（绝不复用）
  //       ③ delivery 已终止：后续分配被拒绝（而非静默继续）
})

// ── 档 3：第一帧成功、第二帧失败（partial delivery）→ 同档 2 且客户端已见的 index 绝不复用 ──
test("first frame delivered, second frame failing: the visible index is NEVER reused", async () => {
  // anchor_start@2 成功到达客户端 → keepalive_delta@2 失败
  // 断言：② 后续任何分配都不得再产出 wire@2（客户端已见 open block@2）
  //       ③ delivery 终止、禁止后续分配
  //       ④ 已尝试的输出被忠实记录（forwarded 轨可见）
  // 反向断言（防修过头）：不得因此把 index 回滚为可复用
})

// ── 两类边界状态（round-4 major）──
test("a QUEUED operation reserves nothing; a terminate while it waits yields zero allocation", async () => {
  // operation 入队 → 在它开始执行前让 session terminate → 断言：
  //   ① 排队期间没有任何 reservation（另一路径查询看不到）
  //   ② operation 开始执行时重新检查并按「session 拒绝」返回，零分配
})
test("an abort while the first write's promise is PENDING counts as post-commit", async () => {
  // sink.write 返回一个未 settle 的 promise → 期间触发 abort
  // 断言：index 永久消费（后续分配不得拿到它）+ delivery 终止
  // 反向：abort 若发生在首个 writeToSink 调用【之前】，则属 pre-commit，全回滚
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现——reservation 在 operation **开始执行时**才建立（非 enqueue 时）+ **commit 标志在调 `writeToSink` 前同步置位** + 此后只进不退 + 失败终止 delivery。
- [x] **Step 4**：跑，绿。
- [x] **Step 5**：**双向 mutation**——
  - 把档 2/3 改成「失败即回滚 index」（即 round-2 的旧契约）→ 档 3 的「绝不复用」断言必须**转红**；
  - 把档 1 改成「不回滚」→ 档 1 断言必须**转红**。
  两个方向都咬得住，才证明两段语义各自有门。
  - **返工补齐 real 腿**：`allocation-real-block-refusal.it.test.ts` 覆盖 build rollback、session refusal、首帧/次帧 abort 与 `writeBlockFrame` abort/非-client error。scratch mutation 将 real build catch 的 `rollback()` 改 `commit()` 后两条具名测试分别 `Expected 0 / Received 1`；删除 real session state guard 后拒绝测试收到 `{ok:true,...}` 而转红。所有 mutation 均在独立 scratch worktree 执行。
- [x] **提交** → `feat(delivery): commit-point allocation semantics with irreversible wire side effects`

## Task 2.2c-b：recovery 腿 index 语义

- [x] **Step 1: 写失败测试**

```ts
// tests/pipeline/allocation-recovery-leg.it.test.ts
test("an allocated-but-unwritten index is INVISIBLE to readers mid-transaction", async () => {
  // 在 build callback 内部（帧尚未写出）从另一路径查询 mapping → 必须查不到
  // 注：这是 commit point【之前】的性质，与 C9 档 1 同源
})

// recovery 两支（P2 recovery 表两行各一条）
test("recovery leg with NO prior anchor: upstream0 -> wire0, frame returned by reference (identity)", async () => {
  // attempt0 无 anchor、首块前截断 → recovery
})
test("recovery leg AFTER a pre-content anchor was written: upstream0 -> wire1 (must remap)", async () => {
  // attempt0 已写 anchor@0（frontier=1）、首块前截断 → recovery 首块必须落 wire1
  // 这条是「recovery 忘调 beginLeg 会靠巧合正确」的反例锁
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现——预留对读者不可见（commit point 之前）+ **三类** upstream round 都调 `beginLeg(kind, source)`（primary 的时机见「primary leg 的初始化时机」）。
- [x] **Step 4**：跑，绿。
- [x] **Step 5（返工后重新完成）**：原勾选无效——旧 `allocation-recovery-leg.it.test.ts` 由测试自己调用 `port.beginLeg("recovery")`，只能锁 owner 算术，无法证明 driver 真接线，属于「测试准备替实现完成关键动作」。现改由 `driver-leg-fence.it.test.ts` 走 production binding-present recovery 分支；scratch mutation 删除 `driver.ts` recovery `beginLeg` 后，具名测试实际失败为 `Expected: "recovery" / Received: "primary"`。continuation 同理由 `continuation-flow.it.test.ts` 走真实 driver 分支；删除 production continuation fence 后实际失败为 `Expected: "continuation" / Received: undefined`。
- [x] **提交** → `feat(delivery): explicit leg fences on every upstream round`

## Task 2.2c-c：跨腿 mapping 隔离 oracle（**round-6 major**）

> `writeBlockFrame` 的 leg 参数是**显式**的（round-6 收紧）。这条 oracle 证明它真的按传入的 leg 解析，而不是回退到 owner 记住的「当前腿」——后者会让**同一 upstream index 在两条腿上各有一块**时查错 mapping，正是 round-3 决议要消除的 ambient 状态。

- [x] **Step 1: 写失败测试**

```ts
// tests/pipeline/cross-leg-mapping-isolation.it.test.ts
test("the same upstream index on two legs resolves to each leg's own wire index", async () => {
  // 主腿：upstream0 → wire0（token A）
  // beginLeg("continuation", …) → 续写腿：upstream0 → wire1（token B）
  // 交错写两腿的 delta/stop：writeBlockFrame(A, 0, delta) 与 writeBlockFrame(B, 0, delta)
  // 断言：A 的帧落 wire0、B 的帧落 wire1 —— 各自正确，互不串腿
  assertMonotonicWireIndices(frames)
  assertBlockProtocolState(frames)
})
test("a stale leg token still resolves its own block after a newer leg opened", async () => {
  // 前腿排队中的 stop 在 beginLeg 之后才写出 → 仍必须落前腿的 wire index
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：实现——`writeBlockFrame` 按**传入的** `LegToken` 查 registry。
- [x] **Step 4**：跑，绿。
- [x] **Step 5**：**mutation**——把实现改回「忽略入参 leg、用 owner 的当前腿」，确认两条测试**都转红**。这是本 task 的存在理由：证明显式 leg 不是装饰性参数。
- [x] **提交** → `test(delivery): cross-leg mapping isolation via explicit leg tokens`

## Task 2.2d：`beginLeg` fence 时序 oracle（**round-2 major**）

- [x] **Step 1: 写失败测试**

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

- [x] **Step 2**：跑，红（同步裸 `beginLeg` 会让前腿排队帧查到新腿）。
- [x] **Step 3**：实现——`beginLeg` 改为 serializer command；delta/stop 按**不可变 `WireBlockMapping` token** 查，不查 ambient current leg。
- [x] **Step 4**：跑，绿；**连跑 15 次**。
- [x] **提交** → `fix(delivery): serialize leg fences and resolve remaps through immutable block mappings`

## Task 2.3：`suspendHeartbeat` 与在飞 injector 的交接

> `suspendHeartbeat` 不等待在飞注入。P2.2 把分配移进 serializer 后，在飞的 injector operation 已经排在队列里，flush 的写也排在队列里——**顺序由队列保证**，不会撞 index。但仍需锁住一条不变量：suspend 之后不得有**新的** anchor 被分配。

- [x] **Step 1: 写失败测试**：suspend 后推进 FakeClock 超过 deadline，断言 `allocator.anchorsOpened()` 不再增长。
- [x] **Step 2**：跑（可能已绿——`armHeartbeat` 的 `heartbeatSuspended` 守卫已覆盖）。**若已绿**，降级为 characterization 测试并在此注明「现有守卫已覆盖，本测试锁住它不被回归」，不伪造红。
- [x] **Step 3**：若红则实现。
- [x] **提交** → `test(anchor): lock that a suspended heartbeat allocates no further anchors`

## P2 收口

- [x] `typecheck` + `test:fast` 绿；O-1/O-2/O-6 仍绿。
- [x] 并发 oracle（2.2 + 2.2b）各连跑 15 次全绿。
- [x] 架构守卫锁住「生产路径只经 owner API 分配」。
- [x] **C9 两段语义各有测试**：commit point 前失败 → 全回滚；commit point 后失败 → 永久消费 + 终止 delivery（三档 oracle + 两类边界状态，Task 2.2c）。
- [x] **P3.1 原停点已消解**：owner 形状已冻结（若实施中发现站不住，那才是真分叉 → 停下回报）。
