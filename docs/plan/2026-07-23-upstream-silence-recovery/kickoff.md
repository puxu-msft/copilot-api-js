# Kickoff: 上游静默与 delayed-commit 恢复（B1/B2/B3）实施

复制以下内容开新会话启动实施。

---

你要实施「上游静默与 delayed-commit 恢复」特性（三层防线 B1/B2/B3）。**先读**（按序）：

1. 权威 spec：`docs/spec/2026-07-23-upstream-silence-commit-timing.md`（什么/为何，已定稿，Q5 已实测闭合）。
2. PoC 裁决：`exp/silence-recovery-b2-vs-b5/FINDINGS.md`（B2 主线 + 三 keepalive 模式 wire contract 实测表 —— **这是本计划所有 wire-level 判断的实测依据，别脱离它猜测协议行为**）。
3. 计划总览：`docs/plan/2026-07-23-upstream-silence-recovery/README.md`（阶段 DAG + 冻结契约 + 待决项）。
4. 各阶段文档（按 DAG 顺序）：`plan-1-b1-widen-window.md` → `plan-2-b2-p0-p3-foundation.md` → `plan-3-b2-p4-p6-splice-and-matrix.md` → `plan-4-b3-failfast.md` → `plan-5-closeout.md`。

**执行顺序（gate-first，除非另行安排并行）：**
1. B1（plan-1）与 B2-P0~P3（plan-2）可并行开工（无共享文件、无依赖）。
2. B2-P4~P6（plan-3）必须在 plan-2 全部完成后才开始——它依赖 plan-2 产出的 `coordinator.runRecoveryFromPreReadyFailure`、`hasDeliveredSemanticContent`、`recovery-sink-supervisor` 三件机件。
3. B3（plan-4）必须在 plan-3 完成后才开始——复用 plan-3 的判据组合。
4. plan-5（收口）在前四者都通过 `bun run test:backend` 后执行。

**关键待决项（不要自行拍板，遇到时向主会话/用户确认，见各阶段文档的"门控问题"小节）：**
- Q1（CC pre-header 容忍度）未实测——B1 的窗口上限具体数值待填，先落地参数化骨架。
- B2 的配置键命名（`precontent_recovery` 是占位名）与"是否纳入 reaper-cancel/timeout 触发 B2"的范围边界——plan-3 Task 4.3 已列出两种倾向，需要在实现前与主会话对齐。
- B3 与 `responseHeaderTimeout` 是否需要合并成一个计时器——plan-4 已给出倾向独立的理由，但若实测发现竞态冲突需要回来讨论。

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
