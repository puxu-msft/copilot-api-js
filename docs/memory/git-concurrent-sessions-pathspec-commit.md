---
name: git-concurrent-sessions-pathspec-commit
description: 并发 agent 会话同改一仓库；核心立场行级共存绝不整文件退让；isolated worktree(git merge 自动合行) 与 shared worktree(手搓 apply --cached/pathspec) 两模式并列可行
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2f1f6a9c-4ff0-4c5b-a1cc-2dabc506a356
---

本仓库（copilot-api-js）常有**并发 agent 会话同时往同一 git 仓库改动**。

**核心立场（2026-06-22/23 用户两次明确）：行级共存，绝不整文件退让。** 同一文件只要双方改的行不重叠，两份改动都该落地——绝不以"别人也碰了这个文件 / 怕冲突"为由把本属自己的改动推给别的会话。退让本身是错误：并发风险是**双向**的，裸 `git add -A` 扫入别人在飞工作是一错，**过度谨慎把本属自己、该做的收尾（记忆索引行、自己改动的活文档注记）推给"新会话"**是另一错。技术存在的意义正是让你**能**在并发下安全提交自己那份，而非用"怕冲突"当不做的借口。

**两种隔离模式并列可行**，区别只在谁做行级仲裁——

## ① isolated worktree + 独立分支（git 自动仲裁）

仓库已有 `.worktrees/`（如 `.worktrees/work1`）。各会话在自己 worktree 上 **HEAD/index 独立**：

- 共享 index 失败模式根本不发生，`git add -p` / pathspec 恢复正常语义，按 [[CLAUDE.md fine-grained-staging-per-phase-commit]] 正常提交即可。
- 未 merge/push 前在自己分支上 **reset/rebase/amend 安全**（HEAD 不会在脚下移动）。
- 集成靠 `git merge`：三方合并**自动合非冲突行**，同一文件的不同区块各自落地，只有真正行重叠才报冲突、才需人工协调。这正是"行不冲突就能并发改同一文件"的 git 原生答案。

## ② shared worktree（手搓行级仲裁——主要高级技巧在此）

多会话共享同一 checkout/同一 index 时无隔离层，得**手搓**达成与 merge 同样的"非冲突行各自落地"。2026-06-22 实证踩坑：排查 pre-response abort 期间另一会话在密集提交，HEAD 在我两次操作间从我的 commit 移到别人的（`8df57f0`→`e41fc0d`→`8f2839f`…），它暂存进共享 index 的 `test-env-isolation.md`（117 行、我没碰过）被我一个 `git add -- <RFC> && git commit` 一并扫进。**Why**：`git add <path>` 后裸 `git commit` 提交的是**整个 index**，含并发进程在你 `add` 与 `commit` 之间塞进去的任何**其它文件**（与 [[sed-touched-files-bundle-inflight-work]] 的"同一文件多作者"不同——这里是并发进程在你背后 mutate 共享 index 加入**完全不相关的别的文件**，per-file 行数对账抓不到）。手法：

- **整文件都是我的、只要无视 index 其它文件**：`git commit -m "..." -- <精确路径>`（pathspec=`--only` 语义，只提这些路径、无视 index 其余，对并发暂存免疫）。参数顺序：`-m "msg"` 必须在 `-- <path>` **之前**。
- **同一文件含我的 hunk + 别人/用户未暂存 hunk，只想提我那几个**（2026-06-22 L2 Phase 2 实证：`handler-v4.ts` 同时有我的 pump 改动和用户的 abort 改动）：`git commit -- <file>` 会把该文件**整个工作区态**一并提交，pathspec 救不了；交互式 `git add -p` 在本 harness 不可用。解法 **`git apply --cached` 按 hunk 过滤**：`git diff <file>` 出全量补丁 → `awk` 按 hunk 头 `@@ -OLD` 起始行号只留我的 hunk（与别人 hunk 行区间不重叠时可机械分割）→ `git apply --cached --recount <filtered.patch>` 只把我的 hunk 进 index（工作区别人改动**不动**，`--recount` 容忍行号偏移）。提交前 `git diff --cached <file> | grep -c '<别人特征串>'` 须为 `0`、`grep -c '<我的特征串>'` 为预期数，双向对账。
  - **⚠️ `git apply --cached` 后必须裸 `git commit`（提交 index），绝不 `git commit -- <path>`**（2026-06-22 OpenAPI 会话踩过）：`git commit -- <path>` 会**重读工作区**该路径、**丢弃你精心 staged 的 index**，把并发会话的整篇改动一并提交（`git show --stat` 行数远超你的改动即中招）。补救：`git reset --soft HEAD~1`（自己分支 tip、无人在上面时安全）→ `git restore --staged <path>` → 重新 `git apply --cached <我的补丁>` → 裸 `git commit`。**判据**：凡用 `apply --cached`/`add -p` 做过 sub-file 精筛的，commit 一律不带 pathspec；pathspec commit 只用于"整文件都是我的、只要无视 index 其它文件"。
- **shared 模式下绝不 reset/rebase/amend**（`--soft HEAD~1` 那个补救是"自己分支 tip 且确认无人在其上"的例外）：HEAD 在脚下移动、你的 commit 被别人的压在下面，重写极可能 clobber 对方在飞工作。宁可接受"一个 commit 多裹一个无关 doc"——被裹内容没丢（在 git 历史里），代价远小于历史手术在并发下的损坏风险（呼应 [[feedback_never_git_checkout_user_files]] 破坏性下限）。
- **共享分支上并发大重构会打挂全树 typecheck/test，验证只能切片**（2026-06-22 实证：并发会话在飞 `HistoryEntry` 字段重构，半成品态全树 `tsc` 报 20+ 错，全在对方文件、零在我的）：别当自己回归、也别修对方在飞 WIP。`bun run typecheck 2>&1 | grep "error TS" | grep -v <对方文件域>` 确认我的文件零错；只跑我那片测试子集；收尾**明示用户**全树 gate 因并发 WIP 暂不可跑、我已切片验证。是 `verify-only-on-executable-changes` 在并发共享分支下的退化形态。
- 提交后 `git show --stat HEAD` 复核**只含你的文件**。

## 归属判断（两模式通用）

逐项判断归属：改的是不是我的代码/我的文档轴？文件现在有没有被并发会话占用（`git status --short <file>` 查）？属于我且该做就用上面的技术只提我那份做完；仅当文件确被并发会话在改、或属于对方职责轴（如对方正做的 phase 的 doc-sync）才不碰。

是 CLAUDE.md `concurrent-sessions-line-coexistence` + `fine-grained-staging-per-phase-commit` 在**并发多会话**环境的机制细节与失败模式。配 [[feedback-git-staging-and-local-commit-default-allowed]]（本地提交默认允许）、[[sed-touched-files-bundle-inflight-work]]（同文件多作者的检测 + `git reset -q HEAD -- <file>` 反向 unstage，与本条 `git apply --cached` 正向只暂存互为正反操作）。
