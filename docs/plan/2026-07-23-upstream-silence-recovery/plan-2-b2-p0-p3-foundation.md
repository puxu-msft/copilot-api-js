# Plan-2: B2-P0～P3 —— 机制地基（server-tool gate 复用点 / 配置骨架 / semantic-content gate / sink lifetime supervisor）

> **依赖：** 无（可与 B1 并行）。**前置阅读：** spec §4/§6.1 + FINDINGS.md 全文（尤其"B2 必须新建"的 5 件机件列表）。
>
> **⚠️ 本阶段是全计划技术难度最高的部分。** 以下设计基于对 `driver.ts` / `coordinator.ts` / `candidate.ts` / `dispatch-scheduler.ts` / `hedge-policy.ts` / `boundary-classifier.ts` 的实证阅读（非猜测），但**部分接线细节需在 TDD 执行期用测试验证**（例如 History `completeCandidate`/`selectGenerationWinner` 的确切调用时机与生产代码里其它 recovery 路径的对照）——凡标注「验证」的地方，实现者必须先读对应源码确认再落地，不能凭本文档假设直接写。

## 背景：为什么这是"新拓扑"而非小改（代码实证复述）

`runRequest`（`driver.ts:312`）的关键路径：

```
S1 parse → S1b translateInbound → S2 route/translateOut → S3 rewrite-in
  → S4-pre preflight → coordinator = createDriverCoordinator(...)
  → const candidate = await coordinator.runPrimary()   // ← 可能 reject
  → generation.bind(coordinator, candidate)
  → return { ok: true, upstream: candidate.upstream, env: candidate.env }
```

若 `coordinator.runPrimary()` reject（`dispatch-scheduler.ts` 的候选内重试循环耗尽预算/遇不可重试错误），这个 reject 直接从 `runRequest` 传播出去 —— **调用方（handler-v4.ts 的 `p`）拿到的只是一个 rejected promise，没有任何 `CoordinatedCandidate` 引用**。`candidate.ts` 的 `run()` 在这条路径上已经自行把候选 settle 为 `verdict:"failed"`（`candidate.ts:107-109`），**History 不会因此留孤儿记录**——但调用方失去了"继续操作这个候选/重新发起"的任何句柄。

`coordinator.ts` 现有的 `runRecovery(parent, reason, env)` / `runContinuation(parent, reason, env)` 都要求 `parent: CoordinatedCandidate`（一个已经 ready 的候选）——`runRequest` 失败时压根没有这个对象。**这就是 FINDINGS 说"B2 不是 continuation 小变体"的代码实证**：continuation/recovery 复用的是"已就绪候选的后继"，B2 要救的是"候选从未就绪就死了"，两者的输入契约不同。

## Files 总览（本阶段）

- Modify: `src/lib/pipeline/generation/coordinator.ts`（新增 `runRecoveryFromPreReadyFailure` —— 形状参照已有 `runHedge`：在同一 budget/coordinator 上开一个无 parent 要求的新候选，role 用已存在的 `"recovery"`）
- Modify: `src/lib/pipeline/driver.ts`（`runRequest` 内部 catch `coordinator.runPrimary()` 的 reject，把 `{coordinator, env}` 存进 driver 闭包状态；新增 `PipelineDriverWithNonStreaming.runPreContentRecovery(reason): Promise<DriverRequestResult>`）
- Create: `src/lib/pipeline/generation/semantic-content-gate.ts`（纯函数：读候选的 **delivery-level 信号** `hasEmittedRealClientContent`——首个非-synthetic `isClientContentFrame`/Anthropic `content_block_delta` 写出时不可逆翻转，**非** `boundary.result`，见 Task 0.2 CRITICAL 修正）+ 在 client-frame 写出 seam 接线该 flag
- Create: `src/lib/pipeline/generation/recovery-sink-supervisor.ts`（`ClientSink` 生命周期包装：首次失败路径不得调用 `finalize`/`close`，只有 supervisor 认定"最终失败或最终成功"才收口）
- Modify: `src/lib/state-defaults.ts` + `src/lib/config/schema.ts` + `src/lib/config/config.ts`（新配置骨架，见 Task 0.1；本阶段只加开关+默认值，不接线到 handler）
- Modify: `src/lib/anthropic/protect-streaming-stats.ts`（新增 outcome 分类 `precontent-recovery-success` / `precontent-recovery-exhausted`，镜像现有 continuation 计数器模式）
- Test: `tests/pipeline/precontent-recovery-coordinator.unit.test.ts`（新，覆盖 coordinator 新方法）
- Test: `tests/pipeline/semantic-content-gate.unit.test.ts`（新，纯函数）
- Test: `tests/pipeline/recovery-sink-supervisor.unit.test.ts`（新，纯 sink 包装）
- Test: `tests/pipeline/driver-precontent-recovery.it.test.ts`（新，覆盖 driver 新方法端到端，用 mock transport）
- Test: `tests/pipeline/precontent-recovery-seal-race.it.test.ts`（新，Task 0.6：seal 后晚到 open 无 unhandled-rejection 回归）

