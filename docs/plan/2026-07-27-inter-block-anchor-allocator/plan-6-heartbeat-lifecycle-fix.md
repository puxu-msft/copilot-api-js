# P6 — 心跳生命周期修复（A 的前置缺陷）

> **前置**：P0。**可与 P1–P4 并行**（无代码重叠）。**必须先于 P5**。
> **本相位不在冻结设计与审查报告里** —— 是 planner 在读码 + 实测中发现的前置缺陷。它不改变设计的目标或架构方向，只是移除「A 落地后在生产上仍是死码」的障碍。

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

```text
CONTROL   (suspend → resume,          raw sink):         ["ping","ping","ping","ping"]
CONTROL   (suspend → resume,          delivery session): ["keepalive:ping" ×10]
PRODUCTION(suspend → freeze → resume, delivery session): []                    ← 心跳死亡
```

正样本对照证明探针确实触达目标：同一 harness 在不调 `freezeHeartbeat` 时能观察到 keepalive；只有加上 `freezeHeartbeat`（= 生产 boundary-commit 的真实形状）才归零。

## 为什么现有测试测不到

全部 anchor / 心跳测试都构造 **raw sink**（`anchor-multiblock-lifecycle.it.test.ts`、`buffered-anchor*.test.ts`、`retreat-anchor-collision.it.test.ts` 等 import `makeSseSink`），而生产 Anthropic 走 `makeDeliverySseSink`（`handler-v4.ts:1073`）。两条 sink 对同一组 `freeze/suspend/resume` 语义**实现不同**，测试装在语义较宽松的那条上——这正是「通过/干净结论不自证」的教科书案例。

## 为什么这是 A 的硬前置门而非独立 backlog

A 的 gap anchor **由心跳 tick 注入**。首个真实块提交后（= 第一次 boundary commit），生产心跳已死 → gap anchor 永不注入 → A 的全部机制在生产上是死码。而 P5 的 oracle 若沿用现有 raw-sink harness，会**假绿**。故：① P6 必须先落；② P5 及后续的端到端 oracle 必须建在 delivery session 上。

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

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2**：跑，第一条红、第二条绿。
- [ ] **Step 3**：（不实现，本 task 只锁缺陷）
- [ ] **提交** → `test(delivery): lock that freezeHeartbeat must stay recoverable`

## Task 6.2：修复

- [ ] **Step 1**：（oracle 已在 6.1）
- [ ] **Step 2**：确认 6.1 第一条红。
- [ ] **Step 3**：实现——delivery session 分离两个动作：
  - `freezeHeartbeat` → 只 `stopHeartbeat()`（清 timer），**不**置 `heartbeatStopped`；
  - `close` → 保持 `closeHeartbeat()`（置 `heartbeatStopped` + 清 timer）。
  - `resumeHeartbeat` 的守卫保持不变（`heartbeatStopped` 仍是永久关闭的判据）。
  - **注意 `terminate()`**（`session.ts:200` 附近）调 `closeHeartbeat()` —— 那是终局，语义正确，不动。
- [ ] **Step 4**：跑，6.1 两条全绿。
- [ ] **Step 5**：回归——`freezeHeartbeat` 的**原始用途**是「flush 期间防 tick 插帧」。改成不永久关闭后，必须确认：flush 内的 `await sink.write` 让点上，tick 不会插进真实块的 deltas 中间。
  - 这由 `suspendHeartbeat`（driver 在 flush 外层调，`:1269/:1293`）保证——`heartbeatSuspended` 使 tick 早返回且不重排。
  - 但**终局 flush 路径**（`driver.ts:1105` `closeAnchorIfOpen` 里的 `freezeHeartbeat`、`keepalive-anchor.ts:181`）**没有**外层 suspend，它依赖 freeze 的永久性。→ 这些站点改调 `close?.()` 还是保留 freeze？
  - **裁决依据**：终局路径之后没有后续真实流（`keepalive-anchor.ts:164-166` 注释明写"a terminal failure has NO subsequent real stream…so freezing is harmless"）。故终局站点应调**能永久停**的入口。实施期：给这些站点一个明确的 `stopHeartbeatPermanently()`（或直接复用 `close?.()` 若不产生额外副作用——**核实 `close()` 是否还做别的事**，`session.ts:178` 的 `close: closeHeartbeat` 看起来只关心跳，但 raw sink 的 `close()` 会置 `stopped` 并影响 write，需逐一核实两条 sink）。
  - **若核实发现两条 sink 的 `close()` 副作用不一致而无法统一**，停下记录 + 回主会话（契约分叉）。
- [ ] **Step 6**：mutation——把 `freezeHeartbeat` 改回置 `heartbeatStopped`，确认 6.1 第一条转红。
- [ ] **Step 7: 提交** → `fix(delivery): freezeHeartbeat must not permanently kill the heartbeat`

## Task 6.3：集成层证明（生产 sink 上的 boundary commit）

> 单元层证明了 sink 契约，但真正要证的是：**走真 driver 的 block-level boundary commit 之后，生产 sink 上心跳仍活**。

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts
test("after a real block-level commit on the PRODUCTION delivery sink, an inter-block idle still emits keepalives", async () => {
  // 用 makeDeliverySseSink（非 makeSseSink）+ 真 runResponseBufferedSink + anthropicCommitBoundaries
  // gated upstream：真实块（提交）→ 长静默
  // 断言静默期收到 >= 1 个 keepalive 帧
})
```

- [ ] **Step 2**：跑，红。
- [ ] **Step 3**：（6.2 应已修好；若仍红说明还有第二个死因，查下去）
- [ ] **Step 4**：跑，绿。
- [ ] **提交** → `test(pipeline): heartbeat survives block-level commit on the production delivery sink`

## Task 6.4：现有 anchor 测试的 sink 迁移评估

> 现有 anchor 套件全用 raw sink。P5 之后 A 的生产行为依赖 delivery session。**不要求**全量迁移（那是大改造），但要求：

- [ ] **Step 1**：列出哪些测试**必须**迁到 delivery sink 才有裁决力（凡断言「心跳/anchor 注入时机」的）。
- [ ] **Step 2**：对每一条，迁移或**补一条** delivery-sink 版本（补比迁安全——raw sink 版本仍锁住 raw sink 的契约）。
- [ ] **Step 3**：把清单写进本文件下方表格。
- [ ] **提交** → `test(anchor): add production-sink coverage where heartbeat timing is load-bearing`

## sink 覆盖清单（实施期填写）

| 测试文件 | 当前 sink | 是否需 delivery 版本 | 处置 |
|---|---|---|---|
| `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` | raw | _待填_ | |
| `tests/pipeline/retreat-anchor-collision.it.test.ts` | raw | _待填_ | |
| `tests/pipeline/buffered-anchor.unit.test.ts` | raw | _待填_ | |
| `tests/anthropic/keepalive-buffered-anchor-e2e.http.test.ts` | _待填_ | _待填_ | |

## P6 收口

- [ ] `typecheck` + `test:fast` 绿。
- [ ] O-8 绿；正/负样本对照双向验证（可恢复 freeze 能复活、永久 close 不能复活）。
- [ ] 终局路径的 freeze/close 裁决已落地并注明理由。
