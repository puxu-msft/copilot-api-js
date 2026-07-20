# Phase 6（GATED）：post-commit 截断/RST 类可重试错误的 `defer-to-block-level` 消费接线

**门控声明（先读，非常规 Phase）**：本 Phase **不在本计划的执行日程内强制推进**。它记录的是"一旦 block-level P1 Task 6（`docs/spec/2026-07-11-block-level-buffered-retry.md`）落地 master 之后，本特性需要补的接线契约"，供 P1 落地后另起一轮任务时直接执行，不需要重新设计。**开工前置条件**：`docs/spec/2026-07-11-block-level-buffered-retry.md` 的 P1 Task 6（块级增量重放 + `protect_streaming_generation` 默认翻转）已落地 master，且其 `commitBoundaries(frame)` 谓词、首块前重放、首块后 `partial-degrade` 路径均已实测通过（block-level 计划自己的验收标准，不由本文档重复定义）。

若 Phase 0-5 已经交付但 P1 迟迟未落地，**这是可接受的中间状态**——spec G-4 明确本特性 post-commit 截断类目标"依赖 block-level P1 落地为前置"，非本计划范围内可控。此时 Phase 0-5 已经兑现 spec 目标 1/3/4/5 的绝大部分 + 目标 2 的 pre-commit 半部分；目标 2 的 post-commit 截断半部分保持"零改善"（现状行为，golden 锁保证不劣化），直到本 Phase 开工。

## 依赖

- Phase 0（config）、Phase 1（`error-shaping.ts` 的 `decide()` 已产出 `{ kind: "defer-to-block-level" }` 分支、`buildCanonicalErrorFrame`）、Phase 3（`errorFrameCanonicalRewrite` S5 rewrite 已就位，`buildCanonicalErrorFrame` 已是终局尾帧唯一入口）
- **外部依赖（不归本计划）**：block-level buffered retry P1 Task 6 落地 master

## 探索确认的关键事实（写在此处供 P1 落地后的实现者直接使用，避免重新反查）

- **本 Phase 不实现 spec 第 111 行提到的"anchor close/open 分叉改造"**——spec 原文明确："**此改造归 block-level P1（本 spec 只声明该接缝、不实现）**"。也就是说，"终点①错误路径现主动 `closeAnchorIfOpen` 发 stop@0，而 buffered ON 走 block-level 重放时 anchor@0 必须全程 open"这一改造，是 block-level P1 自己的任务范围（因为它是"启用 buffered 重放"这一行为本身引入的新约束，不是 error-shaping 决策引擎的职责）。本 Phase 只负责**消费** P1 落地后暴露的接口，不重复实现 P1 的工作。
- **`decide()` 对截断/RST 类错误的输出已经在 Phase 1 定型为 `{ kind: "defer-to-block-level" }`**（README 类型草图第 189 行），本 Phase 不需要改 `decide()` 本身的分类逻辑，只需要在调用点消费这个分支。
- **P1 Task 6 落地后，`streaming-pump.ts`/`handler-v4.ts` 里判断"是否走截断重放"的谓词（`commitBoundaries(frame)` 或等价物，具体命名以 P1 实际落地代码为准，不预先假设）会成为决定"要不要调用 block-level 重放路径"的分支条件**——本 Phase 的接线任务是：在这条分支**不满足**时（即 block-level 判定"这是真正的终局失败、无法重放"），仍然要经过 `decide()`/`buildCanonicalErrorFrame` 产出 canonical 尾帧（G-3 唯一所有权原样适用，不因为多了 block-level 分支就绕过）。
- **G-3 对 partial-degrade 尾帧同样适用**：spec 第 111 行"**block-level partial-degrade（§9.3）写的失败尾帧须流经本模块 canonical 化、不得各写各的**"——这意味着 P1 的 `partial-degrade` 路径在"首块后无法干净重试、被迫降级为失败"时写的那一帧终局失败帧，也必须调用 `buildCanonicalErrorFrame`，不能自己手搓 JSON。这是本 Phase 唯一的实质性产品代码改动点（一处调用替换，性质与 Phase 3 任务 3.2 完全同构）。

## 涉及文件（预期，以 P1 落地后的实际代码位置为准，届时需要重新 grep 核实行号——下列路径是本轮探索时的最佳猜测，不是钉死的行号承诺）

- `src/routes/messages/handler-v4.ts` 或 `src/routes/messages/streaming-pump.ts`（P1 Task 6 引入的截断重放/partial-degrade 分支所在文件，届时需重新确认）
- `src/lib/anthropic/error-shaping.ts`（不预期新增导出，复用 Phase 1/3 已有的 `buildCanonicalErrorFrame`）
- `tests/routes/messages/postcommit-truncation-shaping.it.test.ts`（新增，验收测试骨架见下）

## 验收测试骨架（先写骨架、不实现——P1 落地前无法驱动真实的截断重放场景，测试体只搭壳）