---

## Task 0.1：配置骨架（纯新增，默认关闭，不接线）

**为什么先做配置骨架：** 让后续所有阶段都能通过 `state.xxx` 读取“是否启用/触发条件”，避免接线阶段还要临时加 flag。配置默认 `enabled:true` 已裁定；B2 是新拓扑，但实际接线留在 P4/P5，所以本阶段仍不产生任何行为差异。

- [x] **Step 1: 写失败测试** —— 新配置键存在、默认值符合预期、config.ts 能正确映射

```ts
// tests/config/buffered-retry-keys.unit.test.ts（追加，或新建 precontent-recovery-config.unit.test.ts）
test("precontent_recovery config defaults to enabled:true with server-tool-safe gate always on", () => {
  // 断言 state.preContentRecovery = { enabled: true, ... }（默认值待定，倾向默认开——见下方"命名与默认值"）
})
test("config key precontent_recovery.enabled maps to state via applyConfigToState", () => { ... })
```

- [x] **Step 2: 跑，失败。** —— `bun test tests/config/buffered-retry-keys.unit.test.ts`（新增断言收到 `undefined`，符合缺少 state 字段的预期）。
- [x] **Step 3: 接线**：
  - `src/lib/state-defaults.ts` 新增 `preContentRecovery: { enabled: true } as PreContentRecoveryConfig`（结构留扩展余地，暂只有 `enabled`；B2-P4 若发现需要更多字段——如"最大一次性重试次数"——此处再扩展，**不要在本 Task 里预先加未用字段**，YAGNI 在"配置项数量"上是合理的，反-YAGNI 只约束"功能范围"不约束"配置粒度"）。
  - `src/lib/config/schema.ts` 新增 `anthropic.precontent_recovery`（或顶层 `buffered_retry` 同级——**待决**：既然 B2 独立于 `protect_streaming_generation`/buffered-retry（可在 buffered/live 任意模式下触发，见 spec Q7），命名不应该嵌进 `buffered_retry` 命名空间，避免"buffered_retry 恒为 map"的既有铁律被误用——建议顶层新键 `anthropic.precontent_recovery: { enabled: boolean }`，与 `stream_commit_after_sec` 平级）。
  - `src/lib/config/config.ts` 新增映射行，镜像 `protect_streaming_escalate_context` 那种简单布尔映射的写法。
- [x] **Step 4: 跑，通过。** —— `bun test tests/config/buffered-retry-keys.unit.test.ts tests/config/config-hot-reload.it.test.ts`：404 pass，0 fail；`bunx eslint` 目标文件与 `bun run typecheck` 均通过。
- [x] **Step 5: 提交** → `feat(config): add precontent_recovery config scaffold (default enabled, not yet wired)`。

**已裁定命名与默认值：** 配置键使用 `precontent_recovery`，默认 `enabled: true`。P4/P5 完整接线前不读取该 state 字段，故这个默认值在本阶段没有用户可见副作用；后续接线须用测试锁定此顺序。

---

## Task 0.2：semantic-content gate（纯函数 + 一个 delivery-level 信号）

**🔴 CRITICAL 修正（对抗审 gpt-souls:reviewer 2026-07-23 发现、主会话 code-read 确认）：** 早前草案用 `session.boundary.result !== null` 作判据——**这是错的、会导致重复内容**。`CandidateBoundaryClassifier`（`boundary-classifier.ts:36-39`）对 Anthropic **只在真实 `content_block_stop` 关闭一个真实 block 时**才把 `result` 翻非 null；但**客户端真实内容早在 `content_block_delta` 就已交付**（`request-timing.ts:140` `isClientContentFrame` 对 Anthropic = `content_block_delta`）。故当一个真实 block 已 `content_block_start` + `content_block_delta`（客户端已看到真实文本）、但上游在 `content_block_stop` **之前** RST 时，`boundary.result` 仍为 `null` → 草案 gate 判「无语义内容」→ B2 发起 fresh dispatch → **fresh attempt 的内容被拼在客户端已见的部分真实内容之后 = 重复/损坏内容**。这正是 B2 语义 gate 本应防止的事故。

