---
name: project-upstream-silence-commit-timing-spec
description: 上游 deferred-header 与 delayed-commit 恢复：direct Anthropic live B2 已本地集成 master；buffered／translated 与真实 GHC 效力仍待后续
metadata: 
  node_type: memory
  type: project
  originSessionId: 5cbe8f72-b4ad-4b37-8a03-2bfe84487e37
  modified: 2026-08-08T08:58:00.731Z
---

上游静默事故簇的权威现状已落在项目文档：当前架构见 `docs/DESIGN.md` 的“Anthropic post-commit pre-content recovery（B2）”，实施与证据见 `docs/plan/2026-07-23-upstream-silence-recovery/task-4.3b-implementation-report.md`，规范与历史实证见 `docs/spec/2026-07-23-upstream-silence-commit-timing.md`。

截至 2026-08-08，本地 `master` 已包含 direct Anthropic live B2：delayed-commit pre-ready、ready transport close、ready clean EOF before `message_stop` 三入口；仅确定性上游死亡且客户端尚无真实 block structure／content 时 fresh dispatch，所有 timeout／reaper／request cancel 等 abort provenance fail-closed。最终本地整合基线为 `master@e45536af`，未 push；该 feature worktree 与分支已在确认完全合并后删除。

仍未完成的边界只有正式文档列出的三类：buffered B2、translated recovery publication，以及真实 GHC 大上下文 fresh-retry 成功率。不得把离线 wire／控制流验收推广成真实事故必然恢复。

**Why:** 旧记忆停在 2026-07-28 的 Task 0.6 前，继续保留会让新会话重跑已经完成并合入 master 的整套实施。
**How to apply:** 只把本条当作触发指针；所有当前状态、测试证据、deferred 边界以 `docs/DESIGN.md`、implementation report 与 backlog 为准。关联 [[project-h2-pool-capacity-routing-and-pre-response-retry]]、[[feedback-recovery-is-only-path-not-risk-tradeoff]]、[[project-request-lifecycle-cancel-settle-quiesce]]。
