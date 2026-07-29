# 上游静默与 delayed-commit 恢复 —— 实施计划总览（README）

> **For agentic workers:** 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施，`- [ ]` 复选框跟踪进度。
>
> **权威 spec：** [`docs/spec/2026-07-23-upstream-silence-commit-timing.md`](../../spec/2026-07-23-upstream-silence-commit-timing.md)（已定稿，Q5、Q1 均已实测闭合）。**权威 PoC 裁决：** [`exp/silence-recovery-b2-vs-b5/FINDINGS.md`](../../../exp/silence-recovery-b2-vs-b5/FINDINGS.md)（B2 主线、wire contract 实测表）+ [`exp/silence-recovery-gates/FINDINGS.md`](../../../exp/silence-recovery-gates/FINDINGS.md)（**Q1 已闭合 ≈300s**（2026-07-27）/ Q2 未定论）。冲突以 spec + FINDINGS 为准，本计划只回答"怎么做"。

> **审查状态（2026-07-23）：** 跨模型审查**两轮**已完成——`planner`（Claude）撰写 + `gpt-souls:reviewer`（GPT，异模型对抗）审。**第一轮**发现并整合：1 CRITICAL（semantic-content gate 原用 `boundary.result` 只在 `content_block_stop` 翻转、会漏「delta 已发 stop 未到」窗口致重复内容 → 改为 delivery-level 复用 `isClientContentFrame`，plan-2 Task 0.2）；1 HIGH（MED-2 seal 后晚到 open 的 crash race → 加 plan-2 Task 0.6）；Q1 冲突（→ 更新 ≥125s 实测下界）。**第二轮 consensus** 再收紧三处：① semantic gate flag 明确 delivery-scoped 只数非-synthetic + 补集成测试（Task 0.2）；② seal-race 修法从「只丢 timing」扩为「守卫整个 `recordOpened`」+ 全路径回归（Task 0.6，主会话 code-read 核实唯一真抛点是 timing 写、headers 写今天不抛，整 method guard 为防未来+更稳健）；③ plan-1 Task 1.1/1.2 clamp 指令自相矛盾 → 明确 Task 1.1 保持 40 字节等价、Task 1.2 提 ceiling 到 125s。承重 Task 4.0（B2 两挂载点）经主会话独立 code-read 复核 = 真。**第二轮 sign-off 已达成 consensus（reviewer：「consensus，可实施」）。** **残留待用户裁决的真分叉见文末 + 各 plan 门控项。**

**Goal：** 消解「commit 后失去内部恢复能力」这一架构缺陷 —— 三层防线：① **B1** 加宽 delayed-commit 窗口（让更多合法长思考 / 短挂起留在原生重试保护区）；② **B2【主线】** post-commit pre-semantic-content 内部重试（commit 后、真实内容抵达客户端前的上游失败 → 发起一次全新上游 dispatch，成功则把真实内容缝进同一条已提交的客户端流，A/B 判别伪命题因此消解）；③ **B3** pre-content 有界等待 + fail-fast 成客户端可行动错误（B2 内部重试耗尽/系统性挂起时的最终逃生舱，高上限、零误伤已知合法长思考）。

**判据轴（务必按此，非默认 ROI/YAGNI）：** 长远正确 + 完整 + 不误伤合法长思考。B2 的触发条件永远不能靠"猜测 A/B"，只能靠"客户端是否已收到真实语义内容"这一观测得到的、不需要判别的信号。

**Tech Stack：** TypeScript / Bun。测试 = `bun run test:fast`（单元+http 快速档，日常）/ `bun run test:backend`（交付前全后端，unit+it+http）；client-proxy e2e 用真实 `@anthropic-ai/sdk` 当 oracle（`tests/e2e-client/`）；PoC 已在 `exp/silence-recovery-b2-vs-b5/` 完成，本计划不再重跑 PoC，直接进 TDD 实现。

---

## Global Constraints（每阶段隐含包含，逐字来自 spec/CLAUDE.md）

