# P6 — 心跳生命周期修复（**现网缺陷**，可独立于 A 先行落地）

> **前置**：P0。**必须先于 P2 与 P5**（**不是**「与 P1–P4 无代码重叠可并行」——那是 plan review 坐实的事实错误：P2 与本相位都改 `delivery/session.ts` 的 heartbeat 生命周期语义，见 README 并行机会小节与 Task 2.2b 交叉门）。可与 **P1** 并行。
> **本相位不在冻结设计与审查报告里** —— 是 planner 在读码 + 实测中发现的缺陷。它不改变设计的目标或架构方向。
>
> **定位（用户 2026-07-27 裁决，提升）**：这**不只是** A 的前置门。CC 与 Responses 的 buffered **默认就是 `true`**，所以该缺陷**当前很可能已在现网生效**——首块提交后心跳永久死亡、之后整段静默无任何保活。故 **P6 自身即有独立生产价值，可以先于 A 的其余相位单独落地、单独合并**，不必等 allocator。若需尽快止血，P0 → P6 是一条完整的可交付路径。

## 缺陷

`driver.ts` 的 block-level boundary commit 序列：

```text
sink.suspendHeartbeat()            // driver.ts:1269 / :1293   —— 可恢复挂起
  → flushBufferedFrames(...)
      → sink.freezeHeartbeat()     // driver.ts:1145           —— 「只停 timer、不关 sink」
  → sink.resumeHeartbeat()         // driver.ts:1271 / :1326   —— 期望恢复
```

在**生产的 delivery-session sink** 上：

- `freezeHeartbeat` 映射为 `closeHeartbeat`（`delivery/session.ts:167`），它置 `heartbeatStopped = true`（:98）；
- `resumeHeartbeat` 的守卫是 `if (!heartbeatSuspended || state !== "open" || heartbeatStopped) return`（:173）；
- 故 **`heartbeatStopped` 为真 → resume 直接 return → 心跳永久死亡**。

在 **raw sink**（`makeSseSink`）上不存在此问题：其 `freezeHeartbeat` 只 `clearTimeout`（`client-sink.ts:367-372`），不置任何永久标志，`resumeHeartbeat` 能 `rearmHeartbeat()` 复活。

## 实测证据（planner，FakeClock + 正样本对照）

**层一：sink 契约层**

```text
CONTROL   (suspend → resume,          raw sink):         ["ping","ping","ping","ping"]
CONTROL   (suspend → resume,          delivery session): ["keepalive:ping" ×10]
PRODUCTION(suspend → freeze → resume, delivery session): []                    ← 心跳死亡
```

**层二：真 driver 端到端**（`runResponseBufferedSink` + 真 `commitBoundaries` + gated upstream：一个完整块 → 120s 块间静默）

```text
RAW SINK      keepalives during 120s inter-block silence: 5
DELIVERY SINK keepalives during 120s inter-block silence: 0     ← 现网形状
```

两层都带正样本对照证明探针触达目标：同一 harness 换成 raw sink 就能看到 keepalive；只有生产 sink + 真实 boundary commit 才归零。**层二尤其关键**——它证明这不是「sink 契约的理论分歧」，而是走真 driver、真 commit 边界就会发生的实际行为。

> **证据等级说明（plan review minor）**：**根因与方向**已被独立复核坐实（reviewer 自己复现了层一，并从 driver 控制流独立推出生产 sink 的心跳死亡）。但层二那对精确计数 `RAW 5 / DELIVERY 0` 目前**只存在于文档叙述**——planner 的一次性探针已按纪律删除，当前分支没有可直接复跑的产物。**开工前不得把这两个数字当作已留存的可重复证据**；Task 6.3 / 6.3b 的职责正是把它固化为仓库内测试。届时以测试实测值为准，与此处叙述不符时**以测试为准并更正本文**。

## 影响面（用户裁决要求写明；planner 逐条核实）

**触发条件**：走 `runResponseBufferedSink` **且**有 `commitBoundaries` 命中（= 发生过 block-level boundary commit）**且** sink 是 `makeDeliverySseSink`。三者同时满足即中招。

