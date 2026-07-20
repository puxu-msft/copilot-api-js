---
name: git-commit-pathspec-commits-worktree-not-index
description: git commit -- <pathspec> 取工作区非 index，共享 worktree 最终提交一律用它免疫 peer 并发 git add 的 index race；唯 apply --cached hunk 过滤时才用无-pathspec
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 950c7328-ce3e-4272-93d9-4ed523568974
  modified: 2026-07-20T18:20:47.629Z
---

`git commit -F msg -- <pathspec>` **提交命名路径的工作区当前内容、无视 index**（等价于先 `git add` 再提交）。故它绕过 `git apply --cached` 精心过滤进 index 的 hunk，把同文件里 peer 的在飞改动整文件扫进 commit。**staged diff 干净 ≠ pathspec commit 干净**（数据源不同）。

**共享 index 的 TOCTOU race（2026-07-05 亲历）**：`git add <我10路径>` 后 `git diff --cached --stat` 实测恰好只我 10 文件，但无-pathspec `git commit` 却提交了 **19 文件**——peer 的 `git add` 在我"核验"与"commit"之间改写了共享 index，无-pathspec commit 提交的是**commit 那一刻**的 index 非核验那刻（通过性结论不自证，见 [[feedback-pass-null-clean-not-self-validating]]）。

**How**：
- 共享 worktree 最终提交**一律 `git commit -F msg -- <我的显式路径>`**（pathspec 取工作区、免疫 index 并发 race）。
- **唯一例外**：做了 `git apply --cached`/`git add -p` 的**同文件 hunk 级过滤**时，必须用**无-pathspec** `git commit`（提交整个过滤后 index）；此时 race 无法两全，缩小窗口。
- 误提交恢复（本地未 push、`git log` 确认 HEAD 是我的无 peer 叠加）：`git reset --soft HEAD^`（不碰工作区）→ `git restore --staged <peer 文件>`（回工作树、peer 零丢失）→ pathspec `git commit -- <我的路径>` 重提。

扩展 [[sed-touched-files-bundle-inflight-work]]（`git add <file>` 扫入在飞工作，本条讲 commit 更隐蔽）；user-level skill `git-preference:coordinating-a-shared-git-worktree` 的 Quick reference 未强调"pathspec 取工作区非 index"这层。

**改名侧的姊妹坑（`git mv` + pathspec commit 只列新路径→漏提删除，2026-07-20 亲历）**：`git mv a.test.ts a.unit.test.ts` 把「删 a + 加 a.unit」记成**两个独立 index 条目**。若 `git commit -- a.unit.test.ts`（只列新路径），**只提交新增侧、旧路径的删除留在 index 未提交**——worktree 正确（旧文件已没），但 git HEAD 树里旧文件还在（`git status` 显示悬挂的 `D`）。扫盘型守卫（`Bun.Glob` 扫 worktree）会假绿看不出。**How:** 批量改名后 pathspec commit 要**同时列新旧两个路径**（`git commit -- a.unit.test.ts a.test.ts`），或用目录级 pathspec（`git commit -- tests/foo/`）覆盖删+加两侧；收尾 `git status --short` 确认无悬挂 `D`。踩坑：测试孤儿收编批量 `git mv` 后只列新路径，9 个根级文件的删除悬挂未提交，靠 `git status` 才发现、补一个 `chore: commit pending deletions` 提交。
