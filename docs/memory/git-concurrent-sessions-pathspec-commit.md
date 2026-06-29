---
name: git-concurrent-sessions-pathspec-commit
description: 本项目常并发 agent 会话同改一仓库；核心立场行级共存绝不整文件退让；机制（两模式/apply --cached --recount/merge 自动合行/pathspec commit/切片验证）已上行 git-commit-discipline skill
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2f1f6a9c-4ff0-4c5b-a1cc-2dabc506a356
---

本仓库（copilot-api-js）常有**并发 agent 会话同改同一 git 仓库**。通用机制全上行 user-level skill `git-commit-discipline:avoiding-shared-worktree-conflicts`：① isolated worktree + 独立分支（集成靠 `git merge` 自动合非冲突行）② shared worktree 手搓行级仲裁（`git commit -- <path>` pathspec / `git apply --cached --recount` 按 hunk 过滤、过滤后必裸 commit 绝不 `commit -- <path>` / shared 下绝不 reset/rebase/amend / 并发 WIP 打挂全树 typecheck→切片 `grep -v <对方域>`）。**本记忆只留项目特异点。**

**核心立场（2026-06-22/23 用户两次明确）：行级共存，绝不整文件退让。** 同文件只要双方改的行不重叠两份都该落地，绝不以"别人也碰了/怕冲突"把本属自己的收尾推给别会话——并发风险双向，退让本身是错（呼应 skill closeout triage "是你的就别等"）。

**本项目实证落地：** 仓库已有 `.worktrees/`（如 `.worktrees/work1`）→ 默认走模式 ①；无 worktree 时共享 index → 模式 ②。2026-06-22 实证案例（pre-response abort 期并发提交把别会话 `test-env-isolation.md` 扫入、L2 Phase 2 `handler-v4.ts` 同文件双作者过滤、`HistoryEntry` 重构打挂全树 typecheck）见 commit 历史。

是 CLAUDE.md `concurrent-sessions-line-coexistence` + `fine-grained-staging-per-phase-commit` 的本项目机制锚。配 [[sed-touched-files-bundle-inflight-work]]（同文件多作者反向 unstage）、[[feedback_never_git_checkout_user_files]]（unstage 用 reset 不用 checkout）、[[feedback-git-staging-and-local-commit-default-allowed]]。