| 端点 | buffered 默认 | sink | `commitBoundaries` | 当前是否受影响 |
|---|---|---|---|---|
| **Responses HTTP** | **`true`**（`state-defaults.ts:243` `responsesBufferedRetry`） | `makeDeliverySseSink`（`responses/handler-v4.ts:347`） | **有**，`candidate-response-session.ts:140` 仅 `transport === "http"` 挂 `isResponsesCommitBoundary`（边界含 `response.output_item.done`——**多 item 响应每个 item 都是一次 commit**） | **是。默认配置即中招** |
| **Chat Completions** | **`true`**（`state-defaults.ts:100` `chatCompletionsBufferedRetry`） | `makeDeliverySseSink`（`chat-completions/handler-v4.ts:519`） | 有，但**退化**：`ccCommitBoundaries` 只认 in-band 上游 `error` 帧，普通/finish chunk 恒 false（`handler-v4.ts:357` + 其注释；独立探针复核过） | **正常响应结构性幸免**（无 mid-generation boundary commit）；**error 之后是否仍有帧属契约待验证**，由 Task 6.3b Step 5 裁决 |
| **Responses WS** | `true`（同一 key） | WS sink | **故意省略**（`responses/ws.ts:376-394`，terminal-only） | 否（无 boundary commit） |
| **Anthropic** | `false`（`state-defaults.ts:84` `protectStreamingGeneration`） | `makeDeliverySseSink`（`messages/handler-v4.ts:1073`） | 有，`anthropicCommitBoundaries`（`content_block_stop`/`error`） | **默认否**；但**用户显式开启 `protect_streaming_generation` 即中招**，且这正是 A 的目标制度 |
| Gemini | 无 buffered | — | — | 否 |

**结论**：**Responses HTTP 在 bundled 默认配置下就受影响**——一个多 output_item 的响应，第一个 `response.output_item.done` 提交后心跳即永久死亡，其后任意长的上游静默都不再有保活帧，客户端只能等自己的 idle 超时。这与 A 无关，是当前现网行为。

**为什么至今没被发现（测试盲区）**：

1. **现有 anchor / 心跳测试全部构造 raw sink**（`anchor-multiblock-lifecycle.it.test.ts`、`buffered-anchor*.test.ts`、`retreat-anchor-collision.it.test.ts`、`client-sink*.test.ts` 等一律 import `makeSseSink`），而生产三条 buffered 路径全部走 `makeDeliverySseSink`。两条 sink 对同一组 `freeze/suspend/resume` **实现语义不同**，测试装在语义较宽松的那条上。
2. `delivery-session.unit.test.ts` 虽然直接测 delivery session，但**没有一条测试组合 `freeze` + `resume`**——它测的是 suspend/resume 与 escalation 的 cadence，从未复现 driver 的 `suspend → freeze → resume` 三步真实序列。
3. 症状是**沉默的**：没有异常、没有错误帧、没有测试红，只是「静默期少了几个 ping」。只有长静默的真实请求才显形，而长静默请求本来就少、且失败常被归因于上游。

这是「通过/干净结论不自证」的教科书案例——**同名方法在两条实现上语义分歧 + 测试只装在宽松那条**。此教训在 P8.6 提炼进记忆库。

## 为什么它同时是 A 的硬前置门

A 的 gap anchor **由心跳 tick 注入**。首个真实块提交后（= 第一次 boundary commit）生产心跳已死 → gap anchor 永不注入 → A 的全部机制在生产上是死码。而 P5 的 oracle 若沿用现有 raw-sink harness，会**假绿**。故：① P6 必须先于 P5；② P5 及后续端到端 oracle 必须建在 delivery session 上。

## Files

- Modify: `src/lib/pipeline/delivery/session.ts`（区分「可恢复冻结」与「永久关闭」）
- Modify: `src/lib/pipeline/types.ts`（若 `ClientSink` 需要澄清两个方法的契约注释）
- Test: `tests/pipeline/delivery-session.unit.test.ts`（追加）；新 `tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts`

## Interfaces

- `ClientSink.freezeHeartbeat()` 的契约需被**明确写死**（当前两个实现分歧就是因为契约只在注释里、且两边注释各说各话）：
  - **裁决**：`freezeHeartbeat` = 「停止定时器，但**不**关闭 sink，`resumeHeartbeat` 仍可复活」——这是 raw sink 的语义，也是 `client-sink.ts:361-366` 注释明写的原意（"stops the heartbeat timer WITHOUT closing the sink — `write` stays fully usable (unlike close(), which sets `stopped`)"），delivery session 是**实现偏离了既有契约**。
  - 永久关闭由 `close()` 负责（delivery session 已有 `close: closeHeartbeat`，语义正确）。
  - **这不是新架构决策，是把两个实现对齐到既有的、有文字记载的契约。**

---

## Task 6.1：锁住缺陷（先红）

- [x] **Step 1: 写失败测试**

