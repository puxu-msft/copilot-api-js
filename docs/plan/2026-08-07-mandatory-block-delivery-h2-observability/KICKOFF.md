# 实施会话 KICKOFF

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。执行时必须先读 [`README.md`](README.md) 的 Global Constraints、冻结接口、阶段 DAG 与执行策略。

复制以下内容到新的实施会话：

> 接手 `copilot-api-js` 的 mandatory block delivery + HTTP/2 termination observability 实施。先读 `CLAUDE.md`、`docs/DESIGN.md`、`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`，再读 `docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/README.md` 和当前阶段 plan。Spec 状态是 `confirmed-not-implemented`；不得把目标态当现状。
>
> **工作方式：** 使用隔离 worktree；执行前核对 master／peer 对目标路径的新提交。使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，严格 TDD、每语义任务精确 pathspec conventional commit。Progress 触发与职责以 README「执行策略」为单一事实源；当前 Task 5／9／10／11 派各自 implementer 前按 `session-closeout` §6b 分别建立 `docs/tmp/2026-08-07-mandatory-block-delivery-h2-progress-t5.md`、`...-t9.md`、`...-t10.md`、`...-t11.md`；一 agent 一文件，每个实现 commit 同步更新。
>
> **硬门：** 所有真实内容至少完整 block／item；无边界协议 response-terminal；不做超大单块 spool；DATA callback 不增任何工作；不保留 live／cap retreat；性能只报告不设门；不杀 4141 主服务器；不 push。
>
> **第一步：** 核对当前 HEAD 与计划基线是否漂移，重跑 Task 1 的 SSE parser 红测起点；不要跳到 route 迁移。每任务结束先审 structural smell，再运行定向门；Task 12 之前不得更新 DESIGN live 状态。最终需要两个正交 reviewer 对 merged state 均给出 `0 blocker / 0 major`。
