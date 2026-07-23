---
name: git-stash-push-empty-pathspec-pops-peer-wip
description: "共享 worktree 里 `git stash push -- <path>` 对无改动的 path 不建 stash，随后 `git stash pop` 会误弹栈顶别人的 WIP"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aef7321a-543b-4e1e-bbb8-762455cee92b
  modified: 2026-07-22T20:08:00.947Z
---

在**共享 worktree**（本仓库常有并发 agent 会话）里，用 `git stash push -- <path>` + `git stash pop` 做「临时藏起我的改动、验证 HEAD 行为、再恢复」这个套路有一个静默陷阱：**若那个 path 当前没有未提交改动（例如我的改动已经 commit 了），`stash push` 不创建任何 stash（可能只打印一句、退出码 0），紧接着的 `git stash pop` 就会误弹出栈顶 `stash@{0}`——那往往是别的会话的 WIP**，把它 apply 进当前分支工作区，制造一堆 `Auto-merging` + `CONFLICT`（unmerged paths），且冲突文件根本不是我 stash 的那个。

**踩坑实录**：为验证「父 commit 上某测试是否红」跑 `git stash push -- src/lib/history/v3/store.ts`（DI-5 已提交、store.ts 工作区无改动 → 没真 stash），随后 `git stash pop` 误弹了另一会话 `feat/retry-strategy-registry` 的 `stash@{0}`（`WIP on feat/...: c125a9dd`），15 个 retry-registry 文件被 apply 进 master、3 个带冲突标记。所幸 pop 因冲突「stash entry is kept」= 别人 WIP 没丢，但工作区被污染、我的后续 commit 全被 unmerged paths 挡住。

**Why**：`stash push -- <path>` 的语义是「stash 该 path 的**改动**」，无改动就无 stash——但 `stash pop` 不认 path、永远弹栈顶。二者不对称，在「我以为我 stash 了自己的东西」的心智下就变成「pop 了别人的东西」。

**How to apply**：
- **stash 前先 `git stash list`**，确认栈顶归属；共享 worktree 里尤其别假设 `stash@{0}` 是自己的。
- 验证「HEAD/父 commit 行为」不要用 stash 套路——用**独立 worktree**（`git worktree add /tmp/x <ref>`，但注意缺 node_modules）或 `git show <ref>:<path>` 只读比对，或在自己隔离分支操作。stash 是「共享栈」，在多会话下是危险的全局状态。
- 若已误 pop：**不自己 checkout/reset 清理**（会毁并发 WIP，触 no-destructive-workspace-loss）；只读评估损害（`git status` / `git stash show --stat stash@{0}` / 数冲突标记），定位 WIP 归属（[[find-claude-session-by-git-branch]]），交由物主会话/用户协调解决冲突，再补自己的提交。
- 我的改动若已 commit，工作区本就 clean——**根本不需要 stash**；stash 空 path 是「无操作却有副作用」的反模式。

Related: [[feedback-merger-yields-but-merge-must-happen]]（并发落地退让但必须合并）、[[feedback_never_git_checkout_user_files]]（不擅自毁工作区）、skill `git-preference:coordinating-a-shared-git-worktree`。
