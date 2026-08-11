# 上游静默恢复实施进度 ledger（历史归档）

> **状态：已失效，归档于 2026-08-08。** 本文是已删除 worktree `.worktrees/upstream-silence-recovery` 中未提交的 `.superpowers/sdd/progress.md` 快照。它停在 Task 4.1 前，不能作为待办或当前状态执行。当前架构以 `docs/DESIGN.md` 为准，最终实现与验证以 `docs/plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md` 为准，deferred 边界以 `docs/todo/deferred-backlog.md` 为准。
>
> **它没有证明什么：** 本快照只保留旧执行过程和当时的局部测试记录；不证明最终 master 的实现形状、评审状态或测试结果。最终本地集成基线为 `master@e45536af`，后续 closeout 记忆提交为 `3fea11bb`。

# 上游静默恢复 —— 实施进度 ledger

分支 feat/upstream-silence-recovery（worktree .worktrees/upstream-silence-recovery）。base = 5874ea78（含全部 plan 提交）。
权威 plan = docs/plan/2026-07-23-upstream-silence-recovery/。硬约束：never-false-kill-legit-thinking。
（注：本 ledger 曾于 20:08 被并发 retry-registry 内容污染、已从 git+handover 重建；权威进度以 git 分支提交 + 主树 handover §0.2 为准。）

## 阶段（依赖序）
- [x] B1（plan-1）：拆 clamp + ceiling→125s + 独立告警标志 —— DONE
- [x] B2 Task 0.1：配置骨架 precontent_recovery —— DONE
- [x] B2 Task 0.7：telemetry 计数器骨架 —— DONE
- [x] B2 Task 0.2：delivery-level semantic-content gate（CRITICAL 修法·复用既有 onFirstRealContent seam）—— DONE
- [x] B2 Task 0.3：coordinator.runRecoveryFromPreReadyFailure（镜像 runHedge·不 settle parent）—— DONE
- [x] B2 Task 0.4：driver.runPreContentRecovery + pre-ready ownership + server-tool gate —— DONE
- [x] B2 Task 0.5：recovery sink lifetime supervisor —— DONE
- [x] B2 Task 0.6：seal-race crash 安全（①守卫整个 recordOpened+三 setter 对齐 —— DONE；②quiescence join 授权延后 P4/P5）
- [~] B2-P4~P6（plan-3）：Task 4.0 ready-态挂载点 DONE；下一个 = Task 4.1 splice 纯函数 → 4.2 gate → 4.3 handler 接线（最硬）→ 4.4 History → 4.5 协议矩阵
- [ ] B3（plan-4）：fail-fast 逃生舱（默认关，never-false-kill）
- [ ] 全分支终审 + ff 合 master