- **🔴 never-false-kill-legit-thinking（用户 2026-07-23 定，硬约束 `[hard]`，凌驾其他取舍）**：**绝不误杀合法长思考。** 合法 heavy-thinking（deferred-header）时长**无上界**（Q5 实测 header 到达 47-231s、原则上更长），且在 20s commit 时刻与真挂起 **信号同形不可区分**（spec §3 实测）。推论：**① B2 只在上游确定性死亡时重发**（RST/transport-close/clean-EOF——此时连接已死、重发不放弃任何在进行的思考）；**绝不**对 `timeout(header-wait)`/`reaper-cancel` 重发（连接可能仍活、上游可能在合法思考，re-dispatch 会从头重算 = 误杀）。**② 任何 wall-clock 计时器都不得在「连接仍活、上游可能在思考」时终止请求**——挂起请求本就会被 GHC 网关自己在 126-206s `rstCode=0`（确定性失败）终止、届时 B2 救援即可；故不需要、也不允许用计时器去猜 A/B。这**收紧了早前 Q6 的「300s 逃生舱」**：B3 fail-fast 默认不得捕获可能的合法思考（见 plan-4 修订）。
- **无向后兼容负担**：`streamCommitAfterSec` 默认值改动、B2/B3 新配置键，允许一次性迁移、不留双轨包袱。
- **server-tool 双执行 gate 硬性复用**：B2 fresh dispatch 前必调 `classifyServerExecutionRisk`（`src/lib/pipeline/generation/hedge-policy.ts:153`），触发条件 = 「未向客户端交付真实语义内容 **且** `classifyServerExecutionRisk(finalWire).kind === "none"`」。**禁止**用 `allowServerTools:true` 绕过（那是 hedge 的宽松开关，B2 是默认行为，安全等级不同）。
- **三 keepalive 模式 wire contract 必须分支处理**（实测表见 FINDINGS.md）：`ping`（默认）无需 remap；`enveloped_ping` 只需 dedup message_start；`empty_text` 才需 close-anchor + index remap。**anchor remap 不是 B2 的通用前提**。
- **richest-data-flow**：合成的 fresh-retry attempt 必须完整落 History（新 attempt、`upstreamRequest`/`upstreamResponse` 忠实字节、外层 verdict 忠实反映"内部救援已发生"）。
- **persistence-async-invariants**：一切 settle 点必须在真实结算时机记录（不得靠事后补丁重建）；`onAttemptReset` 语义与既有 continuation/buffered-retry 一致 —— 不清累积状态、只清 per-attempt 临时态。
- **not-a-continuation-variant**：B2 是新拓扑（pre-ready failure、无 `CoordinatedCandidate`），不得包装成 `runContinuation`（那要求 `committedAny===true` + 已有 ready parent，见 `coordinator.ts:143-153`）。
- **protect-user-main-server**：测试/PoC 绝不碰 4141；新测试服务器起在非 4141 端口、按 PID 精确清理。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -- <精确路径>`），conventional commits，无模型署名。

## 阶段 DAG

```
B1 加宽 commit 窗口（低风险、独立、可先落地）
   │（与 B2 并行开发，无依赖）
   ▼
B2-P0 机制地基（server-tool gate 复用点 + 配置骨架 + outcome 分类 + telemetry 计数器，纯新增）
   ▼
B2-P1 pre-ready failure ownership（driver 持有 pending primary，pre-header 失败可追踪为「已知的失败 parent」）
   ▼
B2-P2 统一 semantic-content gate（覆盖 pre-ready + ready-but-pre-content 两态；live/buffered 两路径共用同一判据）
   ▼
B2-P3 sink lifetime supervisor（首失败路径不 close 真实 sink；recovery supervisor 统一收口）
   ▼
B2-P4 两个挂载点的 fresh-dispatch/recovery 执行器：
     ① pre-ready 挂载点（runRequest 从未 ready）—— 新建 coordinator.runRecoveryFromPreReadyFailure
     ② ready-态挂载点（live pump stream-error / buffered exhausted）—— 复用既有 coordinator.runRecovery
   + 三模式 wire contract splice（两挂载点共用同一拼接函数）+ server-tool gate + History settlement
   ▼
B2-P5 handler-v4.ts 接线（① COMMIT 分支外层 catch；② pumpAnthropicStreamingV4 的 stream-error 分支；③ driver.ts 的 buffered exhausted 分支）
   ▼
B2-P6 协议级回归矩阵（三模式 × {primary failure/recovery failure/abort/header-timeout/budget exhaustion} × 两挂载点）
   ▼
