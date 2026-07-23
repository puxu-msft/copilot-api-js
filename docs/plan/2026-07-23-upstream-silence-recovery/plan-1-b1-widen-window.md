# Plan-1: B1 —— 加宽 delayed-commit 窗口

> **依赖：** 无（可与 B2-P0 并行）。**门控：** Q1（CC pre-header 容忍度）**已实测下界 ≥125s**（`exp/silence-recovery-gates/FINDINGS.md`，真 Claude Code 2.1.218 静默 125s 仍成功；首次失败点未测、区间 `[125s, 未知)`）——本阶段把窗口上限设计成参数化 + clamp，以 ≥125s 为地板，最终具体上限值待补测 130/150/180s 阶梯后填一个常量，不改结构。⚠ 事故 RST 最早 ~126s，故 B1 单独不覆盖事故、B2 才是主线。

**Goal：** 把更多合法长思考（B-Mode2，header 到达 <当前默认 20s~新上限）与短挂起（在窗口内即失败的 A）拉回原生重试保护区——客户端拿到真实 HTTP 状态、CC 原生重试/backoff/token-refresh 继续生效，零合成脚手架。**不依赖任何 A/B 判别、不误伤 B**（spec §5.B-1 已定论）。

**为何低风险：** 纯改一个数值型配置的默认值 + clamp 上限，机制本身（`Promise.race([p, windowFired])`）完全不动，`handler-v4.ts:548-565` 零结构改动。

## 文件清单

- Modify: `src/lib/state-defaults.ts`（`streamCommitAfterSec` 默认值，当前 20）
- Modify: `src/lib/config/config.ts`（`clampKeepaliveCadence` 的上限常量 `KEEPALIVE_CADENCE_MAX`，当前 `60-20=40`；**注意**：这个 clamp 目前是 `stream_keepalive_ping_sec` / `stream_commit_after_sec` 共用的同一上限，B1 若要把 commit 窗口的上限与 keepalive cadence 的上限分开，需要拆分两个独立 clamp 函数/常量——这是本阶段的一个**待决设计点**，见下）
- Modify: `src/lib/config/schema.ts`（`stream_commit_after_sec` 的 TSDoc 说明，反映新默认值/上限来源）
- Test: `tests/config/buffered-retry-keys.unit.test.ts`（已有 clamp 测试，加新上限断言）
- Test: `tests/anthropic/stream-immediate-keepalive.http.test.ts` / 其余引用 `streamCommitAfterSec` 的既有测试（回归检查，不应破坏）

## 门控问题（不自行拍板，交主会话/用户）

**Q1 已实测下界 ≥125s（旧「50-55s」估计证伪），但首次失败点未测。** 本阶段可以把 clamp 上限从旧的 40 提到已知安全下界（≥125s），但「最终默认值 + 最终上限」仍建议分两步：**先落地拆分重构（默认值暂不动），再补测首次失败点后一次性定默认值。** 建议顺序：

1. 本阶段先落地「clamp 上限可独立配置」的重构（见 Task 1.1），**默认值暂不动**（保持 20，避免在首次失败点未知时激进上调）——但拆分后新常量 `COMMIT_WINDOW_MAX_SEC` 可从 40 提到 **≥125s 已知安全下界**（Q1 已背书这个提升不误伤 CC）。
2. 补测 Q1 首次失败点（真 CC 130/150/180s 阶梯，离线 mock、零额度，`gpt-souls:poc-runner` 或直接复用 `exp/silence-recovery-gates/` 的 harness）。
3. 首次失败点出结果后，另开一个小任务（不需要重新走 TDD 大阶段）把默认值从 20 改到实测安全值，走 `bun run test:backend` 回归即可。

**待决设计点：commit 窗口的 clamp 上限是否该与 keepalive cadence 的 clamp 上限脱钩？**
- 现状：`clampKeepaliveCadence` 用同一个 `KEEPALIVE_CADENCE_MAX = CLIENT_IDLE_DEADLINE_SEC - 20 = 40`，同时限制 `stream_keepalive_ping_sec`（保活节奏）和 `stream_commit_after_sec`（commit 窗口）。
- 语义上二者的安全上限**不是同一个物理量**：keepalive cadence 的上限来自"客户端 body-idle 60s 死线"（commit **之后**才生效）；commit 窗口的上限来自"CC pre-header 容忍度"（**commit 之前**，可能是完全不同的 connect/read timeout，Q1 待测）。二者恰好现在都设成 40 纯属巧合（同一个保守默认），一旦 Q1 测出 pre-header 容忍度 ≠ 40，继续共用同一 clamp 就会算错。
- **推荐**：拆成两个独立 clamp（`clampKeepaliveCadence` 保持不变服务 `stream_keepalive_ping_sec`；新增 `clampCommitWindow` 服务 `stream_commit_after_sec`，上限常量待 Q1 填入），这是**局部签名/内部常量拆分**，不改外部配置 schema 字段名/类型，因此在 planner 权限内可直接设计；但**新上限的具体数值**必须来自 Q1 实测，不能我方臆造 —— 若 Q1 未跑先落地这个拆分，新常量先复用现有 40（等价行为），只是把"服务对象"在代码里显式分开，为后续填入不同数值铺路。

