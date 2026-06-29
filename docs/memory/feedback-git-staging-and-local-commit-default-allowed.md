---
name: feedback-git-staging-and-local-commit-default-allowed
description: 本项目 git 暂存/本地提交默认允许（2026-06-15 用户改、settings.json ask 工具强制）；通用的 cadence/consent 边界已上行 git-commit-discipline skill
metadata:
  node_type: memory
  type: feedback
  originSessionId: aefcabc6-5b23-423e-aa8a-2fef19f97ca3
---

通用机制已上行 user-level skill `git-commit-discipline:avoiding-shared-worktree-conflicts`（cadence：本地 commit 例行直接做、push/main/跨会话才停；amend push 前例行/已 push 需问；branch -D/tag push 需问；`restore --staged` 仅 index 安全 vs `restore <file>` 破坏工作区）。**本记忆只留项目特异决策史。**

用户 2026-06-15 改了 CLAUDE.md 的 git 暂存策略：旧"禁止 git add/reset/restore --staged without explicit consent" → 新"可逆本地操作默认允许、只有远端/改写历史需明确同意"。**现由 settings.json 的 ask 工具机制强制**（非靠记忆自觉）。

**Why：** 用户原话"以前因管理混乱所以禁止"——旧保守规则是过去信任错位的 workaround，非真实风险。no-destructive-workspace-loss 既已硬锁真正破坏性操作，把 `git add` 当仪式性批准纯属摩擦。

Linked: [[feedback_never_git_checkout_user_files]]（破坏性下限不变）、[[feedback_no_unilateral_action]]（范围歧义仍问）。
