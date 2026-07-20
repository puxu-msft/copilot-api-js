---
name: git-commit-pathspec-commits-worktree-not-index
description: git commit -- <pathspec> 取工作区非 index，共享 worktree 最终提交一律用它免疫 peer 并发 git add 的 index race；唯 apply --cached hunk 过滤时才用无-pathspec
metadata:
  node_type: memory
  type: feedback
---

`git commit -F msg -- <pathspec>` **提交命名路径的工作区当前内容、无视 index**（等价于先 `git add` 再提交）。故它绕过 `git apply --cached` 精心过滤进 index 的 hunk，把同文件里 peer 的在飞改动整文件扫进 commit。**staged diff 干净 ≠ pathspec commit 干净**（数据源不同）。

**共享 index 的 TOCTOU race（2026-07-05 亲历）**：`git add <我10路径>` 后 `git diff --cached --stat` 实测恰好只我 10 文件，但无-pathspec `git commit` 却提交了 **19 文件**——peer 的 `git add` 在我"核验"与"commit"之间改写了共享 index，无-pathspec commit 提交的是**commit 那一刻**的 index 非核验那刻（通过性结论不自证，见 [[feedback-pass-null-clean-not-self-validating]]）。

**How**：
- 共享 worktree 最终提交**一律 `git commit -F msg -- <我的显式路径>`**（pathspec 取工作区、免疫 index 并发 race）。
- **唯一例外**：做了 `git apply --cached`/`git add -p` 的**同文件 hunk 级过滤**时，必须用**无-pathspec** `git commit`（提交整个过滤后 index）；此时 race 无法两全，缩小窗口。
- 误提交恢复（本地未 push、`git log` 确认 HEAD 是我的无 peer 叠加）：`git reset --soft HEAD^`（不碰工作区）→ `git restore --staged <peer 文件>`（回工作树、peer 零丢失）→ pathspec `git commit -- <我的路径>` 重提。

扩展 [[sed-touched-files-bundle-inflight-work]]（`git add <file>` 扫入在飞工作，本条讲 commit 更隐蔽）；user-level skill `git-preference:avoiding-shared-worktree-conflicts` 的 Quick reference 未强调"pathspec 取工作区非 index"这层。