**正确判据（delivery-level，非 block-completed）：** gate 必须绑定到「**客户端 sink 实际写出过的首个非-synthetic 真实内容帧**」，在首个满足 `isClientContentFrame(frame, clientFormat)` 且非 synthetic 的帧写出时**不可逆翻转**。这与既有 `upstreamFirstTokenAt` 的捕获点是**同一个 delivery 信号**（`request-timing.ts:137` `isClientContentFrame` 已是权威检测器，四格式齐备：Anthropic=`content_block_delta`、Responses=`output_text.delta`、cc/gemini=有内容 chunk）——**复用它，不要另造判定**（battle-tested-over-hand-rolled）。`boundary.result`（block 已完成）是一个**更强**的条件，覆盖不了「delta 已发、stop 未到」这个正是事故形态的窗口，**不能**用作 gate。

**设计：** 在候选的 client-frame 写出点（forwarded 采样 / FirstToken 捕获所在的同一 egress 点）挂一个 delivery-level 布尔 `hasEmittedRealClientContent`（首个 `isClientContentFrame && !synthetic` 帧翻转、之后恒 true）。gate 读这个 flag，不读 `boundary.result`。

统一门（覆盖 pre-ready + ready-但-pre-content 两态）的判据：
- **pre-ready**（`runRequest`/fresh dispatch 从未拿到 `upstream`）：没有候选 session、必然一帧未写 → 恒 `false`（尚未交付任何语义内容，天然满足）。
- **ready 但流未产出真实内容**（已有 `upstream`，pump 正在跑，但上游在**首个真实 `content_block_delta`** 前失败）：`hasEmittedRealClientContent === false` → gate false（可安全 B2 恢复）。
- **ready 且已发过真实 delta**（哪怕 block 未 stop）：`hasEmittedRealClientContent === true` → gate **true**（**禁止** B2 fresh dispatch，避免重复；这一段属于 continuation-retry / truncation 的地盘，不是 B2）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/semantic-content-gate.unit.test.ts
import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

