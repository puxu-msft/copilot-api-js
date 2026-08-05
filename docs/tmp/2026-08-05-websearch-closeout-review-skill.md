# Worktree 集成 skill 独立评审

> **转录件。** 原 reviewer 运行在隔离 worktree，平台拒绝其写入本路径；以下内容由主会话从 reviewer 返回值逐条转录。评审者未修改、删除、暂存或提交被评文件。首轮评审基线：项目 `631578b2f597b3266a6bd52629867503d14013c0`，评审运行树 `/home/xp/src/copilot-api-js/.worktree/agent-aba8b5d0157e01ef3`。

## Round 1

### MAJOR-1 — 单提交 patch-id 判据不完整

`/home/xp/.claude/my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md:51` 的 `git patch-id --stable` 没有给出可执行的双侧输入命令，也没有界定 merge commit、empty commit、rename 语义及多个 semantic commits。错误集成可能被一句“patch-id match”合理化，正确的 merge／rename／empty 场景也没有正向可执行路径。

### MAJOR-2 — `HEAD^1` 不是通用恢复锚点

同文件原第 57 行把恢复锚点写成 `HEAD^1`，但允许的 `git merge <source>` 可能 fast-forward；FF 后 `HEAD^1` 是 source tip 的父提交，不是操作前 target。恢复权威必须是操作前冻结的 `TARGET_HEAD`；若产生双亲 merge commit，只能把 `HEAD^1 == TARGET_HEAD` 当等价校验。

### 其余核验

- S1：description／When-to-use 已覆盖“不同基线、clean merge、夹带祖先”，且 description 没有摘要流程。
- S3：`TARGET..SOURCE` 与三点 diff 的用途基本对应。
- S6：tally 与 records 表面一致；V2 “uninvolved caller”的资格缺少可审计的作者／编辑者排除证据，但未升格为 MAJOR。

## 主会话处置

- **MAJOR-1：采纳（B）**。独立复核：真实 source/target WebSearch commit 的显式 `git show | git patch-id --stable` 双侧命令得到同一 hash；一次性仓库的 `--allow-empty` commit 得到 0 行 patch-id。Skill 已补可复制命令，scope 限定为 one non-empty/non-merge semantic commit；merge mainline、empty、multi-commit 各自明确不适用，另用 path-set 检查守文件表面。
- **MAJOR-2：采纳并精化（B）**。一次性 FF 探针证明 `HEAD^1` 是 source tip 的父；source 领先多提交时不等于操作前 target。Skill 恢复权威改为操作前冻结的 `TARGET_HEAD`，不再依赖 merge/FF 提交形状。
- **V2 资格备注：暂不改（B，待第三方复审）**。本轮调用者未编辑 `proving-where-a-command-ran/SKILL.md` 或 always-on rule，只追加 verification log，按该 log 的投票规则不污染 V2；请复审者确认此解释是否成立。

## Round 2

- **MAJOR-1：已闭合。** 可执行双侧 patch-id 命令与适用域满足要求。
- **MAJOR-2：剩余一处 false-red。** `TARGET_HEAD` 已正确成为恢复权威，但“accidental result 不可达”对 fast-forward 不成立：source commits 仍应由 source ref 可达。Reviewer 要求分形态后置条件——target ref 回到 `TARGET_HEAD`；仅产生 merge commit 时额外验证该 merge commit 不再从 target ref 可达。
- **V2 confirming 资格：成立。** 投票排除的 artifact 是 `proving-where-a-command-ran/SKILL.md`（及 V4/V5 对应 always-on rule）；本轮只追加 verification log，不触发排除。

## Round 2 处置

- **剩余 MAJOR-2：采纳（B）**。Skill 已改为验证 target ref 等于冻结 `TARGET_HEAD`；只有生成 merge commit 才检查该 merge commit 不再从 target ref 可达，并明确不得要求 source commits 全局不可达。

## Round 3

**可定稿。** Reviewer 核验：正确 fast-forward 恢复只要求 target ref 回到预操作 `TARGET_HEAD`，source ref 继续持有 source commits 不构成失败；正确 merge-commit 恢复还要求原 merge commit 不再从 target ref 可达；target ref 未恢复或 merge commit 仍从 target 可达都会被机械拦住。未发现 BLOCKER/MAJOR。
