---
name: git-concurrent-sessions-pathspec-commit
description: 本仓库有并发 agent 会话同时提交；用 git commit -- <精确路径> 只提目标文件，绝不在并发提交活跃时重写历史
metadata:
  type: feedback
---

本仓库（copilot-api-js）会有**并发 agent 会话同时往同一 git 仓库提交**。2026-06-22 实证：排查 pre-response abort 期间，另一会话在密集提交 L2 streaming 工作，HEAD 在我两次操作之间从我的 commit 移到了别人的 commit（`8df57f0`→`e41fc0d`→`8f2839f`…），且它暂存进共享 index 的 `test-env-isolation.md`（117 行、我从没碰过）被我一个 `git add -- <RFC> && git commit` 一并扫进了我的 commit。

**Why**：`git add <path>` 之后裸 `git commit` 提交的是**整个 index**，包含并发进程在你 `add` 与 `commit` 之间塞进去的任何**其它文件**。这与 [[sed-touched-files-bundle-inflight-work]] 的"同一文件多作者改动"是不同机制——这里是并发进程在你背后 mutate 共享 index 加入**完全不相关的别的文件**，per-file 行数对账抓不到（那些文件的改动量本就是别人的真实改动量）。

**How to apply**：
- 提交用 `git commit -m "..." -- <精确路径>`（pathspec 即 `--only` 语义）：只提交这些路径，**无视 index 里其它一切**，对并发暂存免疫。注意参数顺序——`-m "msg"` 必须在 `-- <path>` **之前**（`git commit -- <path> -m` 会把 `-m` 当 pathspec 报错）。
- **同一文件含我的改动 + 用户/并发未暂存改动、只想提我的那几个 hunk**（2026-06-22 L2 Phase 2 实证：`handler-v4.ts` 同时有我的 pump 改动和用户的 pre-response abort 改动）：`git commit -- <file>` 会把该文件**整个工作区态**（含别人的改动）一并提交，pathspec 救不了。交互式 `git add -p` 在本 harness 不可用。解法是 **`git apply --cached` 过滤补丁**：`git diff <file>` 生成全量补丁 → `awk` 按 hunk 头 `@@ -OLD` 的 OLD 起始行号过滤只留我的 hunk（我的与别人的 hunk 行区间不重叠时可机械分割）→ `git apply --cached --recount <filtered.patch>` 只把我的 hunk 应用到 index（工作区别人的改动**不动**）。提交前 `git diff --cached <file> | grep -c '<别人改动的特征串>'` 必须为 `0`、`grep -c '<我的特征串>'` 为预期数，双向对账确认 index 只含我的。`--recount` 让 git 容忍行号偏移。
- 提交后 `git show --stat HEAD` 复核**只含你的文件**。
- **绝不在并发提交活跃时重写历史**（`reset`/`rebase`/`--amend`）：HEAD 在你脚下移动、你的 commit 被别人的 commit 压在下面，重写极可能 clobber 对方在飞工作。宁可接受"一个 commit 多裹一个无关 doc"这点瑕疵——被裹入的内容没丢（在 git 历史里），代价远小于历史手术在并发下的损坏风险（呼应 [[feedback_never_git_checkout_user_files]] 的破坏性下限）。

是 CLAUDE.md `fine-grained-staging-per-phase-commit` 在**并发多会话**环境的失败模式 + 防线。配 [[feedback-git-staging-and-local-commit-default-allowed]]（本地提交默认允许）、[[sed-touched-files-bundle-inflight-work]]（同文件多作者改动的检测 + `git reset -q HEAD -- <file>` 反向 unstage，与本条的 `git apply --cached` 正向只暂存互为正反操作）。
