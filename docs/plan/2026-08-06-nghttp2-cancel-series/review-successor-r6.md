# NGHTTP2_CANCEL 交接件接手方窄复核 R6

- **评审范围：** 以接手者第一人称，复核 R5 的 ambient cwd、argv、扩表 lineage 三项，并真走查 packet 0／1／2 的 allowlist 生命周期、完成 gate 与 main 回收；未重做会话考古。
- **绑定证据：** `sha256sum` 得 HANDOVER `d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、KICKOFF `2c2b79e7fafd0e30264929f472648247775657c7385c0067fc8692759a9f4bc7`。独立抽取 10 个 Bash block 与 17 个 Python heredoc，语法均通过。复跑 `/home/xp/.claude/jobs/2684f077/tmp/allowlist-gate-r5-poc.clvgwer5`：合法 subset `rc=0`；wrong cwd、非祖先与 commit 后 revert 均 `rc=1`；maintenance 的 parent、唯一 carrier diff、blob bytes、clean status 四门均为真。
- **总体 verdict：** **0 blocker／0 major，可定稿。**
- **blocker 数量：** 0。

## R5 三项处置

1. **CLOSED — 完成 gate 绑定隔离树。** 三份 `PYFINAL`（`KICKOFF.md:241-365,501-625,777-901`）先核 ambient cwd 与 `WORKTREE` 相同，再令所有 Git subprocess 使用 `cwd=root` 并核 top-level。agent 与 main 从各自原始 cwd 出发时，都必须先进入登记 worktree；wrong-cwd PoC 确定性转红，不能再把别的 checkout 当目标树。
2. **CLOSED — argv 完全脱敏。** `KICKOFF.md:31-58` 只逐字输出 `argv[0]` basename；其余 token 仅输出固定类别 `<long-option-redacted>`／`<short-option-redacted>`／`<positional-redacted>`，不暴露 option 名、值、路径、digest 或长度。环境敏感值仍只报 key presence（`:60-78`）。
3. **CLOSED — 无损扩表 lineage。** `KICKOFF.md:98-105` 要求旧 allowlist 下先保存合法 commits、双跑 `interim-subset`，不可提交 WIP 原样保留并停止；仅在 clean 后，由同一 agent 写 main 冻结 bytes 并做唯一 carrier maintenance commit。它的 parent 必须严格等于 `INTERIM_HEAD`，故 `NEW_BASE` 包含既有实现，不会分叉或丢工作。

## 三 packet 真走查

- **BASE 前冻结：** main 先逐行生成 repo-relative 精确 allowlist，packet 0／2 只列唯一 report，packet 1 逐文件列实现／测试／live docs／progress／report；carrier 与 reviews 一并提交进 BASE，再冻结 SHA256（`KICKOFF.md:96`）。阶段 1 无未知值，阶段 2 由同一 agent 读取 BASE 中 carrier，并验证固定路径、blob 存在、hash、无 glob／重复／自授权及 report membership（`:176-214,437-474,703-750`）。
- **完成审计：** 三份 `PYFINAL` 对 `BASE..HEAD` 的每个 commit 逐一执行 `diff-tree -M -C` 并取触碰路径并集，再合并 porcelain WIP；commit 后 revert 仍保留 forbidden 历史并转红，rename／copy 两端都会入集。另核 BASE 是 HEAD 祖先，防错误 base／分叉；net diff 只作追加 tripwire，不取代历史 oracle。
- **packet 0／2：** `exact-report` 要求 `HEAD == BASE` 且最终路径集严格等于唯一 report（`:347-351,883-887`）；正确的未提交 report 能通过，额外 commit／WIP 均红。Phase B 既有 ROUND_ID／artifact／hash／DATA_ROOT gate未被削弱。
- **packet 1：** `subset-report` 允许精确 allowlist 的合法多 commit 子集，但强制 report 存在于 committed／WIP 并集；PoC 的 allowed commit＋report WIP 通过，commit-revert 反例红。遍历 `rev-list BASE..HEAD` 的实现对任意数量 commits 等价，不会把正常多 commit 错拒。
- **agent/main 双跑：** agent 回报 committed／net／WIP、allowlist hash、report hash、worktree 与 HEAD；main 必须进入 Agent tool 登记 worktree独立运行同一 gate，不能采信 agent 自报（`KICKOFF.md:105,367,627,903`）。wrong-cwd 门保证 main 若未进入登记树会红，而非误验其他 checkout。

## 额外路径与不可提交 WIP

- 可提交的旧 allowlist 工作先成为 `INTERIM_HEAD`；main 独立 interim gate 后冻结新 bytes，同一 agent只提交 carrier。机械四门要求 parent=`INTERIM_HEAD`、diff 唯一 carrier、blob bytes/hash相符、status clean；PoC 四门全绿。该 commit 是 descendant `NEW_BASE`，同一 agent重新 bootstrap 后按 NEW_BASE／新 hash 续跑，不需 reset／rebase／cherry-pick。
- 不可提交 WIP 保持原样时流程明确停止，main 只裁决且不得执行 maintenance commit（`KICKOFF.md:100-102`）；因此不会为扩表而覆盖或丢弃。只有 WIP clean 后才有 NEW_BASE，正确状态可继续，错误状态不会假绿。

## 双向检查

- **false-green：** 错 cwd、非祖先 BASE、越权路径、commit 后 revert、额外 WIP、错误 carrier hash／bytes／parent 均被机械门拒绝。
- **false-red：** packet 0／2 的合法唯一 report、packet 1 的合法多 commit 子集、fresh origin fast-forward、无自然 CANCEL 的 A4 路径，以及 clean 后扩表续跑均存在可达绿路径。

## 事实性发现

未发现 blocker 或 major。

## 结构怪味扫描

- 扫描范围：`KICKOFF.md:31-78,88-108` 及三个 packet 的 bootstrap／allowlist／`PYFINAL` 全段；判据为身份来源双轨、ambient cwd 泄漏、net diff 掩盖历史触碰、扩表分叉与不可提交 WIP 丢失。上述形态均已有机械 gate，未发现需新增 backlog 的 blocker／major 怪味。
