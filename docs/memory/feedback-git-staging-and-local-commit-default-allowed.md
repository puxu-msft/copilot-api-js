---
name: feedback-git-staging-and-local-commit-default-allowed
description: "Git add/commit/local-branch 操作默认允许（不是「除非被要求否则禁止」）——用户在 2026-06-15 明确改了这条规则，因为旧的「每次都问」源于过去的管理混乱，而非实际风险。远端 push + 改写历史仍需明确同意。"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aefcabc6-5b23-423e-aa8a-2fef19f97ca3
---

用户在 2026-06-15 改了 CLAUDE.md 的 git 暂存策略（现由 settings.json ask 工具强制）。旧规则：「禁止 git add/reset/restore --staged without explicit user consent」。新规则：**可逆的本地操作默认允许；只有远端/改写历史才需明确同意**。

**默认允许（无需问）：**
- `git add` / `git add -p`
- `git restore --staged <file>`（仅动 index）
- `git commit` / `git commit --amend`（仅当尚未 push）
- `git stash push`
- 本地分支操作：`git branch`、`git switch -c`、`git checkout -b`

**必须明确询问：**
- `git push`（任何远端 push，包括 --force / --force-with-lease）
- `gh pr create` 以及任何把内容发到 GitHub 的操作
- 对已 push 的 commit 做 amend/rebase/reset
- 删除分支：`git branch -D`、`git push --delete`
- Tag push

**仍然禁止（no-destructive-workspace-loss 不变）：** 任何会摧毁未暂存工作区改动的操作——见 [[feedback_never_git_checkout_user_files]]。`git restore --staged` 是安全的（仅 index）；`git restore <file>`（无 --staged）会动工作区 → 属no-destructive-workspace-loss 领地。

**Why:** 用户说「以前是因为管理混乱所以才禁止」——过去的混乱意味着信任错位，所以保守规则是「每次都问」。如今no-destructive-workspace-loss 已硬锁住真正具破坏性的操作，把 `git add` 当作需要仪式性批准就纯粹是摩擦。

**How to apply:**
1. 任何 git 操作前自检：(a) 是否动远端？→ 问。(b) 是否动用户工作区文件？→ no-destructive-workspace-loss。(c) 仅 index / 仅本地 commit / 仅本地分支？→ 直接做。
2. Commit message：写、提交、在回复里说明提交了什么。如果用户不喜欢这条 message，他们可以 `git commit --amend`（push 前可逆）。
3. 不要滑回旧的「git add 前该不该问？」反射——它在旧规则下是对的，现在是浪费的仪式。

Linked: [[feedback_never_git_checkout_user_files]]（no-destructive-workspace-loss 不变，仍掌控破坏性操作）, [[feedback_no_unilateral_action]]（范围歧义仍需询问）。
