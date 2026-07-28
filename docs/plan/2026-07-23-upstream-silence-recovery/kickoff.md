# Kickoff: 上游静默与 delayed-commit 恢复（B1/B2/B3）实施

复制以下内容开新会话启动实施。

---

## ⚠ 当前状态（2026-07-28，先读这一节，别按下面的原始顺序从头开工）

**实施已进行到 Task 0.5 完成，下一个是 Task 0.6。** 权威状态见 [`docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md`](../2026-07-23-handover-h2-pool-and-silence-spec.md) **§0.2**（实施真相源），进度 ledger 在 `.worktrees/upstream-silence-recovery/.superpowers/sdd/progress.md`。

- **工作区**：隔离 worktree `.worktrees/upstream-silence-recovery` @ 分支 `feat/upstream-silence-recovery`（**未合回 master**；node_modules 已软链）。
- **已完成**：B2-P0（配置骨架 + telemetry）、Task 0.2（delivery-level semantic-content gate）、Task 0.3（`coordinator.runRecoveryFromPreReadyFailure`）、Task 0.4（`driver.runPreContentRecovery` + server-tool gate）、Task 0.5（recovery sink lifetime supervisor）。**全部未接线**（P4/P5 才接），每个都过了异模型 review。
- **B1 已被主线 supersede、不用再做**：master 自己落地了 B1 并改进（commit 窗口默认 **180**、ceiling **240**、窗口重构成 ingress-relative deadline）。原因是 **Q1 首失败点已实测闭合（≈300s，触发器 = undici 默认 `headersTimeout`）**——下方「Q1 未实测」的原始表述**作废**。
- **底座已漂移，接线前必重读现状**：master 在本分支开工后前进 128 提交，**重写了 delivery/heartbeat 生命周期**（`freezeHeartbeat` 语义、close-before-terminal-drain）。**plan-3 的 `file:line` 与 handler/driver 接线点假设多半已过时**——以当前代码为准，plan 文本与现状冲突时**信代码**并在报告里写清差异（Task 0.5 已按此处理，见 §0.2）。本分支已合并 master（`e951026a`）。
- **用户已裁决的分叉**（不要再问）：① 配置键 `precontent_recovery` 沿用；② **B2 排除 `timeout(header-wait)`/`reaper-cancel`**——用户硬约束「**绝不误杀合法长思考**」，只在确定性上游死亡（RST/transport-close/clean-EOF）才 fresh dispatch；③ buffered 尊重 `max_retries=0`；④ B3 计时器独立，且 **B3 wall-clock fail-fast 默认关闭**（同一硬约束）。见 README「用户裁决记录」。
- **验证命令**：`bun run test:backend`（其汇总恒报 `0 tests` 的缺陷已于 master `5454616b` 修复）。**已知既有 flaky**：History V3 capture-performance 家族等 perf/时序测试在负载下会挂（master 同样会）——判回归以「单跑是否通过 + 是否属该家族」为准，别当自己的回归。

**下一步 = Task 0.6**（seal-race crash 安全：守卫**整个** `recordOpened`，headers + timing 都要，不是只 timing），然后 P4~P6（最硬）→ B3 → 终审 → ff 合 master。

---

你要实施「上游静默与 delayed-commit 恢复」特性（三层防线 B1/B2/B3）。**先读**（按序）：

1. 权威 spec：`docs/spec/2026-07-23-upstream-silence-commit-timing.md`（什么/为何，已定稿，Q5 已实测闭合）。
2. PoC 裁决：`exp/silence-recovery-b2-vs-b5/FINDINGS.md`（B2 主线 + 三 keepalive 模式 wire contract 实测表 —— **这是本计划所有 wire-level 判断的实测依据，别脱离它猜测协议行为**）；Q1/Q2 门见 `exp/silence-recovery-gates/FINDINGS.md`（Q1 已闭合 ≈300s；Q2 未定论）。
3. 计划总览：`docs/plan/2026-07-23-upstream-silence-recovery/README.md`（阶段 DAG + 冻结契约 + 用户裁决记录）。
4. 各阶段文档（按 DAG 顺序）：`plan-1-b1-widen-window.md`（**已由主线完成**） → `plan-2-b2-p0-p3-foundation.md` → `plan-3-b2-p4-p6-splice-and-matrix.md` → `plan-4-b3-failfast.md` → `plan-5-closeout.md`。