```ts
import { describe, expect, test } from "bun:test"

import { useIsolatedRuntime } from "~~tests/support/isolated-runtime"
import { state } from "~/lib/state"

describe.skip("[GATED — requires block-level P1 Task 6 landed] post-commit truncation defer-to-block-level consumption", () => {
  const runtime = useIsolatedRuntime()

  test("首块前截断/RST，block-level 判定可重放 → 走 P1 重放路径，error-shaping 不介入（decide() 从未被调用，因为 block-level 在更早的分支就吸收了这个错误）", async () => {
    // 前置：需要 block-level P1 落地后的 fixture 手法（fake server 中途 RST，首块尚未 flush）
    // 断言：客户端最终收到完整响应（P1 重放成功），过程中不产生任何 canonical-error 尾帧
  })

  test("首块后截断，block-level partial-degrade（无法干净重试）→ 终局失败尾帧必须是 error-shaping 的 buildCanonicalErrorFrame 产出（G-3），而非 P1 自己手搓的 JSON", async () => {
    state.errorShapingEnabled = true
    // 前置：fake server 首块 flush 后 RST
    // 断言 1：客户端收到部分内容 + 一个 canonical 形状的终局 error 帧（{type:"error", error:{type,message}}）
    // 断言 2：该终局帧与 Phase 3 任务 3.2 的 buildCanonicalErrorFrame 输出字段顺序/形状完全一致（同一个函数产出，不是巧合相似）
  })

  test("error_shaping_enabled=false 时，P1 partial-degrade 路径回退到 P1 自己的（或现状的）尾帧格式，不经 error-shaping（golden 锁在 P1 落地后依然成立）", async () => {
    state.errorShapingEnabled = false
    // 断言：尾帧格式与「本特性完全不存在」时的 P1 独立行为一致
  })
})
```

`describe.skip` 是有意为之——这些测试在 P1 落地前**无法通过也无法失败**（依赖的 fixture 与分支代码尚不存在），标记 skip 避免误报红/绿。P1 落地后开工的第一步就是把 `describe.skip` 改回 `describe` 并跑红，再按 TDD 正常推进。

## Phase 6 开工检查清单（P1 落地后，真正开工前逐项确认）

- [ ] 重新 grep `docs/spec/2026-07-11-block-level-buffered-retry.md` 对应实现代码，确认截断重放/partial-degrade 分支的准确文件路径与行号（不复用本文档预先写死的猜测路径）
- [ ] 确认 P1 落地后的 golden 字节锁测试（block-level 自己的验收测试）仍然全绿——本 Phase 的改动不应该破坏 P1 自己的验收
- [ ] 确认 Phase 3 的四终点 golden 字节锁测试（`error_shaping_enabled=false`，终点①/①'/H3/truncation）在 P1 落地后重跑仍然全绿（README D-0.5 已提示这一点，此处再次确认执行）
- [ ] **（评审 LOW-1）oracle 覆盖 `empty_text` 与 `ping` 两种 `streamKeepaliveMode`**：spec 第 125 行明确要求 post-commit 可重试错误的 buffered 重放 oracle 须分别在两种 keepalive 模式下驱动一遍（避免只测默认模式导致假绿——两种模式下 anchor 的 open/close 时序不同，可能暴露不同的重放边界条件）。Phase 3 的四终点 golden 锁不涉及重放、无需覆盖双模式（已在 Phase 3 完成检查里注明）；**这条覆盖要求真正的落地点是本 Phase**，开工时须新增/复用 `exp/cc-error-retry-surface` 里两种模式的 fixture 各跑一遍完整 e2e。
- [ ] 确认 spec 第 111 行"anchor close/open 分叉"改造已经由 block-level P1 自己完成（本 Phase 不做，只验证前置条件成立）
- [ ] 完整走 TDD 循环：`describe.skip`→`describe`（改动后应先跑红）→最小实现（partial-degrade 尾帧改为调用 `buildCanonicalErrorFrame`）→绿→提交
- [ ] 更新本计划 README 第 3 节 Phase DAG 图，把 Phase 6 从"GATED 未开工"标注为"已完成"，并在第 5 节 AC4 覆盖表行补充实际落地的 commit 引用

## 未采纳方案（供 P1 落地后的实现者知悉，避免重新踩同一个坑）

- **本计划自行实现 anchor close/open 分叉改造**——不采纳。spec 明确该改造归 block-level P1 所有，本特性的边界止于"canonical 化终局尾帧"，越界实现会造成两个 spec 的职责边界模糊、未来维护时难以判断该去哪个 spec 找权威定义。
- **在 P1 落地前用 mock/fake 谓词抢先实现接线逻辑**——不采纳。P1 的 `commitBoundaries`（或等价谓词）具体形状未定，抢先 mock 出来的接线代码大概率在 P1 真正落地后需要整体重写，不如把这部分工作量留到 P1 落地后一次性做对，避免双重返工。
