# 事实证伪复评 R7

- **评审范围：** 主树候选 `HANDOVER.md@d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、`KICKOFF.md@df5229906260cf9a80ea9bcdd42700444183a2fdd5155494b53a8de5ed184d47`；仅复核 R6 唯一 major 与已关闭接缝是否回归。
- **总体 verdict：** 可定稿。
- **计数：** 0 blocker / 0 major。
- **双视角覆盖——机械核对：** 复核三份 PYFINAL 的 BASE ancestor、`rev-list BASE..HEAD`、逐 commit first-parent diff、rename/copy 双端、net cross-check、root/cwd/top-level；10 个 Bash block 经 marker 替换后 `bash -n` 均 rc=0。核对 argv fixed shape 与 allowlist maintenance 条款未回退。
- **双视角覆盖——第一人称执行：** 走查合法 merge、侧支越权、主线越权、merge commit 自身越权、commit 后 revert 五路；采用 `/home/xp/.claude/jobs/2684f077/tmp/merge-history-gate-poc.mhwjmpv4` 的结果校准正确状态可绿、四类错误状态均红。

## R6 disposition

1. **CLOSED — 合法 merge false-red。** `KICKOFF.md:308-316,573-581,854-862` 先由 `rev-list BASE..HEAD` 枚举全部可达侧支／主线 commits，再对每个 commit 只比较 first parent→commit；合法 merge 不再把第一父既有内容因相对其他 parent 不同而误算。
2. **侧支逐 commit 覆盖成立。** `rev-list BASE..HEAD` 非 first-parent-only，侧支 commit 自身逐一进入 union；PoC 的 side-forbidden 为红，证明 first-parent merge 修订没有漏掉侧支越权。
3. **merge 自身与历史缺陷仍可见。** merge commit 的 first-parent→merge 捕获 conflict resolution／额外写入；main-forbidden、merge-extra、commit-revert 均红。`-M -C` 加 parser 保留 rename/copy 两端，后续 revert 不会从 union 擦除早先触碰。
4. **BASE／net／root gate 未回归。** 三份 PYFINAL 仍先核 BASE 是 HEAD ancestor、ambient cwd 与 Git top-level 等于 WORKTREE，全部 Git subprocess 绑定 root；净 `BASE..HEAD` 仅作额外 tripwire且必须是 history union 子集。

## 已关闭项回归扫描

- **argv：** `KICKOFF.md:40-49` 中 argv[1:] 只输出固定 shape，不输出原 token、value、path、digest 或 length；未发现回归。
- **allowlist maintenance：** `KICKOFF.md:97-104` 仍要求 interim 独立复核、WIP clean、main 冻结 bytes、唯一 carrier maintenance commit、NEW_BASE descendant 与同一 agent `SendMessage` 续跑；未发现数据丢失或自行扩权路径。

## 事实性发现

未发现 blocker 或 major。
