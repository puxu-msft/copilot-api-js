---
name: worktree-isolated-session-cannot-merge-shared-master
description: 隔离 worktree 会话无法自行合并回主线——master 被主检出占用且护栏禁止 -C 到共享树，只能交付到「可 fast-forward」为止
metadata:
  type: project
---

本仓库的后台作业跑在隔离 worktree（`.worktree/<name>`）里时，**做不到自行把分支合并进 `master`**，两道机械限制叠加：

1. `master` 始终被主检出 `/home/xp/src/copilot-api-js` 占用，git 拒绝在别的 worktree 检出或强制移动同一分支。
2. 会话护栏拦截任何指向共享检出的 git 命令（`git -C /home/xp/src/copilot-api-js …` 直接被拒），且该拒绝**不提供** `GIT_DISCIPLINE_OK=1` 之类的放行前缀——与「从指定起点新建分支」那道护栏不同。

**How to apply:** 交付到「主线可 fast-forward」为止，然后把最后一条命令交给用户，别自造绕路（用 `update-ref` 直接改 `master` 会让主检出的工作区与 HEAD 错位，看起来像海量未提交删除，属数据丢失风险）。收尾动作：

1. 在自己的 worktree 里 `git merge --no-edit master` 做集成合并（peer 常在几十分钟内把 master 推进几十个提交，可能要合多次）。
2. 用 `git merge-base --is-ancestor master HEAD` 证明可 fast-forward——这是可交付的机械判据。
3. 报告里给出用户要跑的那一条：`git -C /home/xp/src/copilot-api-js merge --ff-only <branch>`。

**Why:** 「已合并」和「可合并」是两个不同的完成态；把后者说成前者，用户会以为主线已经带上改动。多次集成合并后需要重新验证的只是**受影响路径**——若某次集成只带入 docs／skill，按 `moving-shared-head-is-not-failure` 不必重跑全量。

Related: [[reference-worktree-bun-add-needs-main-tree-install-after-merge]]
