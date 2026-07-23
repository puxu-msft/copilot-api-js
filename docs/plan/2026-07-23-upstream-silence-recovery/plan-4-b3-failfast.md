# Plan-4: B3 —— pre-content 有界等待 + fail-fast 逃生舱

> **依赖：** Plan-3（B2-P4~P6）完成——B3 复用 B2 的"未交付语义内容"判据（`hasDeliveredSemanticContent`）与 gate 组合方式，且 B3 只在 B2 内部重试**耗尽**或**被 gate 拒绝**时才生效（B3 是最后一道防线，不是 B2 的替代）。
>
> **已裁决（spec §8 Q6，用户已确认，不再是待决项）：** 高上限 ~300s（≈ `responseHeaderTimeout`），纯逃生舱，零误伤已知合法长思考（观测最长 231s 都保）。

**Goal：** 把"commit 后仍无真实内容"的最坏情况（B2 内部重试也没救回来 / 被 server-tool-risk 拦下）的用户等待，从"最坏 300+s 硬等到 GHC 自己 RST"压到一个**可配、有明确上限、语义清晰**的 client-actionable SSE error（如 `overloaded_error` + 可读文案）。

## Files 清单

- Modify: `src/lib/state-defaults.ts`（新配置 `streamPrecontentFailfastSec`，默认对齐 `responseHeaderTimeout`=300，命名待定见下）
- Modify: `src/lib/config/schema.ts` + `src/lib/config/config.ts`（配置映射，clamp 下限>已知最长合法 B-Mode2 尾巴 231s，如 clamp 到 `[240, 600]` 之类的安全区间——**具体数值需要实现者核对 spec §3.2 实测的 231s 上界，clamp 下限必须严格大于它，建议 ≥250s 留安全边际**）
- Modify: `src/routes/messages/handler-v4.ts`（COMMIT 分支：在"未交付语义内容"的等待期新增一个独立计时器，到点主动收尾）
- Create: `src/routes/messages/precontent-failfast-timer.ts`（纯计时器管理，仿 `handler-v4.ts:549-563` 现有 `windowFired` 的 `Promise.race` 模式）
- Test: `tests/routes/messages/precontent-failfast.it.test.ts`（FakeClock 驱动，仿 `postcommit-error-shaping.it.test.ts` 的 FakeClock 用法）

## 设计要点

**B3 的计时起点是 commit 时刻，不是 fresh-recovery 发起时刻。** 也就是说，B3 的上限是"从 200 commit 到最终交付真实内容"的总预算（包含 B1 窗口内的等待 + B2 的一次 fresh recovery），而不是"只算 fresh recovery 那一段"——这样用户能获得一个**端到端**的、可预期的最坏等待上限，符合 spec §5.B-3 的原始设计意图（"把 206s 硬等压到可配上限"，是压全程，不是压 recovery 单独那一段）。

**触发条件（复用已有判据，不新造一套）：** B3 计时器到点时检查 `hasDeliveredSemanticContent(session)`——若已经交付了任何真实内容（哪怕只有一个 block），B3 不生效（内容已经在路上，没道理砍掉）；若仍未交付，无论是"B2 尚在进行中"还是"B2 已经失败/被 gate 拒绝、正落到现有 terminal-error 路径"，B3 都应该抢在更慢的路径前面把错误返回给客户端。

**与现有 header-timeout（`responseHeaderTimeout`，300s）的关系（待决，交主会话/用户）：** 两者数值上可能重叠（都约 300s）。是否需要把 B3 设计成"独立于 `responseHeaderTimeout` 的第二计时器"还是"复用同一个信号"？
- **倾向独立**：`responseHeaderTimeout` 是**上游连接层面**的 app-guard（`resolveResponseHeaderTimeoutMs`，`timeout-resolver.ts`），触发时机是"距上次 dispatch 发起多久没等到响应头"；B3 是**客户端交付层面**的计时（"距 200 commit 多久没交付语义内容"），两者的起点、触发对象都不同（B3 是"给客户端一个交代"，不是"掐断上游连接"）——即使数值相近，也不应该合并成同一个计时器，否则会耦合两个本该独立演进的关注点（架构合同层面，本计划把这一点当作既定分层设计，不视为需要用户裁决的新架构决策；但如果实现者发现两者数值/触发点实测下来存在竞态冲突——比如 B3 先触发导致上游连接被过早放弃，进而影响 B2 fresh dispatch 的机会——这是一个需要在 TDD 执行期实测验证的集成问题，不是纯设计问题）。

## TDD 步骤

### Task 5.1：配置骨架

- [ ] **Step 1: 写失败测试**