**执行顺序（当前实际；原始 gate-first 顺序见括注）：**
1. ~~B1（plan-1）~~ **已由主线完成**；B2-P0~P3（plan-2）中 Task 0.1/0.2/0.3/0.4/0.5/0.7 **已完成**，**剩 Task 0.6**（seal-race crash 安全）。
2. B2-P4~P6（plan-3）在 plan-2 全部完成后开始——依赖已产出的 `coordinator.runRecoveryFromPreReadyFailure`、`hasDeliveredSemanticContent`、`recovery-sink-supervisor` 三件机件（**都已就位**）。⚠ 接线前重读 handler-v4/driver 现状（底座已漂移）。
3. B3（plan-4）在 plan-3 完成后开始——复用 plan-3 的判据组合；**默认关闭**（never-false-kill 硬约束）。
4. plan-5（收口）在前四者都通过全后端测试后执行。

**关键待决项（已全部裁决，别再问）：**
- ~~Q1（CC pre-header 容忍度）未实测~~ → **已闭合 ≈300s**（undici 默认 `headersTimeout`），B1 已按此落地（默认 180 / ceiling 240）。
- 配置键 `precontent_recovery` **沿用**；**B2 排除 `reaper-cancel`/`timeout(header-wait)`**（用户硬约束 never-false-kill：对可能仍在合法思考的活连接重发 = 误杀）。
- B3 与 `responseHeaderTimeout` **独立计时器**，且 B3 wall-clock fail-fast **默认关闭**（合法思考无上界，任何有限计时器都可能误杀）。
- 仍开放的只有实现层细节（如 gate 返回形状抛错 vs result variant），按 TDD 观察调用方需求再定。

**承重纪律（务必守）：**
- **B2 绝不是 continuation-retry 的小变体** —— `runRequest` 的 pre-ready 失败没有 `CoordinatedCandidate` 可用，`runContinuation`/`runRecovery` 都要求已 ready 的 parent。见 plan-2 开头的代码实证。
- **B2 有两个挂载点，不是一个** —— ① pre-ready（`runRequest` 从未 ready，需新建 `coordinator.runRecoveryFromPreReadyFailure`）；② ready-态（live pump 的 `stream-error` / buffered 的 `exhausted`，可复用既有 `coordinator.runRecovery`，但目前 live 路径从未调用过它——这是 plan-3 Task 4.0 才发现的第二个同等复杂度的新拓扑点，别只做①就以为 B2 完工）。
- **server-tool 双执行 gate 是硬性安全要求**，B2 fresh dispatch 前必须调 `classifyServerExecutionRisk`（`hedge-policy.ts:153`），且**禁止**用 `allowServerTools:true` 绕过；两个挂载点必须**各自独立**调用这个 gate，不能假设一处检查过了另一处就可以省略。
- **三 keepalive 模式的 wire contract 必须分支处理**，实现优先复用 `reconcileLiveFrame`（`live-reconcile.ts`）的既有判定逻辑，不要重新发明一套平行逻辑——plan-3 Task 4.1 已给出复用路径与验证清单。
- **sink 生命周期是最高风险点**（plan-3 Task 4.0/4.3 均涉及）——首次失败路径不得提前 `finalize`/`close` sink，用 plan-2 Task 0.5 的 `recovery-sink-supervisor` 统一收口。这段接线完成后**强烈建议**派 `reviewer`（异模型对抗审查）专门复核。
- TDD 逐 Task：先写失败测试 → 跑红 → 接线 → 跑绿 → 提交（conventional commits，显式 pathspec，无模型署名）。
- 红-绿 mutation 预测可能不咬，执行期真跑验证（各阶段文档已在关键节点标注）。
- **绝不碰 4141 用户主服务器**；测试/PoC 起非-4141 端口、按 PID 精确清理。不跑 `bun run start/dev`；`typecheck`/`lint:all`/`bun test`/`test:backend` 照常。

**主目标验收：** 事故形态（req_57/58/63：commit 后上游 0 帧干挂 100+ 秒、rstCode=0）在 B2 落地后，若失败是瞬态的，客户端应透明收到完整响应（无感知内部曾经历一次上游失败重试）；若失败是系统性的，最坏也应在 B3 的上限内拿到一个清晰的、可行动的错误，而非等待 100+ 秒硬失败。

**收尾（session-closeout，见 plan-5）：** subagent 对抗审查（尤其 sink 生命周期 + coordinator 新方法）→ doc-sync（DESIGN.md/spec 状态/可能的新 ADR）→ backlog 登记（plan-5 已列 6 项，不要静默丢弃）→ 归档 plan 头部状态注解 → 细粒度提交。
