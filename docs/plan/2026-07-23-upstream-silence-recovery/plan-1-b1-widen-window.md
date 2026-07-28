# Plan-1: B1 —— 加宽 delayed-commit 窗口

> **实施状态：Task 1.1 + 1.2 已实现（2026-07-28）。** clamp 拆分 + ceiling 240 + 默认 180 + commit 窗口改为 ingress-relative deadline。`COMMIT_WINDOW_MAX_SEC = 240`（实测 ~300s pre-header 上限减 60s 余量），`streamCommitAfterSec` 默认 20 → **180**（用户 2026-07-28 拍板）。B2/B3 仍未实施。

> **⚠ 2026-07-27 更新：Q1 门已闭合，本文档下方多处「Q1 未测/待补测」的措辞已就地改正（不只是加顶注）。** 实测 pre-header 容忍度 ≈ **300s**，直接触发器与 undici 默认 `headersTimeout` 一致——**不是** SDK 的 1200/1250s request timer，**也不是** CC 那个响应头后才武装的 stream-idle watchdog（抬 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 到 600s 不移动该点；裸 TCP socket 420.1s 未被关，排除我方服务端）。**作用域**：本机 CC 2.1.220 + 内置 Node v26.3.0 的 transport 默认，四个完整 attempt 落在 299.667–300.280s；**这是可配置、随版本变化的默认值，不是协议常量**。证据见 [`exp/silence-recovery-gates/FINDINGS.md`](../../../exp/silence-recovery-gates/FINDINGS.md) §「Q1 续测」。**对本 plan 的三条实质影响**：① Task 1.2 的 ceiling 可直接定在 ~300s 减余量（原稿的 125s 保守了 175s）；② 「补测 130/150/180s 阶梯」**作废**；③ 默认值 `streamCommitAfterSec` 的取值现在是一个**有上界的取舍**，不再被未知量卡住。**注意**：撞上 ~300s 不致命——CC 会原生重试（观测 4 个完整周期、backoff ≈0.55/1.05/2.16/4.06s，最大尝试数未测），代价是上游从头重算。**另注**：**不要**据此推「总预算 T+300s / ~600s 天花板」——commit 后那个 300s 是可重置的 idle watchdog，我方 `streamKeepaliveEscalateSec`（默认 200s）本就在主动重置它。

> **依赖：** 无（可与 B2-P0 并行）。**门控：** Q1 **已闭合 ≈ 300s**（原文：「已实测下界 ≥125s、首次失败点未测、区间 `[125s, 未知)`」——下界正确，上界现已测得）。⚠ 事故 RST 最早 ~126s，**整段 126-206s 落在 ~300s 的可配置空间内**，故抬高默认窗口能把事故请求的**一部分**拉回 pre-header 区拿真 HTTP 状态、走 CC 原生重试。**注意实际取值是 180**（用户 2026-07-28 拍板），故只覆盖 126-180s 段；**180-206s 段仍先 commit**，仍以 B2 为主线（B1 不救 commit 之后才失败的形态）。

**Goal：** 把更多合法长思考（B-Mode2，header 到达 <默认窗口；该默认 2026-07-28 由 20s 改为 180s）与短挂起（在窗口内即失败的 A）拉回原生重试保护区——客户端拿到真实 HTTP 状态、CC 原生重试/backoff/token-refresh 继续生效，零合成脚手架。**不依赖任何 A/B 判别、不误伤 B**（spec §5.B-1 已定论）。

**为何低风险：** 纯改一个数值型配置的默认值 + clamp 上限，机制本身（`Promise.race([p, windowFired])`）完全不动，`handler-v4.ts:548-565` 零结构改动。

## 文件清单

- Modify: `src/lib/state-defaults.ts`（`streamCommitAfterSec` 默认值，20 → **180**，done）
- Modify: `src/lib/config/config.ts`（`clampKeepaliveCadence` 的上限常量 `KEEPALIVE_CADENCE_MAX`，当前 `60-20=40`；**注意**：这个 clamp 目前是 `stream_keepalive_ping_sec` / `stream_commit_after_sec` 共用的同一上限，B1 若要把 commit 窗口的上限与 keepalive cadence 的上限分开，需要拆分两个独立 clamp 函数/常量——这是本阶段的一个**待决设计点**，见下）
- Modify: `src/lib/config/schema.ts`（`stream_commit_after_sec` 的 TSDoc 说明，反映新默认值/上限来源）
- Test: `tests/config/buffered-retry-keys.unit.test.ts`（已有 clamp 测试，加新上限断言）
- Test: `tests/anthropic/stream-immediate-keepalive.http.test.ts` / 其余引用 `streamCommitAfterSec` 的既有测试（回归检查，不应破坏）

