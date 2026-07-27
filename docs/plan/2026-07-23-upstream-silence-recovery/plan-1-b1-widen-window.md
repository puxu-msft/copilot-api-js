# Plan-1: B1 —— 加宽 delayed-commit 窗口

> **⚠ 2026-07-27 更新：Q1 门已闭合，本文档下方多处「Q1 未测/待补测」的措辞已过时。** 实测首次失败点 = **300.0s**，且归属 undici 默认 `headersTimeout`（不是 CC、不是 SDK，两者自称的 1200s/1250s 都够不着它）；`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 抬到 600s 不移动该点。证据见 [`exp/silence-recovery-gates/FINDINGS.md`](../../../exp/silence-recovery-gates/FINDINGS.md) §「Q1 续测」。**对本 plan 的三条实质影响**：① Task 1.2 Step 1 把 ceiling 提到 125s **安全但保守了 175s**，可直接定在 300s 减余量；② Task 1.2 Step 2 的「补测 130/150/180s 阶梯」**不必做了**，首失败点已知；③ 默认值 `streamCommitAfterSec` 的取值现在是一个**有上界的取舍**（越大越多 B-Mode2 走原生保护、但 A 型挂起干等越久），不再被未知量卡住。**注意**：撞上 300s 不是致命——CC 会原生重试（实测连做 5 次、间隔 ~2s），代价是上游从头重算。

> **依赖：** 无（可与 B2-P0 并行）。**门控：** Q1 **已闭合 = 300.0s**（原文：「已实测下界 ≥125s、首次失败点未测、区间 `[125s, 未知)`」——下界正确，上界现已测得）。⚠ 事故 RST 最早 ~126s，**整段 126-206s 落在 300s 窗口内**，故把默认窗口抬过该区间即可让事故请求留在 pre-header 区拿真 HTTP 状态、走 CC 原生重试——这比原文「B1 单独不覆盖事故」更乐观，但仍以 B2 为主线（B1 不救 commit 之后才失败的形态）。

**Goal：** 把更多合法长思考（B-Mode2，header 到达 <当前默认 20s~新上限）与短挂起（在窗口内即失败的 A）拉回原生重试保护区——客户端拿到真实 HTTP 状态、CC 原生重试/backoff/token-refresh 继续生效，零合成脚手架。**不依赖任何 A/B 判别、不误伤 B**（spec §5.B-1 已定论）。

**为何低风险：** 纯改一个数值型配置的默认值 + clamp 上限，机制本身（`Promise.race([p, windowFired])`）完全不动，`handler-v4.ts:548-565` 零结构改动。

## 文件清单

- Modify: `src/lib/state-defaults.ts`（`streamCommitAfterSec` 默认值，当前 20）
- Modify: `src/lib/config/config.ts`（`clampKeepaliveCadence` 的上限常量 `KEEPALIVE_CADENCE_MAX`，当前 `60-20=40`；**注意**：这个 clamp 目前是 `stream_keepalive_ping_sec` / `stream_commit_after_sec` 共用的同一上限，B1 若要把 commit 窗口的上限与 keepalive cadence 的上限分开，需要拆分两个独立 clamp 函数/常量——这是本阶段的一个**待决设计点**，见下）
- Modify: `src/lib/config/schema.ts`（`stream_commit_after_sec` 的 TSDoc 说明，反映新默认值/上限来源）
- Test: `tests/config/buffered-retry-keys.unit.test.ts`（已有 clamp 测试，加新上限断言）
- Test: `tests/anthropic/stream-immediate-keepalive.http.test.ts` / 其余引用 `streamCommitAfterSec` 的既有测试（回归检查，不应破坏）

## 门控问题（不自行拍板，交主会话/用户）

**Q1 已实测下界 ≥125s（旧「50-55s」估计证伪），但首次失败点未测。** 为消除歧义，明确两步分工（consensus 复审第二轮指出原稿三处指令自相矛盾，此处一锤定音）：

1. **Task 1.1 = 纯字节等价重构**：只把 commit 窗口的 clamp 从 keepalive cadence 拆出成独立函数/常量，`COMMIT_WINDOW_MAX_SEC` **初值保持 40**（= 现 `KEEPALIVE_CADENCE_MAX`），**零行为变化**、回归锁死。**本 Task 不提 ceiling、不动默认值。**
2. **Task 1.2 = 提 ceiling（行为变化、独立提交）**：把 `COMMIT_WINDOW_MAX_SEC` 从 40 提到 **≥125s 已知安全下界**（Q1 已背书不误伤 CC；**注意这只放宽「允许配置的上限」、默认值仍 20 不变**，故对绝大多数用户零可观测变化）。**默认值 `streamCommitAfterSec` 20→更大** 则须等 Q1 首次失败点补测后再定（见下 Task 1.2 步骤），因为默认值直接影响所有请求、需实测安全边际。
3. **补测 Q1 首失败点**（真 CC 130/150/180s 阶梯，离线 mock 零额度，复用 `exp/silence-recovery-gates/` harness）→ 定最终默认值。

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

### Task 1.2（ceiling 可定为 300s 减余量；默认值仍是取舍，需用户拍板）：回填 Q1 实测

- [ ] **Step 1**：把 `COMMIT_WINDOW_MAX_SEC` 从「复用 40」提到 **Q1 实测上限 300s 减安全余量**（原稿写的 125s 是当时的已知下界，现已被 2026-07-27 实测取代——见本文档顶部更新）。这只放宽「允许配置的上限」、默认值不变。**不得**填成 300s 整：撞上就是整条请求被客户端放弃。
- [ ] **Step 2（Q1 已闭合，原「待补测阶梯」作废）**：`streamCommitAfterSec` 默认值（当前 20）是否上调，现在是一个**有上界的取舍**而非未知量——上界 300s 已测定，取舍轴是「窗口越大越多 B-Mode2 走原生保护、但 A 型挂起在窗口内干等越久」。事故 RST 的 126-206s **整段在窗口内**，故默认值抬过 206s 可让事故形态留在 pre-header 区。**这是运维参数取舍，摆量化选项交用户拍板，不由实施者自行决定。**
- [ ] **Step 3**：跑 `bun run test:backend` 全绿；更新 `schema.ts` 里 `stream_commit_after_sec` 的 TSDoc（补 Q1 实测 300s 上限 + 归属 undici `headersTimeout` + 出处 `exp/silence-recovery-gates/FINDINGS.md`）。
- [ ] **Step 4**：提交 → `fix(config): raise stream_commit_after_sec ceiling to the measured CC pre-header limit`。

## 验收 Oracle

- `bun run test:backend` 全绿（回归）。
- 白盒单测锁住"两个独立 clamp 常量存在"（Task 1.1）。
- Q1 实测报告（若已完成）附带具体数值 + 测量方法记录进 `exp/`（若 poc-runner 承担）或本 plan 文档尾部追加。

## 风险

- **低**：本阶段唯一风险是 Task 1.1 拆分时手滑改变了默认行为（比如两个常量数值不小心不一致）——用回归测试兜底。
- Task 1.2 是纯参数调整，风险来自"没等 Q1 就动手改默认值"——已在步骤里显式要求门控顺序。

## 未采纳方案

- **A3/A6（时间阈值判别 A/B）**：已在 spec §5.A 被否——不采纳作为 B1 的替代或补充。B1 只做"扩大原生保护区"，不做判别。