```ts
test("stream_precontent_failfast_sec defaults to ~300s, clamped to stay above the known longest legitimate B-Mode2 tail (231s + margin)", () => { ... })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线**（同 Plan-1 Task 1.1 的模式，新增独立 clamp 函数 `clampFailfastCeiling`，下限常量取 spec 实测的 231s + 安全边际，具体数值建议 250-300 区间，实现者可参照 header-timeout 默认值 300 对齐）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(config): add stream_precontent_failfast_sec (B3 escape-hatch ceiling, default ~300s)`。

### Task 5.2：计时器 + 触发逻辑

- [ ] **Step 1: 写失败测试**（FakeClock 驱动，仿现有 `postcommit-error-shaping.it.test.ts` 的 `FakeClock` 用法）

```ts
// tests/routes/messages/precontent-failfast.it.test.ts
test("no semantic content delivered by the failfast ceiling → client receives a client-actionable SSE error frame (e.g. overloaded_error)", async () => {
  // FakeClock 驱动上游永久静默（gated fetch mock 从不 resolve）；advance 到 failfast 上限
  // 断言客户端收到 event:error，error.type 语义清晰、非泛泛 api_error
})
test("real content delivered BEFORE the failfast ceiling → timer is a no-op (does not truncate a legitimate long-thinking response)", async () => {
  // B-Mode2 场景模拟：上游在接近但早于 failfast 上限时开始产出真实内容 → 断言 failfast 计时器不生效，正常走完
})
test("failfast_sec === 0 disables the ceiling entirely (unbounded wait, current behavior preserved)", async () => { ... })
test("failfast fires WHILE a B2 fresh-recovery attempt is in flight → the recovery attempt is cancelled, failfast error wins", async () => {
  // 验证 B3 与 B2 的交互：B3 到点时若 B2 正在跑 fresh dispatch，应该主动 cancel 掉（不留悬空候选）
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现** `precontent-failfast-timer.ts`：一个独立的 `Promise.race`（仿 `handler-v4.ts:549-563` 的 `windowFired` 模式），与"pump 正常运行的 promise"竞速；到点且 `!hasDeliveredSemanticContent(session)` 时：
  1. 若 B2 fresh-recovery 正在进行，调用其 cancel 路径（需要 `runPreContentRecovery` 暴露一个可取消的句柄——**这是一个额外的接口扩展点**，Plan-3 Task 0.3/0.4 若未预留取消能力，本 Task 需要回头补一个 `AbortSignal` 参数穿透）。
  2. 写一个 client-actionable 的终态 SSE error 帧（复用现有 `writeTerminalThenSettle` + `anthropicErrorFrame` 机制，参照 `post-commit-error.ts` 现有的 `anthropicErrorFrame(type, message)` 构造，type 建议 `overloaded_error`，message 说明"上游长时间未产出内容，请重试"）。
  3. `ctx.recordFeature(...)` 打一个可诊断标记（例如 `"precontent-failfast-triggered"`），供运维观测 B3 实际触发频率。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(anthropic): B3 precontent fail-fast ceiling (client-actionable terminal error, cancels in-flight B2 recovery)`。

### Task 5.3：telemetry + 观测

- [ ] **Step 1: 写失败测试** —— B3 触发次数可观测（`/api/status` 或类似既有面板，镜像 `protect-streaming-stats.ts` 的模式）。
- [ ] **Step 2-5**：同 Plan-2 Task 0.6 模式，新增一个计数器字段，不新造一套遥测机制。

## 验收 Oracle

- `bun run test:backend` 全绿。
- FakeClock 驱动的确定性测试（无真实等待 300s）。
- 遥测面板能看到 B3 触发次数（区分"B3 触发"与"B2 成功"两类结局，供运维判断"B2 覆盖率"）。

## 风险

- **中风险**：B3 与 B2 的取消交互（Task 5.2 test 4）——如果 B2 的 fresh dispatch 正在进行、B3 到点后没有正确取消，会出现"客户端已经收到 B3 的终态错误帧，但 B2 的 fresh dispatch 还在后台跑、最终成功却无处可去（sink 已经 finalize）"这种资源泄漏/浪费。**必须**有专门测试覆盖这个交互（已在 Task 5.2 列出）。
- **低风险**：数值 clamp 边界——已用"严格大于已知最长合法尾巴"的原则约束，配合 spec 的实测数据（231s），风险可控。

## 未采纳方案

- **B3 与 `responseHeaderTimeout` 合并成一个计时器**：见上方设计要点，否决理由已列（关注点分层）。
- **B3 默认更低的上限（如 90s）**：spec Q6 已经过用户裁决否决（会误杀已知合法长思考，231s 的正样本铁证在先）——本计划不再重提这个选项。