```ts
// tests/pipeline/delivery-session.unit.test.ts（追加）
test("freezeHeartbeat is RECOVERABLE: resumeHeartbeat revives the timer (contract parity with makeSseSink)", async () => {
  clock.install()
  const writes = []
  const delivery = createDownstreamDeliverySession({ sink: arraySink(writes), monotonicNow: Date.now,
    heartbeat: { intervalMs: 20_000, frame: () => pingFrame } })
  const cs = delivery.clientSink
  cs.suspendHeartbeat?.()
  cs.freezeHeartbeat?.()                        // ← 生产 boundary-commit 的真实形状
  await cs.write(frame("content_block_stop", 0))
  cs.resumeHeartbeat?.()
  writes.length = 0
  for (let i = 0; i < 4; i++) { await clock.advance(20_000); await drain() }
  expect(writes.length).toBeGreaterThan(0)      // 今天是 0
})
test("close() remains PERMANENT: resumeHeartbeat must NOT revive after close", async () => {
  // 负样本 —— 防止修复过头，把永久关闭也变成可恢复
})
```

- [x] **Step 2**：跑，第一条红、第二条绿。
- [x] **Step 3**：（不实现，本 task 只锁缺陷）
- [x] **提交** → `test(delivery): lock that freezeHeartbeat must stay recoverable`

## Task 6.2：修复

- [x] **Step 1**：（oracle 已在 6.1）
- [x] **Step 2**：确认 6.1 第一条红。
- [x] **Step 3**：实现——delivery session 分离两个动作：
  - `freezeHeartbeat` → 只 `stopHeartbeat()`（清 timer），**不**置 `heartbeatStopped`；
  - `close` → 保持 `closeHeartbeat()`（置 `heartbeatStopped` + 清 timer）。
  - `resumeHeartbeat` 的守卫保持不变（`heartbeatStopped` 仍是永久关闭的判据）。
  - **注意 `terminate()`**（`session.ts:200` 附近）调 `closeHeartbeat()` —— 那是终局，语义正确，不动。
- [x] **Step 4**：跑，6.1 两条全绿。
- [x] **Step 5**：回归——`freezeHeartbeat` 的**原始用途**是「flush 期间防 tick 插帧」。改成不永久关闭后，必须确认：flush 内的 `await sink.write` 让点上，tick 不会插进真实块的 deltas 中间。
  - 这由 `suspendHeartbeat`（driver 在 flush 外层调，`:1269/:1293`）保证——`heartbeatSuspended` 使 tick 早返回且不重排。
  - 但**终局 flush 路径**（`driver.ts:1105` `closeAnchorIfOpen` 里的 `freezeHeartbeat`、`keepalive-anchor.ts:181`）**没有**外层 suspend，它依赖 freeze 的永久性。→ 这些站点改调 `close?.()` 还是保留 freeze？
  - **裁决依据**：终局路径之后没有后续真实流（`keepalive-anchor.ts:164-166` 注释明写"a terminal failure has NO subsequent real stream…so freezing is harmless"）。故终局站点应调**能永久停**的入口。实施期：给这些站点一个明确的 `stopHeartbeatPermanently()`（或直接复用 `close?.()` 若不产生额外副作用——**核实 `close()` 是否还做别的事**，`session.ts:178` 的 `close: closeHeartbeat` 看起来只关心跳，但 raw sink 的 `close()` 会置 `stopped` 并影响 write，需逐一核实两条 sink）。
  - **若核实发现两条 sink 的 `close()` 副作用不一致而无法统一**，停下记录 + 回主会话（契约分叉）。
- [x] **Step 6**：mutation——把 `freezeHeartbeat` 改回置 `heartbeatStopped`，确认 6.1 第一条转红。
- [x] **Step 7: 提交** → `fix(delivery): freezeHeartbeat must not permanently kill the heartbeat`

## Task 6.3：集成层证明（生产 sink 上的 boundary commit）

> 单元层证明了 sink 契约，但真正要证的是：**走真 driver 的 block-level boundary commit 之后，生产 sink 上心跳仍活**。

- [x] **Step 1: 写失败测试**

```ts
// tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts
test("after a real block-level commit on the PRODUCTION delivery sink, an inter-block idle still emits keepalives", async () => {
  // 用 makeDeliverySseSink（非 makeSseSink）+ 真 runResponseBufferedSink + anthropicCommitBoundaries
  // gated upstream：真实块（提交）→ 长静默
  // 断言静默期收到 >= 1 个 keepalive 帧
})
test("POSITIVE CONTROL: the same harness on a raw sink already emits keepalives today", async () => {
  // 证明 harness 有裁决力（planner 实测：raw 5 vs delivery 0）
})
```

- [x] **Step 2**：跑，红（planner 已实测该形状为 0 keepalive）。
- [x] **Step 3**：（6.2 应已修好；若仍红说明还有第二个死因，查下去）
- [x] **Step 4**：跑，绿。
- [x] **提交** → `test(pipeline): heartbeat survives block-level commit on the production delivery sink`

## Task 6.3b：受影响端点的回归覆盖（**Responses HTTP 是默认中招的那个**）