## TDD 步骤

### Task 1.1：拆分 commit 窗口的 clamp（现在，不改行为）

- [ ] **Step 1: 写失败测试** —— 断言 `stream_commit_after_sec` 和 `stream_keepalive_ping_sec` 现在各自有独立可寻址的 clamp 逻辑（哪怕数值当前相同）

```ts
// tests/config/buffered-retry-keys.unit.test.ts（追加）
test("commit-window clamp and keepalive-cadence clamp are independently addressable (same value today, different constants)", () => {
  // 断言两个配置项在越界时都被 clamp 到各自常量（当前值相同，但来源不同的常量）
  // 这条测试的意义是"锁住拆分后的两个独立入口"，不是锁数值本身
})
```

- [ ] **Step 2: 跑，失败**（因为目前只有一个共用函数，没有两个可分别断言来源的入口——如果测试写法上无法区分，改为白盒测试直接 import 两个新导出的常量/函数进行断言）。
- [ ] **Step 3: 接线** —— 在 `src/lib/config/config.ts` 拆出 `clampCommitWindowSec`（新函数，上限常量 `COMMIT_WINDOW_MAX_SEC`，初值等于现有 `KEEPALIVE_CADENCE_MAX` 以保持逐字节等价）与保留原 `clampKeepaliveCadence`（服务 `stream_keepalive_ping_sec`）；`stream_commit_after_sec` 的赋值点（`config.ts:660` 附近）改调 `clampCommitWindowSec`。
- [ ] **Step 4: 跑，通过。** 确认 `bun run test:fast` 全绿（这是纯重命名+拆分，不应有任何行为变化）。
- [ ] **Step 5: 提交** → `refactor(config): split commit-window clamp from keepalive-cadence clamp (same value, independent constants pending Q1)`。

### Task 1.2（门控，待 Q1 结果，可延后）：回填 Q1 实测的窗口上限

- [ ] **Step 1**：Q1 实测出 CC pre-header 容忍度 `T`秒后，把 `COMMIT_WINDOW_MAX_SEC` 从"复用 40"改为 Q1 实测值减安全边际（参照现有 `KEEPALIVE_CADENCE_MAX` 的"留 ≥20s margin"惯例）。
- [ ] **Step 2**：视 Q1 结果决定是否同时调整 `streamCommitAfterSec` 默认值（当前 20）——若 T 远大于 20，可考虑默认值上调；若 T 接近或小于 20，保持默认不变（20 已经接近安全上限）。**这是运维参数调整，不是必须与本阶段其余步骤同批提交**——可交由主会话在 Q1 结果出来后单独决策+提交。
- [ ] **Step 3**：跑 `bun run test:backend` 全绿；更新 `schema.ts` 里 `stream_commit_after_sec` 的 TSDoc（当前写"CC 真实 pre-header 容忍度"待补充为具体测得数值 + 出处）。
- [ ] **Step 4**：提交 → `fix(config): raise stream_commit_after_sec ceiling to measured CC pre-header tolerance (Q1)`。

## 验收 Oracle

- `bun run test:backend` 全绿（回归）。
- 白盒单测锁住"两个独立 clamp 常量存在"（Task 1.1）。
- Q1 实测报告（若已完成）附带具体数值 + 测量方法记录进 `exp/`（若 poc-runner 承担）或本 plan 文档尾部追加。

## 风险

- **低**：本阶段唯一风险是 Task 1.1 拆分时手滑改变了默认行为（比如两个常量数值不小心不一致）——用回归测试兜底。
- Task 1.2 是纯参数调整，风险来自"没等 Q1 就动手改默认值"——已在步骤里显式要求门控顺序。

## 未采纳方案

- **A3/A6（时间阈值判别 A/B）**：已在 spec §5.A 被否——不采纳作为 B1 的替代或补充。B1 只做"扩大原生保护区"，不做判别。
