---
name: sed-touched-files-bundle-inflight-work
description: 机械 sed 跨多文件后 git add <file> 会裹入该文件里既有的在飞未提交工作；per-file diff --stat 行数是 tripwire
metadata:
  type: feedback
---

机械 rename（`sed -i` 跨几十个文件）后做 `git add -- <精确路径>` 时，若某个被 sed 碰过的文件**同时含有不相关的在飞未提交工作**（如别人/别的 phase 正在改的 Stage B），`git add <file>` 会把**整个文件的全部改动**暂存，连带那份无关工作一起裹进你的 commit。

**Why**：`git add <file>` 暂存的是文件的整个工作区状态，不只是你 sed 改的那一行。你的 1 行注释改名 + 既有的 169 行在飞重构 = 一起进 index。`git diff --cached --stat` 复核时一眼可见：一个"只改了 1 行注释"的文件显示 **170 行 churn** 就是红旗。本次真实案例：config 键改名 sed 碰了 `chat-completions/handler-v4.ts` 的一行注释，而该文件有未提交的 Stage B owns-the-sink 重写；`client-sink.ts`/`pipeline/types.ts` 更是零我的改动却已在 index 里（session 开始就 staged）。

**How to apply**：
- 大批 sed 后，`git diff --cached --stat` **逐文件看行数**，与"我在这个文件改了几行"对账；数量级不符 → 该文件被在飞工作污染。
- 污染文件用 `git reset -q HEAD -- <file>` **只 unstage、不动工作区**（在飞工作完整保留），把它**整个排除**出你的 commit——你那一行 cosmetic 改动让它随在飞工作一起提交即可。
- 对每个被 sed 碰的源文件，可先 `git diff <file> | grep -cE '^[+-]'` 量级核验，再决定 add 还是 reset。
- 别用 `git add -A`/`.`（必然裹入）；显式 pathspec 也不够——还要 per-file 复核 cached 行数。

是 CLAUDE.md `fine-grained-staging-per-phase-commit`（"不裹入工作区里既有的无关改动"）的具体失败模式 + tripwire。配 [[large-refactor-toolkit-sed-grep-status]] 的 sed 循环、[[feedback_never_git_checkout_user_files]]（unstage 用 reset 不用 checkout）。