B3 pre-content fail-fast 逃生舱（依赖 B2 的 gate/budget 基础设施，复用其"未交付语义内容"判据）
   ▼
收口：doc-sync + telemetry 面板 + backlog 复核
```

**⚠ 承重发现（写 plan 过程中实证得出，非 spec 原文，务必带进实施）：** B2 不是单一挂载点——`runRequest` 的 pre-ready 失败（没有 `CoordinatedCandidate`）与 pump 的 ready-态 pre-content 失败（已有 ready 候选，只是响应流失败）是代码里两条完全不同的落点，前者需要新建 `coordinator.runRecoveryFromPreReadyFailure`，后者可直接复用既有 `coordinator.runRecovery`（目前只在 buffered 驱动循环里调用，live 路径的 `pumpAnthropicStreamingV4` 遇到 `stream-error` 目前直接终态失败、从未重试）。**两处都要覆盖才能完整救回原始事故形态**——详见 Plan-3 开头的代码实证与 Task 4.0。

B1 与 B2-P0 可并行启动（无共享文件）；B2-P1→P6 必须串行（每阶段依赖前一阶段的类型/接口）；B3 依赖 B2 的 gate 基础设施，必须在 B2-P4 落地后才能开工（复用同一 `classifyServerExecutionRisk` 调用点 + 同一"未交付语义内容"判据），但 B3 的 fail-fast 计时器本身与 B2 的 splice 逻辑正交，可另起一个阶段独立验收。

## 冻结契约（单一事实源，跨任务引用）

| 符号 | 类型/签名（草案，供落地参考——不改公共 API/跨模块协议，细化已接受的架构合同） | 归属阶段 |
|---|---|---|
| `PreReadyFailureHandle` | driver 内部持有的「commit 后、ready 之前失败」的可追踪句柄（非 `CandidateHandle`——见 B2-P1 的门控问题） | B2-P1 |
| `SemanticContentGate` | `hasDeliveredSemanticContent(session): boolean`——统一判据，pre-ready 恒 false；ready 态读 **delivery-level 信号** `hasEmittedRealClientContent`（首个非-synthetic `isClientContentFrame`／Anthropic `content_block_delta` 写出时不可逆翻转，复用 `request-timing.ts:137`），**非** `boundary.result`（那只在 `content_block_stop` 翻转、会漏「delta 已发 stop 未到」窗口致重复内容——对抗审 CRITICAL）；live/buffered 共用同一 delivery 信号 | B2-P2 |
| `RecoverySinkSupervisor` | 持有 sink 的最终 `close()`/`finalize()` 时机；splice 执行器与首次失败路径都不得直接调用 | B2-P3 |
| `coordinator.runRecoveryFromPreReadyFailure(reason, env)` | 新方法，服务 pre-ready 挂载点（无 parent 候选） | B2-P4 |
| `driver.runPreContentRecovery(reason)` | 新方法，驱动上者，配合 driver 闭包记的 pending primary 失败状态 | B2-P4 |
| `driver.runResponseRecovery(upstream, env, reason)` | 新方法，服务 ready-态挂载点，内部复用既有 `coordinator.runRecovery`（需给后者加一个可选 `retryNextStrategy` 覆盖参数，避免 History 标记与既有 buffered-retry 混淆） | B2-P4 |
| 持久 `makeReconcilingSink(inner, anchorState, anchorHooks)` | 按当前 wire state 复用 `reconcileLiveFrame` 既有判定；在 handler 一次构造并跨首次 attempt 与 fresh attempt 复用，透明保留 delivery identity 与全部可选 sink 控制方法 | B2-P4 |
| `precontent-recovery` verdict | History `attempts[]` 新增语义：首个 pre-content 失败 attempt 标记 `discarded`/`failed`（reason=`precontent-recovery`），fresh attempt 是新 attempt 且 winner | B2-P4/P6 |
| B3 fail-fast 上限 | 配置键（命名待定，暂拟 `stream_precontent_failfast_sec`），**默认 0=禁用**（never-false-kill 硬约束：wall-clock 不得捕获合法思考；挂起靠 GHC 确定性 RST + B2 救援）；运维可显式设一个上限 | B3 |

## 待填参数 / 待用户裁决（不自行拍板，见文末回报）

- **Q1（B1 窗口上限）已闭合**（2026-07-27 续测，`exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」）：CC pre-header 容忍度 **≈300s**，四个完整 attempt 落在 299.667–300.280s；直接触发器与 undici 默认 `headersTimeout` 一致——**不是** SDK 的 1200/1250s request timer、**也不是** CC 响应头后才武装的 stream-idle watchdog（裸 TCP socket 打同一 handler 420.1s 未被关，排除我方服务端）。**作用域 = 本机 CC 2.1.220 + 内置 Node v26.3.0 的 transport 默认，可配置、随版本变化，不是协议常量。** 原稿的「下界 ≥125s / 首失败点未测 / 待补测 130/150/180s 阶梯」**已作废**。⚠ 事故 RST 的 126-206s **整段落在 ~300s 窗口内**，故 B1 抬默认窗口即可让事故形态留在 pre-header 区拿真 HTTP 状态——比原判断乐观，但 B2 仍是主线（B1 不救 commit 之后才失败的形态）。⚠ **不得**由此推「总预算 T+300s / ~600s 天花板」：commit 后那个 300s 是可重置的 idle watchdog，我方 `streamKeepaliveEscalateSec`（默认 200s）本就在主动重置它。剩下的是**默认值取多少**——上界已知的取舍，交用户拍板。
- **Q2（B2 根治 vs 退化 B3 判断）**：事故类大 context 请求在 fresh retry 下能否成功——**已实测但未能定论**（`gpt-souls:poc-runner`，2026-07-23）：4 次 270KB 真 GHC 请求全成功、未复现 0 帧干挂，弱推断「事故间歇/瞬态而非大 context 系统性必挂」。这不影响 B2 的架构是否该做（架构缺陷本身独立成立），但影响运维预期（B2 只在"瞬态失败"下生效）。**B2「根治事故」仍标待验证**——上线后须补埋点记录 pre-ready failure 的 fresh-retry 成功率（见 plan-5 backlog）。
- **Q6（B3 fail-fast 上限取值）—— 已被 never-false-kill 硬约束收紧（用户 2026-07-23）**：早前选「高上限 ~300s 逃生舱」，但用户随后定下「**绝不误杀合法长思考**」硬约束——合法思考无上界，任何 wall-clock fail-fast 都可能捕获它。故 **B3 wall-clock fail-fast 默认关闭/不捕获可能的合法思考**，改为依赖「GHC 自身在 126-206s 的确定性 RST + B2 救援」处理挂起请求（见 Global Constraints never-false-kill + plan-4 修订）。配置键保留、允许运维显式开启一个上限，但默认不误杀。

