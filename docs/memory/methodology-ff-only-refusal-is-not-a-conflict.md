---
name: methodology-ff-only-refusal-is-not-a-conflict
description: --ff-only 被拒先看完整 status 与 in-progress 状态再按实际 stderr 分流，别按记忆里的成因清单；共享树的重复编辑要用 exact reverse patch 清除、绝不整文件 checkout
metadata:
  type: feedback
---

`git merge --ff-only` 被拒时，**不要按记忆里的「成因清单」对号入座**——我在这条上连错四次（「不可能留下冲突态」→「`ls-files -u` 非空/为空」二分→ stderr 与成因混写 →「status 干净」当门），**三次枚举不全、一次反向过严**。可靠的做法不依赖枚举完整，也不要求整树干净：

1. **先看 in-progress operation 状态**，不是「工作区干不干净」：`git --no-optional-locks status` 顶部的进行中操作提示，加 `git ls-files -u`。**已知至少三种前置状态会让它拒绝**：未解决的 unmerged entries；已 `git add` 解决但**未提交**的 merge（`ls-files -u` 为 **0**，报 `fatal: You have not concluded your merge (MERGE_HEAD exists)`）；rebase／cherry-pick 未收尾。**这个清单不保证完整。**
   ⚠️ **别把「工作区干净」当成前置条件**——那是过严的门：**与候选改动不重叠**的 staged／unstaged 改动完全不妨碍快进，共享树几乎永远有别人的 WIP，要求整树干净等于永远过不去。只有**重叠**的脏路径才挡路，而它会由下面的 stderr 直接告诉你。
2. ⚠️ **共享树里发现前置状态，只报告并确认归属，不要自行「先解决它」**——那可能是同伴正在进行的操作，替他 `--abort` 或提交等于动别人的工作。
3. **按实际 stderr 分流**，别按猜测：
   - `Not possible to fast-forward` → **拓扑分叉**：目标不再是候选的祖先（`git merge-base --is-ancestor <target> <candidate>` 为假）。解法是把最新 target 合进候选、复验、重试。
   - `local changes ... would be overwritten` → **重叠的脏路径挡路**：候选要改的某条路径在共享树里有未提交编辑。
   - **多种情况可以同时存在**，解决一个之后要重跑，别假设只剩一个。

> 证据等级：上述三种前置状态、两条 stderr 的对应、以及「不重叠 staged dirt 不妨碍快进」，均由独立 reviewer 在 Git `2.43.0` 临时仓库正反探针实测；**本会话因 worktree 隔离护栏无法自行复跑，未经我方独立复核**。正因如此，正文的判据落在「读 in-progress 状态 + 读实际 stderr」，而不落在这份枚举上。

**脏路径的安全解法（本轮实测）**，顺序不能反：

1. **先三方比对**：共享树的那份编辑 vs `master` vs 候选。只有证明**共享改动是候选的严格子集**（即它已被候选完整包含、清除不丢任何东西），才允许动它。
2. **构造只描述该编辑的 exact patch，反向应用**。⚠️ **绝不用 `git checkout -- <file>` 或从副本整文件覆盖**——共享树里那个文件可能同时含主会话或同伴的未提交 WIP，整文件回退会连它们一起抹掉（撞 `no-accidental-data-loss`）。本轮共享树同时有两份无关 WIP，正是靠精确反向 patch 才保住。
3. 反向应用前先 `git apply --reverse --check`；**失败或与当前改动重叠就停下问用户**，不要强推。

**一个平台坑**：`git apply --directory=` 接的是**相对前缀**，传绝对路径会报 `error: invalid path`。改用 `patch --batch --reverse --dry-run --directory=<abs> -p1` 先试跑，再去掉 `--dry-run` 实做。另注意 GNU `patch 2.7.6` 遇到已反向的补丁而**未给** `--reverse` 时，会打印 `Assume -R? [n]` 与 `Apply anyway? [n]`——stdin 无输入时退出，交互式终端下会停在那里等人；批处理一律显式给 `--reverse --batch`。

## 取证陷阱：`git ls-tree` 第二列是对象类型，不是 OID

算碰撞集时我按位置取了第二列当 blob OID，于是把**每一条**路径都判成「本地已修改」——产出 63 个假碰撞，而真实碰撞只有 1 个。`ls-tree` 的输出是 `<mode> <type> <oid>\t<path>`，**OID 在第三列**。

正确做法：`git ls-tree -rz --full-tree <ref>` 后按 `mode/type/oid/path` 解析成映射再比对；路径含空格时 `-z` 是必需的。

**Why:** 这是 [[feedback-pass-null-clean-not-self-validating]] 的一个尖锐实例——命令跑了、有输出、结论看起来完全合理（「共享树很脏」并不反常），**没有任何信号提示解析错了**。63 这个数字大到本该引起怀疑，但「一棵被多会话共用的树很脏」正好为它提供了合理解释，这种**恰好说得通的错误结论最难自查**。判据：结论若依赖你对某个命令输出格式的记忆，先用一条已知答案的样本校准解析，再拿它下结论。

**本条自身的翻车史**：同一条记忆被独立 reviewer 连打四轮，**每次都是「用一份我记得的清单去替代读实际输出」**——①「不可能留下冲突态」被前置 unmerged index 推翻（枚举不全）；②「`ls-files -u` 非空/为空」二分被 resolved-but-uncommitted merge 推翻（枚举不全）；③把一条具体 stderr 与两个成因混写，而两者报错其实不同；④改用「status 干净」当门，**反向过严**——不重叠的 staged dirt 根本不妨碍快进，而共享树几乎永远有别人的 WIP。**可迁移的判据：写「成因只有这几种」或「必须先干净」时，先问枚举凭什么完整、门凭什么必要；把判据改成读实际状态与实际报错，两个方向的错都消失。**

**How to apply:** 撞到 `--ff-only` 被拒，先 `status` + `ls-files -u` 看有无前置状态（有则报告、确认归属，不自行解决），再按实际 stderr 分流；清除共享树重复编辑一律走 exact reverse patch。碰撞集这类「按列取值」的取证，先校准列序。

**Related:** [[methodology-verify-the-mutation-actually-applied]]、[[git-commit-pathspec-commits-worktree-not-index]] 所在的共享树纪律簇；完整共享树协作规程见 skill `git-preference:coordinating-a-shared-git-worktree`，隔离树的合并边界见 [[worktree-isolated-session-cannot-merge-shared-master]]。