> 影响面表显示 **Responses HTTP 在 bundled 默认配置下就受影响**（`responsesBufferedRetry: true` + `response.output_item.done` 边界 + delivery sink）。Anthropic 只在用户开启 `protect_streaming_generation` 时中招。故回归覆盖**不能只写 Anthropic 一条**——否则默认就在受害的那条路径反而没测。

- [x] **Step 1: 写失败测试** —— Responses HTTP 版本

```ts
// tests/responses/heartbeat-survives-item-commit.it.test.ts
test("Responses HTTP: after the first response.output_item.done commit, an idle still emits keepalives", async () => {
  // 真 runResponseBufferedSink + isResponsesCommitBoundary + makeDeliverySseSink
  // 上游：output_item.done（提交）→ 长静默 → 第二个 item
  // 断言静默期 keepalive >= 1
})
```

- [x] **Step 2**：跑，红。
- [x] **Step 3**：（由 6.2 的修复覆盖——本 task 只加**该端点的**回归锁）
- [x] **Step 4**：跑，绿。
- [x] **Step 5**：CC 端点评估——其 `ccCommitBoundaries` 只认带 `error` 字段的上游终态错误帧（`src/lib/openai/cc-commit-boundaries.ts`），普通 delta、finish chunk 与 `[DONE]` 均非 boundary；error 帧本身是终态且之后没有合法帧继续发送，正常响应只走终局 flush。结论：**结构性无影响**，无需新增 CC heartbeat 回归锁。
- [x] **提交** → `test(responses): lock heartbeat survival across output_item commits`

## Task 6.4：现有 anchor 测试的 sink 迁移评估

> 现有 anchor 套件全用 raw sink。P5 之后 A 的生产行为依赖 delivery session。**不要求**全量迁移（那是大改造），但要求：

- [x] **Step 1**：列出哪些测试**必须**迁到 delivery sink 才有裁决力（凡断言「心跳/anchor 注入时机」的）。
- [x] **Step 2**：对每一条，迁移或**补一条** delivery-sink 版本（补比迁安全——raw sink 版本仍锁住 raw sink 的契约）。
- [x] **Step 3**：把清单写进本文件下方表格。
- [x] **提交** → `test(anchor): add production-sink coverage where heartbeat timing is load-bearing`

## sink 覆盖清单（实施期填写）

| 测试文件 | 当前 sink | 是否需 delivery 版本 | 处置 |
|---|---|---|---|
| `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` | raw | 是，心跳时机承重 | 保留 raw 全序 oracle；新增 `heartbeat-survives-boundary-commit.it.test.ts` 的 production delivery 版本与 raw 正控 |
| `tests/pipeline/retreat-anchor-collision.it.test.ts` | raw | 是，retreat 后恢复时机承重 | 既有测试保留；本相位用 production boundary regression 覆盖共享 `suspend → freeze → resume` 契约，retreat 终局/接续仍由原结构测试锁定 |
| `tests/pipeline/buffered-anchor.unit.test.ts` | raw | 否，主断言是 anchor 帧结构与 remap，不以 delivery timer 生命周期裁决 | 保留 raw；不重复迁移 |
| `tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts` | production delivery（经真实 handler） | 已是 | 保留；新增真 driver 的 focused delivery-sink boundary regression 以隔离本缺陷 |

## P6 收口

- [x] `typecheck` + `test:fast` 绿。
- [x] O-8 绿；正/负样本对照双向验证（可恢复 freeze 能复活、永久 close 不能复活）。
- [x] 终局路径的 freeze/close 裁决已落地并注明理由。
- [x] **受影响端点各有回归锁**：Anthropic（6.3）+ Responses HTTP（6.3b）+ CC 的评估结论。

## 独立交付（用户裁决）

本相位**可独立于 A 的其余相位合并**——它修的是当前现网缺陷（Responses HTTP 默认配置即受影响），自身即有生产价值。

若走独立交付路径：

- [x] 路径 = **P0 → P6**（P0 的 O-6 字节等价与套件基线仍需先建，用于证明本修复不改变短请求 wire）。
- [ ] 独立交付前额外补：`bun run test:backend` 全绿 + 异模型 reviewer 审这一相位的合并态。当前执行环境无 Rust 默认 toolchain，故按用户指示用 `bun scripts/parallel-test.ts unit it http` 替代 `test:backend` 的 native build 前置；本叶子 agent 不能派生 reviewer，须由主会话完成异模型 merged-state review。
- [x] `docs/DESIGN.md` 与 `docs/todo/deferred-backlog.md` 同步该缺陷的发现与修复（不必等 P8.6 的整体 doc-sync）。
- [x] **仍需**在 A 的其余相位开工前完成——P5 依赖它。

**注意**：独立交付**不改变** P5 对它的依赖，也**不**把它从本 plan 中摘除；只是它的合并时机可以提前。