test("no session (pre-ready case) → false", () => {
  expect(hasDeliveredSemanticContent(undefined)).toBe(false)
})
test("session ready but NO real content_block_delta emitted yet → false (safe to recover)", () => {
  const session = { hasEmittedRealClientContent: false } as never
  expect(hasDeliveredSemanticContent(session)).toBe(false)
})
// 🔴 CRITICAL 回归：block 已 start+delta、stop 未到就 RST —— gate 必须为 true（否则重复内容）
test("session that emitted a real content_block_delta but NO content_block_stop yet → TRUE (must NOT re-dispatch)", () => {
  const session = { hasEmittedRealClientContent: true } as never
  expect(hasDeliveredSemanticContent(session)).toBe(true)
})
test("only a content_block_start (block opened, no delta) → false (no real bytes to the client yet)", () => {
  const session = { hasEmittedRealClientContent: false } as never
  expect(hasDeliveredSemanticContent(session)).toBe(false)
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现**：
  - `src/lib/pipeline/generation/semantic-content-gate.ts`（纯函数，读 delivery flag）：

```ts
export function hasDeliveredSemanticContent(session: { hasEmittedRealClientContent: boolean } | undefined): boolean {
  return session?.hasEmittedRealClientContent === true
}
```

  - 在 client-frame 写出点接线 `hasEmittedRealClientContent`：找到候选 session 逐帧写出/采样处（与 `request-timing` 调 `isClientContentFrame` 判 `upstreamFirstTokenAt` 的**同一** egress 点——实现者先 grep `isClientContentFrame` 的现有调用点确认 seam），首个 `isClientContentFrame(frame, clientFormat) && frame.provenance.kind !== "synthetic"` 时把 flag 置 true（不可逆）。**live 与 buffered 必须走同一 delivery 信号**（buffered 在 flush 真实帧时同样过这个写出点）——这是 reviewer 明确要求的「live/buffered 同一 delivery-level 信号」，实现者用 buffered 场景测试确认二者共用同一翻转点。

（**验证清单**：确认 `isClientContentFrame` 的现有调用 seam 是否恰好是候选 session 能挂 flag 的地方；若 FirstToken 捕获在 driver 采样层而候选 session 在更上层，需要把 flag 提到二者都可达的位置——不改变「delivery-level、首个真实 delta 翻转」这一判据本身。）

**⚠ flag 归属澄清（consensus 复审第二轮建议）：** flag 是 **delivery-scoped（每条客户端流一份）、只数非-synthetic 真实内容**——这正是「客户端是否已看到真实内容」（=「是否该发 B2」）的正确判据。reviewer 担心的「同一 sink 的全局 flag 会错误禁止 recovery」**只在误数 synthetic 帧时发生**，本设计用 `frame.provenance.kind !== "synthetic"` 过滤已避免：primary 只发了合成脚手架（keepalive ping / anchor）时 flag 恒 false、B2 正常放行；**fresh recovery candidate 写同一条流、其真实帧合法翻转 flag（gate 只在「发起 B2」决策点被读、决策点 flag 恒反映「至此客户端收到的真实内容」，fresh candidate 的写入永不被 flag 阻止）**。实现者须确认 buffered 候选与 live 候选驱动**同一个** delivery flag（reviewer 明确要求「live/buffered 同一 delivery-level 信号」），并补一条集成测试锁死该语义：

```ts
// tests/pipeline/semantic-content-gate.it.test.ts（补，driver/handler 级）
test("primary delivered NO semantic content (only synthetic scaffold) → gate false → B2 launches → fresh candidate CAN write real content and flips the flag", async () => {
  // primary 只发 synthetic keepalive 后 pre-content 失败 → 断言 gate 在发起 B2 前为 false
  // fresh recovery candidate 写真实 content_block_delta → 断言 flag 翻 true、真实内容正常到客户端、无重复
})
test("primary DID deliver a real content_block_delta then failed mid-block → gate true → B2 NOT launched (no duplicate)", async () => {
  // 断言：客户端已见真实 delta 后 RST → gate true → 不发 fresh dispatch，落既有 terminal/continuation 路径
})
```

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): delivery-level semantic-content gate (first real content_block_delta, not block-completed)`。

---

## Task 0.3：coordinator 新方法 `runRecoveryFromPreReadyFailure`

**设计依据：** 现有 `runHedge(env)`（`coordinator.ts:156-160`）已经是"在同一 budget 上开一个无 parent 要求的新候选"的现成形状：

```ts
runHedge(env = input.env) {
  if (hedgeStarted) throw new Error("[generation-coordinator] hedge already started")
  hedgeStarted = true
  return start({ role: "hedge", env })
},
```

B2 需要的是同构操作，但 role 用已存在的字面量 `"recovery"`（`CandidateRole = "primary" | "hedge" | "recovery" | "continuation"`，`model-operation-record.ts:249`），且必须**恰好触发一次**（B2 spec 明确"一次全新上游 dispatch"，非无限重试/无限竞速）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/precontent-recovery-coordinator.unit.test.ts
test("runRecoveryFromPreReadyFailure starts a fresh parent-less candidate with role recovery", async () => {
  // 用现有 tests/pipeline/candidate-runtime.it.test.ts 的 mock recording port + scheduler 套路
  // 断言：coordinator.runRecoveryFromPreReadyFailure(reason, env) 返回一个 CoordinatedCandidate
  // 断言：recording port 记录的 candidate role === "recovery"，且没有 parentCandidate 字段
})
test("calling it twice on the same coordinator throws (at-most-once, mirrors hedgeStarted guard)", async () => { ... })
test("budget/reservation accounting shares the SAME generation budget as the primary (not a fresh independent budget)", async () => {
  // 验证：runRecoveryFromPreReadyFailure 消耗的是同一个 createGenerationBudget 实例的额度
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线** —— `coordinator.ts` 的 `GenerationCoordinator<TProcessor>` 接口 + `createGenerationCoordinator` 实现：新增 `recoveryFromPreReadyStarted` 布尔守卫（镜像 `hedgeStarted`），`runRecoveryFromPreReadyFailure(reason, env) { if (recoveryFromPreReadyStarted) throw ...; recoveryFromPreReadyStarted = true; return start({role: "recovery", env}) }`。**不需要**settle 任何 parent（原 primary 已经在 `candidate.ts` 自行 settle 为 `failed`）——这是与 `runRecovery`/`runContinuation` 的关键差异，务必在代码注释里写清楚"为什么这里不 settle parent"（避免未来有人误以为漏写）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): coordinator.runRecoveryFromPreReadyFailure (parent-less recovery candidate)`。

**风险点（验证清单，实现者必须确认）：**
- `start()` 内部 `runtimes.set(runtime.handle, runtime)` + `active = runtime` 的赋值时序，与 `runHedge`/`runPrimary` 完全一致——确认没有"当 primary 已经因失败清空 `active` 后，新的 recovery 候选是否会被某个陈旧 `active` 引用绊住"的边界问题（读 `coordinator.ts:113` 附近的 `active` 变量全部读写点）。
- `raceReadyCandidates`/`racePrimaryWithDelayedHedge` 等竞速方法是否会因为 `recoveryFromPreReadyStarted` 候选存在而误判"这是一个可竞速的 hedge candidate"——B2 的 fresh dispatch **不参与竞速**，是串行替换，需确认调用方（driver.ts 新增的 `runPreContentRecovery`）走的是 `start()` 的直接结果，不经过 `raceReadyCandidates`。

---

## Task 0.4：driver 新方法 `runPreContentRecovery`

**设计依据：** `createPipelineDriver`（`driver.ts:222`）已经是一个闭包，`generation`（`DriverGenerationRuntime`）就是"跨 `runRequest`/`runResponse*` 调用共享的驱动实例状态"的先例。B2 在同一闭包里加一个新的 `let lastPreReadyFailure: {coordinator, env} | undefined` 槽位。

**关键设计要点（保证零回归）：** `runRequest` 对外的 Promise 语义完全不变——遇到 `coordinator.runPrimary()` reject 时，**先**把 `{coordinator, env: afterHook}` 存进 `lastPreReadyFailure`，**再** rethrow（与今天行为逐字节等价，除非调用方之后显式调用新方法）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/driver-precontent-recovery.it.test.ts
test("runRequest still rejects exactly as before when the primary dispatch never becomes ready (no observable behavior change)", async () => {
  // mock transport 恒 failed-open；断言 driver.runRequest(...) reject，异常内容/类型不变（回归锁）
})
test("after a pre-ready primary failure, driver.runPreContentRecovery(reason) retries via a fresh recovery candidate and succeeds when the SECOND dispatch attempt opens", async () => {
  // mock transport：第一次调用 open() 失败，第二次成功
  // 先 await 断言 driver.runRequest(...) reject
  // 再调 driver.runPreContentRecovery("upstream-rst") → 断言返回 {ok:true, upstream, env}
})
test("calling runPreContentRecovery WITHOUT a preceding pre-ready failure throws a programmer error", async () => { ... })
test("runPreContentRecovery gates on classifyServerExecutionRisk BEFORE dispatching the fresh attempt", async () => {
  // env.body 含 web_search_ 类工具 → 断言 runPreContentRecovery 直接抛/返回一个「gated」结果，绝不发起 fresh dispatch
  // 断言 mock transport 的 open() 只被调用了一次（即没有二次上游调用）
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线**：
  - `runRequest` 内部把 `const candidate = await exchangePromise` 包一层 try/catch：catch 时 `lastPreReadyFailure = { coordinator, env: afterHook }`，然后 `throw error`（不吞异常）。
  - 新增：

```ts
async function runPreContentRecovery(deps: DriverDeps, generation: DriverGenerationRuntime, getLastFailure: () => {coordinator, env} | undefined, reason: string): Promise<DriverRequestResult> {
  const failure = getLastFailure()
  if (!failure) throw new Error("[driver] runPreContentRecovery called without a preceding pre-ready failure")
  const wire = outboundPrepareWire(deps, failure.env)   // 复用已有内部函数，见 driver.ts:303
  const risk = classifyServerExecutionRisk(wire)
  if (risk.kind !== "none") {
    // 不发起 fresh dispatch —— 具体返回形状（抛错 vs 特殊 result variant）留 TDD 定，
    // 但语义上等价于「recovery ineligible，调用方应回退到既有 terminal-error 路径」
    throw new ServerExecutionRiskBlocksRecoveryError(risk)  // 名字待定，实现者可选用更贴合既有错误类体系的类型（见 src/lib/error/）
  }
  const candidate = await failure.coordinator.runRecoveryFromPreReadyFailure(reason, failure.env)
  generation.bind(failure.coordinator, candidate)
  return { ok: true, upstream: candidate.upstream, env: candidate.env }
}
```

  - `PipelineDriverWithNonStreaming` 接口新增 `runPreContentRecovery(reason: string): Promise<DriverRequestResult>`。
- [ ] **Step 4: 跑，通过 + 回归**（`bun run test:fast` 确认现有所有 `runRequest` 消费方零行为变化）。
- [ ] **Step 5: 提交** → `feat(pipeline): driver.runPreContentRecovery — fresh dispatch after a pre-ready primary failure, gated by classifyServerExecutionRisk`。

**门控问题（不自行拍板）：** server-tool-risk 命中时具体该"抛错"还是"返回一个专门的 result variant"，属于纯实现细节（不影响外部契约），但影响 P4/P5 的调用方写法是 try/catch 还是 if/else——建议实现者按 TDD 第一次跑到这里时观察调用方（handler-v4.ts）的实际控制流需求再定，别提前锁死。

---

## Task 0.5：recovery sink lifetime supervisor

**为什么需要：** `pumpAnthropicStreamingV4`（handler-v4.ts）现有的每个失败分支都在末尾 `sink.finalize?.()`（经外层 `finally`，handler-v4.ts:531-534 / :711-714）。若 B2 在"stream-error"分支里插入"先试一次 fresh recovery"，**不能让第一次失败路径先 finalize 掉 sink**——finalize 会停掉 heartbeat 计时器、标记"投递已终结"（`onDeliveryFinalized` 回调），这个回调目前接的是 `ctx.finalizeModelOperationDelivery()`（`request-timing.ts:179`），**过早调用会让 History 提前封存投递维度**，之后再写第二条内容会破坏时序/幂等假设。

**设计：** 一个包装 `ClientSink` 的 supervisor，把"调用方明确知道自己可能还要重试"的路径的 `finalize`/`close` 调用**拦截为 no-op**，只有 supervisor 自己认定"这是最终结局"（成功完成 / 恢复也失败 / 恢复被 gate 拒绝）才真正转发给内层 sink。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/recovery-sink-supervisor.unit.test.ts
test("wrapped sink's write/writeSynthetic/writeAnchor/writeKeepalive forward to inner sink unchanged", async () => { ... })
test("finalize()/close() called INSIDE a recovery attempt are suppressed (inner sink never sees them) until supervisor.settleFinal() is called", async () => {
  const { sink: inner, frames } = makeArraySink()
  const supervisor = createRecoverySinkSupervisor(inner)
  await supervisor.sink.write({ data: "..." })
  supervisor.sink.finalize?.()   // 应该是 no-op
  // 断言 inner 的 finalize 还没被调用（用一个可观测的 spy 包一层，或直接检查内部状态）
  supervisor.settleFinal()       // 现在才真正转发
  // 断言 inner.finalize 现在被调用了
})
test("settleFinal() is idempotent (calling twice does not double-finalize)", async () => { ... })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** `src/lib/pipeline/generation/recovery-sink-supervisor.ts`：包装 `ClientSink`，转发所有写方法，拦截 `finalize`/`close`，暴露 `settleFinal(): void`（幂等，真正调用内层 `close()` 然后 `finalize()`，顺序镜像现有 `finalize` 实现里 `close(); onDeliveryFinalized?.()` 的次序，见 `client-sink.ts:354-359`）。

**验证清单（实现者必须确认）：** `makeDeliverySseSink`（`client-sink.ts:467`）返回的 sink 实际上是 `createDownstreamDeliverySession` 包出来的（不是 `makeSseSink` 的裸实现）——supervisor 包装的是"最外层暴露给 pump 的 `ClientSink` 接口"，理论上与内部用的是 `makeSseSink` 还是 `makeDeliverySseSink` 无关（只要接口形状一致）。但要读一下 `createDownstreamDeliverySession`（`~/lib/pipeline/delivery/session`）确认它的 `finalize`/`close` 语义与本 supervisor 的假设（"close 停计时器、finalize 才是终态标记"）一致，避免 supervisor 拦截错了方法导致 heartbeat 计时器泄漏。

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(pipeline): recovery sink lifetime supervisor (defer finalize/close until final outcome)`。

---

## Task 0.6：MED-2 seal 后晚到 upstream 事件的 crash 安全（对抗审 HIGH，B2 必治）

**🟠 对抗审 gpt-souls:reviewer 2026-07-23 发现（主会话 code-read + Q5 实测确认）：** B2 处理「seal 后晚到的上游事件」这一 territory，但草案目录未覆盖。冻结 backlog 已明定 B2 必须对齐——见 [docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md) 的「timing 写入 vs 同族 capture 的 seal 边界不对称」条。**根因链（已核实）：** `dispatch-scheduler.ts:205-212` 在 `await input.open()` resolve 后**无守卫**调用 `recordOpened`，其 timing 写最终进 `model-operation-record.ts:1053` 的 `assertWritable()`——recorder 已 seal 时**抛错**（同族逐帧 capture 却是 `if(sealed) return` 静默丢弃）。若 operation 在一个 pre-header 的 `open()` 仍挂起期间被 seal（reaper/`request_deadline`/candidate-discard），随后**晚到的 deferred-header**（Q5 实测 header 到达高达 231s、上界未知，**显著拉长这个 pre-header 窗口**）resolve `open()` → `recordOpened` → `assertWritable` 抛错 → 沿 scheduler `run` 上抛 → 若 `p` 已无 live awaiter 则成**孤儿 rejection → unhandledRejection → process.exit**（skill `debugging-server-crashes` 的放大链）。**B2 引入 fresh dispatch 会新增更多「seal 后仍有在飞 open」的路径，放大此 race，故 B2 必须一并治，不能留给 backlog。**

- [ ] **Step 1: 写失败测试**（无 unhandled-rejection 回归）

```ts
// tests/pipeline/precontent-recovery-seal-race.it.test.ts（新）
test("late deferred-header open() resolving AFTER the operation is sealed does NOT throw an unhandled rejection", async () => {
  // mock transport：open() 在 N 秒后才 resolve（模拟 deferred-header）；期间用 reaper/deadline/abort seal 掉 operation
  // 断言：进程无 unhandledRejection（挂 process.once('unhandledRejection') 探针）；整个 recordOpened（headers + timing）在 sealed 时被安全丢弃、不抛
})
test("B2 recovery supervisor awaits candidate lifecycle quiescence after cancel/seal (no dangling late rejection)", async () => {
  // 断言：cancel/seal 后 supervisor await 所有在飞候选的 lifecycle.quiesced，观察到 late rejection 被吞（不逃逸）
})
```

- [ ] **Step 2: 跑，失败（先证探针能抓到坏行为——正样本对照，见 skill `catching-false-green-tests`）。**
- [ ] **Step 3: 实现**（对齐 backlog 条目的修法①②，采 consensus 复审建议的「整个 `recordOpened` 作 atomic late-open observer」）：
  - **① 守卫整个 `recordOpened`（不止 timing）**：consensus 复审（gpt-souls:reviewer 第二轮）指出——只丢 timing 不够，`recordOpened`（`driver.ts:634-643`）在 timing 前还调 `setHttpHeaders` + `setGenerationDispatchResponseHeaders`，须把**整个** `recordOpened` 当作 sealed 后可安全丢弃的晚到观测：在 `recordOpened` 开头判 recorder sealed → 直接 `return`（或让所有 `recordOpened` 的 context 写走统一的 sealed-safe observation API）。**主会话 code-read 核实的 ground truth（供实现者定位精确修点）**：`recordOpened` 里**当前唯一真会抛**的是 timing 写（`setGenerationDispatchTimingEpoch:1321`→`setDispatchTiming:1053`→`assertWritable`）——`setHttpHeaders:1205` 是纯 `_httpHeaders` 赋值不撞 recorder、`setAttemptResponseHeaders:1500` 的诊断已在 `request.ts:583` 守卫 sealed，二者今天不抛；但**整method 早返回**是更稳健的修法（防未来往 recordOpened 新增无守卫写、且 sealed 后整条 late-open 观测本就该整体丢弃），并须让 timing setter 本身也对齐同族 `if(sealed) return`（双保险，别只靠调用点）。**不改** `assertWritable` 对语义写的 loud-throw（那是既定正确设计）。回归矩阵覆盖**完整 `recordOpened` 路径**（headers + timing），不只断言 timing。
  - **② recovery supervisor 在 cancel/seal 后 await candidate lifecycle quiescence**：Task 0.5 的 supervisor 在最终收口前，`await` 所有它启动过的候选（primary + 任何 fresh recovery）的 `lifecycle.quiesced`，使晚到的 open/reject 在 supervisor 作用域内被观察、不逃逸成孤儿 rejection（参照 `dispatch-scheduler.ts:213-216` 现有 `void response.lifecycle.quiesced.then(...)` 的 budget release 模式，但改为 supervisor 显式 await 而非 fire-and-forget）。
- [ ] **Step 4: 跑，通过（reaper/deadline/abort × late-header 组合矩阵全绿、零 unhandled-rejection）。**
- [ ] **Step 5: 提交** → `fix(pipeline): B2 seal-race crash safety — discard late timing on sealed, supervisor awaits quiescence`。同时**从 [deferred-backlog.md](../../todo/deferred-backlog.md) 移除 MED-2 条**（已在 B2 落地、不再是 backlog）。

**注意**：这条同时修复了 MED-2 backlog 的独立 crash 风险（不止服务 B2）——是 B2 的必要前置，也顺带关闭了一个既有的潜在 process.exit 缺陷。

---

## Task 0.7：telemetry 计数器骨架

**设计依据：** 镜像 `protect-streaming-stats.ts` 现有的 `continuationExhausted` 模式（同一份统计对象，新增两个字段）。

- [x] **Step 1: 写失败测试**

```ts
// tests/anthropic/protect-streaming-stats.unit.test.ts（追加，若无此文件则新建）
test("recordProtectStreamingOutcome accepts 'precontent-recovery-success' / 'precontent-recovery-exhausted' outcomes", () => { ... })
```

- [x] **Step 2: 跑，失败。** —— `bun test tests/anthropic/protect-streaming-stats.unit.test.ts`（新增计数器断言收到 `undefined`，符合缺少字段/映射的预期）。
- [x] **Step 3: 接线** —— `ProtectStreamingOutcome` union（`~/lib/pipeline/types.ts`，`ProtectStreamingStats` 消费方 re-export 的类型）新增两个字面量；`protect-streaming-stats.ts` 的 `ProtectStreamingStats` interface + `emptyStats()` + `keyOf()` 补充映射（camelCase：`precontentRecoverySuccess` / `precontentRecoveryExhausted`）。
- [x] **Step 4: 跑，通过。** —— `bun test tests/anthropic/protect-streaming-stats.unit.test.ts`：13 pass，0 fail。
- [x] **Step 5: 提交** → `feat(telemetry): add precontent-recovery outcome counters (mirrors continuation counters)`。

---

## P0-P3 收口验收

- [ ] `bun run test:fast` + `bun run typecheck` 全绿。
- [ ] 四个新单元测试文件（gate / supervisor / coordinator 新方法 / driver 新方法）全部覆盖正向 + 边界（at-most-once、无 parent settle、server-tool gate 拦截、budget 共享）。
- [ ] **零外部行为变化**（配置默认值虽已设 `enabled:true`，但因为 P4/P5 尚未接线，任何现有请求路径都不应该有可观测差异——这条本身也要有一个回归测试断言，例如跑一个现有的 `postcommit-error-shaping.it.test.ts` 全套确认没有新增/减少任何断言失败）。

## 未采纳方案 / 记录

- **在 `runRequest` 里直接吞掉 pre-ready 失败、自动重试**：否决。会让 `runRequest` 的对外契约悄悄变成"可能内部重试一次"，而 handler 层完全无感知——违反"server-tool gate 必须在 handler/driver 边界显式检查一次"的安全要求（如果自动重试藏在 `runRequest` 内部，gate 检查点会很别扭地嵌进一个本该是"纯 S1-S4 编排"的函数里，且无法在语义门未过时提前短路，例如 P4/P5 需要先检查"是否已经开始向客户端写字节"）。
- **把 fresh dispatch 包装成 `runContinuation` 的一个特例（伪造一个"空" parent）**：否决。`runContinuation`/`runRecovery` 的语义都要求"parent 需要被 settle"，伪造一个从未 ready 的假 parent 会让 History 的 candidate 关系图出现语义错误的父子边（一个"从未存在过"的候选被记成另一个候选的 parent）。