## 用户裁决记录（2026-07-23）

- **fork ①（B2 配置键命名）** → 采默认 `precontent_recovery`（占位，实施可改一处）。
- **fork ②（B2 是否纳入 `timeout(header-wait)`/`reaper-cancel`）** → **排除**（用户硬约束 never-false-kill：对可能仍在合法思考的连接重发 = 误杀）。B2 只在确定性上游死亡（RST/transport-close/clean-EOF）触发。见 Global Constraints + plan-3 Task 4.3。
- **fork ③（buffered 路径是否尊重 `max_retries=0`）** → 尊重（推荐默认）；buffered B2 集成若复杂可降级 backlog 只做 live。
- **fork ④（B3 计时器 vs `responseHeaderTimeout` 独立）** → 独立（关注点分层）；但 B3 计时器本身受 never-false-kill 收紧（默认不捕获合法思考）。
- **Q6（B3 上限）** → 见上，被 never-false-kill 收紧。
- **实施授权** → 用户已授权继续（B1 + B2-P0 起，走 subagent-driven-development）。

---

详见各阶段文档：
- [plan-1-b1-widen-window.md](plan-1-b1-widen-window.md)
- [plan-2-b2-p0-p3-foundation.md](plan-2-b2-p0-p3-foundation.md)
- [plan-3-b2-p4-p6-splice-and-matrix.md](plan-3-b2-p4-p6-splice-and-matrix.md)
- [plan-4-b3-failfast.md](plan-4-b3-failfast.md)
- [plan-5-closeout.md](plan-5-closeout.md)
- [kickoff.md](kickoff.md)（复制到新会话）