## 门控问题（不自行拍板，交主会话/用户）

**Q1 已于 2026-07-27 实测闭合：pre-header 容忍度 ≈ 300s**（作用域与归因见本文档顶部更新与 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」）。原稿在此处写的「下界 ≥125s、首次失败点未测」已作废。三步分工现为：

1. **Task 1.1 = 纯字节等价重构**：只把 commit 窗口的 clamp 从 keepalive cadence 拆出成独立函数/常量，`COMMIT_WINDOW_MAX_SEC` **初值保持 40**（= 现 `KEEPALIVE_CADENCE_MAX`），**零行为变化**、回归锁死。**本 Task 不提 ceiling、不动默认值。**
2. **Task 1.2 = 提 ceiling（行为变化、独立提交）**：把 `COMMIT_WINDOW_MAX_SEC` 从 40 提到**实测 transport default（~300s）减安全余量**（**只放宽「允许配置的上限」、默认值仍 20 不变**，故对绝大多数用户零可观测变化）。**不得填 300 整**——撞上就是该 attempt 被 `headersTimeout` 中止。
3. ~~补测 Q1 首失败点（真 CC 130/150/180s 阶梯）~~ **已完成，此步作废**。剩下的是**默认值 `streamCommitAfterSec` 取多少**——这现在是个上界已知的取舍（见 Task 1.2 Step 2），**交用户拍板**。

**待决设计点：commit 窗口的 clamp 上限是否该与 keepalive cadence 的 clamp 上限脱钩？**
- 现状：`clampKeepaliveCadence` 用同一个 `KEEPALIVE_CADENCE_MAX = CLIENT_IDLE_DEADLINE_SEC - 20 = 40`，同时限制 `stream_keepalive_ping_sec`（保活节奏）和 `stream_commit_after_sec`（commit 窗口）。
- 语义上二者的安全上限**不是同一个物理量**：keepalive cadence 的上限来自"客户端 body-idle 死线"（commit **之后**才生效）；commit 窗口的上限来自 CC pre-header 容忍度（**commit 之前**，2026-07-27 实测 ≈300s，机制是 undici `headersTimeout`）。二者现在都设成 40 纯属巧合（同一个保守默认），**实测已确认这两个上限的真实值相差极大，继续共用同一 clamp 必然算错**。
- **推荐（实测已背书，不再是待填空）**：拆成两个独立 clamp（`clampKeepaliveCadence` 保持不变服务 `stream_keepalive_ping_sec`；新增 `clampCommitWindow` 服务 `stream_commit_after_sec`）。这是**局部签名/内部常量拆分**，不改外部配置 schema 字段名/类型。Task 1.1 先做等价拆分（新常量复用 40），Task 1.2 再填入实测值。

## TDD 步骤

### Task 1.1：拆分 commit 窗口的 clamp（现在，不改行为）

- [x] **Step 1: 写失败测试** —— 断言 `stream_commit_after_sec` 和 `stream_keepalive_ping_sec` 现在各自有独立可寻址的 clamp 逻辑（哪怕数值当前相同）

```ts
// tests/config/buffered-retry-keys.unit.test.ts（追加）
test("commit-window clamp and keepalive-cadence clamp are independently addressable (same value today, different constants)", () => {
  // 断言两个配置项在越界时都被 clamp 到各自常量（当前值相同，但来源不同的常量）
  // 这条测试的意义是"锁住拆分后的两个独立入口"，不是锁数值本身
})
```

