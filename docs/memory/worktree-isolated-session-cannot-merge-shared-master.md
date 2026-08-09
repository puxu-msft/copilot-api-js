---
name: worktree-isolated-session-cannot-merge-shared-master
description: 隔离 worktree 会话无法自行合并回主线——master 被主检出占用且护栏禁止 -C 到共享树，只能交付到「可 fast-forward」为止
metadata:
  type: project
---

本仓库的后台作业跑在隔离 worktree（`.worktree/<name>`）里时，**做不到自行把分支合并进 `master`**，两道机械限制叠加：

1. `master` 始终被主检出 `/home/xp/src/copilot-api-js` 占用，git 拒绝在别的 worktree 检出或强制移动同一分支。
2. 会话护栏拦截任何指向共享检出的 git 命令（`git -C /home/xp/src/copilot-api-js …` 直接被拒），且该拒绝**不提供** `GIT_DISCIPLINE_OK=1` 之类的放行前缀——与「从指定起点新建分支」那道护栏不同。

**拦截范围比「写操作」更宽：只读也被拒。** 2026-08-09 实测 `git -C /home/xp/src/copilot-api-js --no-optional-locks status --short --branch` 同样被拒（拒绝理由只说「redirects git to the shared checkout via -C」，不区分读写）。复合命令另有一道：含重定向或多段管道时报「too complex to verify that it stays inside the worktree」，要拆成单条。

**这带来一个容易漏判的后果**：收尾契约里「逐个 repository 与 worktree 冻结状态」（`closing-a-development-session` 的 `freeze_truth`）**在隔离 worktree 里无法自行满足**——共享主树的 `git status` 取不到。按 `requires` 图它会连带阻断下游全部 stage。**正确处置是如实登记为未达成并把命令交给用户，不是找个替代指标蒙混过去**：本轮曾用「工作区文件内容 vs `master` blob 逐条 md5」作替代，它覆盖内容差异与文件缺失，但**不覆盖** file mode、regular↔symlink 类型变化、「已 staged 又改回」这类只在 index 层可见的状态，也不枚举候选路径以外的未追踪文件——**是另一个问题的答案，不是 `git status` 的等价物**。

**How to apply:** 交付到「主线可 fast-forward」为止，然后把最后一条命令交给用户，别自造绕路（用 `update-ref` 直接改 `master` 会让主检出的工作区与 HEAD 错位，看起来像海量未提交删除，属数据丢失风险）。收尾动作：

1. 在自己的 worktree 里 `git merge --no-edit master` 做集成合并（peer 常在几十分钟内把 master 推进几十个提交，可能要合多次）。
2. 用 `git merge-base --is-ancestor master HEAD` 证明可 fast-forward——这是可交付的机械判据。
3. 报告里给出用户要跑的那一条：`git -C /home/xp/src/copilot-api-js merge --ff-only <branch>`。

**Why:** 「已合并」和「可合并」是两个不同的完成态；把后者说成前者，用户会以为主线已经带上改动。多次集成合并后需要重新验证的只是**受影响路径**——若某次集成只带入 docs／skill，按 `moving-shared-head-is-not-failure` 不必重跑全量。

Related: [[reference-worktree-bun-add-needs-main-tree-install-after-merge]]
