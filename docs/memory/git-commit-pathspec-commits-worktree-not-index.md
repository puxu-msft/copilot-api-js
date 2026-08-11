---
name: git-commit-pathspec-commits-worktree-not-index
description: git commit -- <pathspec> 取工作区非 index，共享 worktree 最终提交一律用它免疫 peer 并发 git add 的 index race；唯 apply --cached hunk 过滤时才用无-pathspec
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 950c7328-ce3e-4272-93d9-4ed523568974
  modified: 2026-08-11T07:44:24.428Z
---

`git commit -F msg -- <pathspec>` **提交命名路径的工作区当前内容、无视 index**（等价于先 `git add` 再提交）。故它绕过 `git apply --cached` 精心过滤进 index 的 hunk，把同文件里 peer 的在飞改动整文件扫进 commit。**staged diff 干净 ≠ pathspec commit 干净**（数据源不同）。

**共享 index 的 TOCTOU race（2026-07-05 亲历）**：`git add <我10路径>` 后 `git diff --cached --stat` 实测恰好只我 10 文件，但无-pathspec `git commit` 却提交了 **19 文件**——peer 的 `git add` 在我"核验"与"commit"之间改写了共享 index，无-pathspec commit 提交的是**commit 那一刻**的 index 非核验那刻（通过性结论不自证，见 [[feedback-pass-null-clean-not-self-validating]]）。

**How**：
- 共享 worktree 最终提交**一律 `git commit -F msg -- <我的显式路径>`**（pathspec 取工作区、免疫 index 并发 race）。
- **唯一例外**：做了 `git apply --cached`/`git add -p` 的**同文件 hunk 级过滤**时，必须用**无-pathspec** `git commit`（提交整个过滤后 index）；**无-pathspec 这一技术要求不可放宽，但「缩小窗口」不是门**——窗口是时间，不是判据，peer 照样能在这几秒里先提交。正确形状：**持有共享 `git` 资源锁、或完成显式 hold-and-order 之后，连续执行 apply → 核验 → commit**（协议以 user-level skill `git-preference:coordinating-a-shared-git-worktree` 为权威，那里要求序列化共享 index、重叠不可避免时用 filtered-patch／hold-and-order）；**无法序列化就把这次过滤提交转进独立 worktree**。**postcondition 必做**：提交后 `git show --name-status <sha>` 核对文件集，并确认目标 hunk 真落在自己这个 commit 里。
  **没有这道序列化门时会怎样，2026-08-09 实测过一次，方向与上面那条 race 相反**：我用 `git apply --cached` 只把自己那一行 MEMORY.md 暂存好、核验索引恰好 14 个文件，随即无-pathspec commit——**结果我的 commit 只有 13 个文件，MEMORY.md 不在里面**；那一行被 peer 在这几秒内的提交连同他们自己的改动一起带走了（`git log -S <关键词> -- <文件>` 指向 peer 的 commit）。**判定与处置**：内容已在主线、一行不少，这是**归属串了、不是数据丢失**——**不要**为了「把它挪回我的 commit」去改写 peer 的提交（那才是真的破坏）。识别方法：提交回显的 `N files changed` 与你核验过的暂存数对不上，就去 `git log -S` 查那行落在谁的 commit 里，别以为是自己漏暂存了。
- 误提交恢复（本地未 push、`git log` 确认 HEAD 是我的无 peer 叠加）：`git reset --soft HEAD^`（不碰工作区）→ `git restore --staged <peer 文件>`（回工作树、peer 零丢失）→ pathspec `git commit -- <我的路径>` 重提。

扩展 [[sed-touched-files-bundle-inflight-work]]（`git add <file>` 扫入在飞工作，本条讲 commit 更隐蔽）；user-level skill `git-preference:coordinating-a-shared-git-worktree` 的 Quick reference 未强调"pathspec 取工作区非 index"这层。

**改名侧的姊妹坑（`git mv` + pathspec commit 只列新路径→漏提删除，2026-07-20 亲历）**：`git mv a.test.ts a.unit.test.ts` 把「删 a + 加 a.unit」记成**两个独立 index 条目**。若 `git commit -- a.unit.test.ts`（只列新路径），**只提交新增侧、旧路径的删除留在 index 未提交**——worktree 正确（旧文件已没），但 git HEAD 树里旧文件还在（`git status` 显示悬挂的 `D`）。扫盘型守卫（`Bun.Glob` 扫 worktree）会假绿看不出。**How:** 批量改名后 pathspec commit 要**同时列新旧两个路径**（`git commit -- a.unit.test.ts a.test.ts`）；收尾 `git status --short` 确认无悬挂 `D`。踩坑：测试孤儿收编批量 `git mv` 后只列新路径，9 个根级文件的删除悬挂未提交，靠 `git status` 才发现、补一个 `chore: commit pending deletions` 提交。

**⚠️ 上一条**曾建议「或用目录级 pathspec（`git commit -- tests/foo/`）覆盖删+加两侧」——**该建议已撤回，2026-08-11 因照它做而踩雷**。**目录级 pathspec 在字面上满足「显式 pathspec」，却不满足它的目的**：`git commit -- docs/tmp/` 会把该目录下**所有** peer 未提交的改动一并扫进我的 commit。实测：为提交 4 份 `git mv` 而写 `git commit -- docs/history-persistence-worker/ docs/tmp/`，结果 19 个重命名之外**多带走 4 份 peer 在飞文件（+83 行）**；提交回显 `23 files changed` 而我预期 19，那个差值就是唯一信号。

**判据（机械）**：pathspec 里**只允许出现文件路径，不允许出现目录**。改名要覆盖删+加两侧就把新旧路径都逐个列出，别图省事写目录。**下刀前先 `git status --porcelain -- <pathspec>` 看清将被带走的集合**；提交后核对回显的 `N files changed` 是否等于预期，不等就 `git show --numstat` 查多出来的是谁的。

**已经扫入之后怎么办**：先看 `git log --oneline -1` ——若 HEAD 仍是我那笔且无人叠加，按上面的 `reset --soft` 三步还原；**若 peer 已在其上合并或提交，就不要动历史**（rewrite 会连带摧毁 peer 的合并，比误提交严重得多）。此时内容并未丢失、只是提前进了我的 commit，**如实报告归属混入即可**——同 `git log -S` 那条的处置精神：归属串了不是数据丢失。