## 完成记录
Task B1: complete (commits 5874ea78..31ba4a60, review clean — spec ✅ / quality Approved / 1 Important fixed w/ TDD regression / test:backend 6346 pass)
Task B2-P0 (0.1+0.7): complete (commits 31ba4a60..31c503f4, review clean — spec ✅ / quality Approved / 0 blocker / zero-behavior-change verified via full-repo grep + regression / test:backend 6351 pass)
Task B2-0.2: complete (commit a819834f, review clean — spec ✅ / quality Approved / 0 blocker / CRITICAL fix verified by main-session + reviewer: gate reads hasEmittedRealClientContent not boundary.result, flip reuses existing isClientContentFrame-driven onFirstRealContent seam, synthetic frames don't flip, CRITICAL regression real / test:backend 6359 pass)
Task B2-0.3: complete (commit eff92dc0, review clean — spec ✅ / Approved / 0 blocker / no-parent-settle+comment verified, at-most-once, budget-shared assertion non-tautological, not-raced / test:backend 6362 pass). Findings→Task 0.4: (minor) add interface TSDoc for runRecoveryFromPreReadyFailure; (建议) _reason classification dropped — thread into diagnostics or record deferred-backlog (richest-data-flow).
Task B2-0.4: complete (commit 85b8c5c6 + backlog 50b09c00, review clean — spec ✅ / Approved / 0 blocker / 🔴 server-tool gate SECURITY verified no-bypass: classifyServerExecutionRisk before dispatch, throws not continue, final-target-wire, allowServerTools not on this path; regression toBe(primaryError) object-ref; test 4 non-false-green openCalls===1 / test:backend 6366 pass). Findings: (minor) lastPreReadyFailure stores afterHook not preflight — byte-equiv today, recorded backlog, resolve at P4/P5; (nit) gate-probe outboundPrepareWire double recordFeature — controllable no correctness impact.
Task B2-0.5: complete (commits 41a351fa + 5d386f72 + 325e3771, review clean — spec ✅ (5 处偏离 plan 全经 reviewer code-read 确证为正当现状适配) / quality: 2 Important 已闭合 / 0 Critical.
  底座已被 master 重写，实施按现状适配：只抑制 close/finalize，freeze/suspend/resumeHeartbeat 原样转发；settleFinal 幂等 Promise<void>；新增 inheritDownstreamDeliverySession（plan 未提、实施者自己从代码挖出的真实约束）。
  IMP-1 await 假绿缺口已补守卫（正样本对照：删 await → 5 pass/2 fail 真咬；恢复 → 7 pass）。IMP-2 Concern#2 事实订正 + makeReconcilingSink identity 缺陷登记 backlog（既有缺陷、非本 Task 引入）。
  reviewer 自做 5 次 mutation 独立验证；tests/pipeline 830 pass。)

## 合并基线变更（2026-07-28）
分支已合并 master（e951026a，128 提交）：B1 被主线 supersede（窗口默认 180/ceiling 240/ingress-relative deadline），delivery+heartbeat 生命周期被重写。
plan-2/plan-3 已加实施状态与漂移警告；接手权威 = handover §0.2。
Task B2-0.6: complete/PARTIAL-by-design (commits 623fb34f/dbdc1ebc/424604d3 + fix a24f8aec/8c7221c1/e2489b4b/513127af).
  ① 守卫整个 recordOpened（headers+timing 整体丢弃）+ 三个 timing setter 全对齐 sealed guard；assertWritable 对语义写的 loud-throw 未放宽（reviewer 逐一核对 21 处调用点、正反双侧 oracle）。
  ② quiescence join 经 reviewer 四点 code-read 核实「supervisor 只包 ClientSink、真拿不到 candidate lifecycle」属实 → 授权延后 P4/P5，backlog 改写保留为余项（非删除）。
  reviewer 亲手 3 组 mutation（含它自加的 M3）挖出承重缺陷：unhandledRejection 探针因 helper 里 await request 提供 live awaiter 而结构上无牙（三守卫全拆仍绿）→ 已补真孤儿拓扑用例、mutation 证其变红并捕获真实爆炸栈；setAttemptTimingEpoch 漏的对称守卫已补（先红后绿，观测到 seal 后 _attempts 被污染）。seal-race 连跑 10 次 80/80。
  ⚠ 教训已沉淀：skill debugging-server-crashes 变体 C（含我自己初稿把 3/3 红错误归给 unhandled 探针、后据 reviewer 证伪订正）。

## B2 地基（plan-2）全部完成 —— 下一步 = plan-3 的 P4~P6（接线，全特性最硬）
Task 4.0: complete (commit 1c5ea173) — driver.runResponseRecovery（ready-态挂载点，复用既有 coordinator.runRecovery）。
  承重：① ready-态自己调 classifyServerExecutionRisk（不复用 pre-ready 的检查、不碰 allowServerTools）② runRecovery 加可选 retryNextStrategy，默认仍 "buffered-retry"（既有 buffered 调用方零变化），B2 显式 "precontent-recovery" 防 History 诊断混淆 ③ 零 handler 接线（4.3 才接）。tests/pipeline 843 pass。
  漂移已重核：driver 在 src/lib/pipeline/driver.ts；live stream-error 分支现于 handler-v4.ts:1382-1423（plan 写的 1279-1320 已过时）；buffered runRecovery 调用现于 driver.ts:1530。

## 第二次合并 master（2026-07-28，d1c5a4b2）
master 又前进 70 提交且碰了 P4 的三个目标文件（handler-v4/driver/client-sink）→ 动接线前合并。仅 backlog 冲突（取并集），源码全自动合并。
全后端 6602 pass/8 skip/3 fail，3 个单跑全过（2 个 Bun worker SIGILL + 1 个负载敏感 UDS）→ 与合并无关。
⚠ 记档：parallel-test 汇总仍欠计 ~25%（4749 vs 直接 6614），门的退出码正确、证据行不可信，已入 backlog（根治=改用 junit 计数）。
Task 4.0 review 闭合（commits a125e67e/22b04ac0/1e39a720/9cf8a8ee/796ef05b）：
  reviewer 4 组 mutation，M4 存活 = driver 侧 "precontent-recovery" 实参在全后端 4709 测试下无覆盖（两端各自被证、中间那根线没被证）→ 已补独立 oracle（注入 recording callback 断言 settleDispatch 收到的 nextStrategy），正样本对照：删第 4 实参 → 收到 "buffered-retry" 红；还原 → 7 pass。
  其余：错误消息区分 pre-ready/ready-state；delivery gate 用例加注释说明只锁 caller-side 门控；plan 注解订正（真正漂移的是行号不是路径——reviewer 用 git show 证 plan 从没写过 generation/driver.ts）；**buffered 旁路落 backlog**（主会话裁决，含用户已定的 max_retries=0 语义）；Task 4.4 加 per-attempt 簿记待核项（commitAttemptSseEvents/finalizeCurrentAttemptDuration/resetSseEvents，届时用注入 bug 正样本证）。

## 下一个 = Task 4.1（三模式 splice 纯函数）；分支 30 提交、未合 master