- [x] **Step 2: 跑，失败**（因为目前只有一个共用函数，没有两个可分别断言来源的入口——如果测试写法上无法区分，改为白盒测试直接 import 两个新导出的常量/函数进行断言）。
- [x] **Step 3: 接线** —— 在 `src/lib/config/config.ts` 拆出 `clampCommitWindowSec`（新函数，上限常量 `COMMIT_WINDOW_MAX_SEC`，初值等于现有 `KEEPALIVE_CADENCE_MAX` 以保持逐字节等价）与保留原 `clampKeepaliveCadence`（服务 `stream_keepalive_ping_sec`）；`stream_commit_after_sec` 的赋值点（`config.ts:660` 附近）改调 `clampCommitWindowSec`。
- [x] **Step 4: 跑，通过。** 确认 `bun run test:fast` 全绿（这是纯重命名+拆分，不应有任何行为变化）。
- [x] **Step 5: 提交** → `refactor(config): split commit-window clamp from keepalive-cadence clamp (same value, independent constants pending Q1)`。

### Task 1.2（ceiling 可定为 300s 减余量；默认值仍是取舍，需用户拍板）：回填 Q1 实测

- [x] **Step 1（done 2026-07-28）**：`COMMIT_WINDOW_MAX_SEC` = **240**（实测 ~300s 减 60s 余量）。把 `COMMIT_WINDOW_MAX_SEC` 从「复用 40」提到 **实测 transport default（~300s）减安全余量**（原稿写的 125s 是当时的已知下界，现已被 2026-07-27 实测取代——见本文档顶部更新）。这只放宽「允许配置的上限」、默认值不变。**不得**填成 300 整：撞上就是该 attempt 被 `headersTimeout` 中止。
- [x] **Step 2（done 2026-07-28，用户拍板 180s）**：`streamCommitAfterSec` 默认 20 → **180**（`state-defaults.ts` + `config.yaml` 同步）。`streamCommitAfterSec` 默认值（当时 20）是否上调，现在是一个**有上界的取舍**而非未知量——上界 ~300s 已测定，取舍轴是「窗口越大越多 B-Mode2 走原生保护、但 A 型挂起在窗口内干等越久」。事故 RST 的 126-206s **整段在窗口内**，故默认值抬过 206s 可让事故形态留在 pre-header 区。**这是运维参数取舍，摆量化选项交用户拍板，不由实施者自行决定。**
- [x] **Step 3（done，验收 gate 有保留）**：`bun scripts/parallel-test.ts unit it http` = 6484 pass / 14 fail，14 条全是 history-search sidecar（**归因订正 2026-07-28**：当时以为是 rustup 无默认 toolchain，实际是**我在新建 worktree 里跑测试、而 `native/history-search/*.node` 是 gitignored 产物、worktree 里没有**；在主树同一提交跑是全绿）。**再订正**：当时写的「6506 pass」是**主树工作区**的计数（含并发会话未提交的测试），不是该 commit 的可复现基线——在 clean detached `1b8bdf2f` 上是 6485 pass / 0 fail。计数要归给 commit 就必须在干净检出上跑。；`typecheck` 干净；改动文件 `eslint` 干净。**`bun run test:backend` 本身未能执行**（它先跑 `build:history-search`，同一 rustup 原因即失败），故该 gate **未通过、也未失败——是未执行**。TSDoc 三处（`schema.ts` / `state.ts` / `config.yaml`）+ `DESIGN.md` 状态表已同步。原文「跑 `bun run test:backend` 全绿」更新 `schema.ts` 里 `stream_commit_after_sec` 的 TSDoc（补 Q1 实测 300s 上限 + 归属 undici `headersTimeout` + 出处 `exp/silence-recovery-gates/FINDINGS.md`）。
- [x] **Step 4（done）**：提交 → `fix(config): raise stream_commit_after_sec ceiling to the measured CC pre-header limit`。

## 验收 Oracle

- `bun run test:backend` 全绿（回归）。
- 白盒单测锁住"两个独立 clamp 常量存在"（Task 1.1）。
- Q1 实测报告（若已完成）附带具体数值 + 测量方法记录进 `exp/`（若 poc-runner 承担）或本 plan 文档尾部追加。

## 风险

- **低**：本阶段唯一风险是 Task 1.1 拆分时手滑改变了默认行为（比如两个常量数值不小心不一致）——用回归测试兜底。
- Task 1.2 是纯参数调整，风险来自"没等 Q1 就动手改默认值"——已在步骤里显式要求门控顺序。

## 未采纳方案

- **A3/A6（时间阈值判别 A/B）**：已在 spec §5.A 被否——不采纳作为 B1 的替代或补充。B1 只做"扩大原生保护区"，不做判别。
