---
name: methodology-ff-only-refusal-is-not-a-conflict
description: --ff-only 被拒不是冲突而是分叉或脏路径；共享树的重复编辑要用 exact reverse patch 清除、绝不整文件 checkout；附 ls-tree 第二列是类型不是 OID 的取证陷阱
metadata:
  type: feedback
---

`git merge --ff-only` 报 `fatal: Not possible to fast-forward, aborting.` 时，**它没有、也不可能留下冲突态**——`--ff-only` 不是三方合并，要么快进要么干净中止。所以别去找冲突标记，去找这两个真实成因：

1. **真分叉**：目标分支不再是候选的祖先（`git merge-base --is-ancestor <target> <candidate>` 为假）。解法是把最新 target 合进候选、复验，再重试快进。
2. **工作区脏路径挡路**：候选要改的某条路径在共享树里有未提交编辑，快进会覆盖它，git 因此拒绝。

**第 2 种的安全解法（本轮实测）**，顺序不能反：

1. **先三方比对**：共享树的那份编辑 vs `master` vs 候选。只有证明**共享改动是候选的严格子集**（即它已被候选完整包含、清除不丢任何东西），才允许动它。
2. **构造只描述该编辑的 exact patch，反向应用**。⚠️ **绝不用 `git checkout -- <file>` 或从副本整文件覆盖**——共享树里那个文件可能同时含主会话或同伴的未提交 WIP，整文件回退会连它们一起抹掉（撞 `no-accidental-data-loss`）。本轮共享树同时有两份无关 WIP，正是靠精确反向 patch 才保住。
3. 反向应用前先 `git apply --reverse --check`；**失败或与当前改动重叠就停下问用户**，不要强推。

**一个平台坑**：`git apply --directory=` 接的是**相对前缀**，传绝对路径会报 `error: invalid path`。改用 `patch --batch --reverse --dry-run --directory=<abs> -p1` 先试跑，再去掉 `--dry-run` 实做。另注意 `patch` 不带 `--reverse` 时遇到已反向的补丁会**交互式提问**并挂住，批处理环境必须显式给 `--reverse --batch`。

## 取证陷阱：`git ls-tree` 第二列是对象类型，不是 OID

算碰撞集时我按位置取了第二列当 blob OID，于是把**每一条**路径都判成「本地已修改」——产出 63 个假碰撞，而真实碰撞只有 1 个。`ls-tree` 的列是 `<mode> <type> <oid>\t<path>`，**OID 在第三列**。

正确做法：`git ls-tree -rz --full-tree <ref>` 后按 `mode/type/oid/path` 解析成映射再比对；路径含空格时 `-z` 是必需的。

**Why:** 这是 [[feedback-pass-null-clean-not-self-validating]] 的一个尖锐实例——命令跑了、有输出、结论看起来完全合理（「共享树很脏」并不反常），**没有任何信号提示解析错了**。63 这个数字大到本该引起怀疑，但「一棵被多会话共用的树很脏」正好为它提供了合理解释，这种**恰好说得通的错误结论最难自查**。判据：结论若依赖你对某个命令输出格式的记忆，先用一条已知答案的样本校准解析，再拿它下结论。

**How to apply:** 撞到 `--ff-only` 被拒时，先跑 `merge-base --is-ancestor` 分辨分叉还是脏路径，别假设是冲突；清除共享树重复编辑一律走 exact reverse patch。碰撞集这类「按列取值」的取证，先校准列序。

**Related:** [[methodology-verify-the-mutation-actually-applied]]、[[git-commit-pathspec-commits-worktree-not-index.md]] 所在的共享树纪律簇；完整共享树协作规程见 skill `git-preference:coordinating-a-shared-git-worktree`，隔离树的合并边界见 [[worktree-isolated-session-cannot-merge-shared-master]]。
