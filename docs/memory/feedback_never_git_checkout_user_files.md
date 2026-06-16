---
name: feedback_never_git_checkout_user_files
description: "永远不要对工作区文件运行 git checkout/restore/reset --hard/clean/stash drop 或 rm/unlink——曾经通过 `git checkout HEAD --` 静默清除了用户未暂存的修改,不可逆,且没有备份"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d3484aff-0a7f-4ddf-80b9-248de8587aff
---

**Never**(绝不)运行 `git checkout HEAD -- <file>`、`git checkout -- <file>`、`git restore <file>`、`git reset --hard`、`git clean -f`、对源文件 `rm`,或任何可能销毁未暂存工作区修改的命令。这适用于**即使**:
- 我以为自己只是在回退我自己最近的编辑(例如 lint --fix 的输出)
- 文件看起来只包含我的改动
- 我确信用户"不会动过它"
- 这"只是回退一步而已"

**Why:** 我运行了 `git checkout HEAD -- src/lib/anthropic/auto-truncate.ts` 来撤销一次部分的 `eslint --fix`,却没意识到该文件在最初的 `git status` 里就已经是 `M`——这意味着用户在其中有预先存在的未暂存工作。这次 checkout 静默清除了他们的全部工作。用户**没有任何备份**(没有 IDE 时间线,没有 fs 快照)。损害不可逆转。

**How to apply:**
1. 在任何会触及某文件工作区的操作之前,先为该文件检查 `git status`。如果它显示 `M`(已修改)或是未跟踪文件,**停下来询问**——绝不 `checkout`/`restore`/`rm` 它。
2. 要撤销我自己的 lint/格式化改动:用 `Edit`/`Write` 重新编辑该文件,或者干脆保留改动并告诉用户"我做了这些编辑,在不冒险破坏你工作的前提下我无法干净地回退——请你审阅,若不需要请手动还原。"
3. 即使是"只回退我自己最近 30 秒的工作",也要把文件当作用户所有。Git 无法区分我的编辑与他们的编辑。
4. 如果我运行的某个工具(如 `eslint --fix`)以我想撤销的方式修改了许多文件,**不要**批量回退。询问用户。

Linked: [[feedback_no_unilateral_action]]
