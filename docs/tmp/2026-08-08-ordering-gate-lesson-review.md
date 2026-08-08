# 顺序门教训与收尾自验记录独立评审

## 评审范围、证据与 verdict

- 评审范围：`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md`、`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/MEMORY.md:34`、`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/.claude/skills/session-closeout/verification-log.md:158-170`。
- 已读取：上述三处全文／上下文；相关 memory `methodology-downgrading-a-gate-needs-a-reachable-trigger.md` 与 `feedback-pass-null-clean-not-self-validating.md` 全文；`session-closeout/SKILL.md` 的 V7 定义；终审报告与整改前后 manifest／terminal report。
- 已执行：核对 HEAD `0a788890f8f960bf88dae5cf73d5add1f93a3c88`；读取 `922b741b` 的整改前 manifest 并独立计数；核对 `43ffac97` 路径集合与 ancestry；核对三笔 skill 编辑提交；核对两个 memory slug；对照 `589c4718..0a788890` 完整 diff。
- 总体 verdict：**修复 major 后可定稿**。
- Blocker：**0**。Major：**1**。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md:8,12,20` — “触发方不读 Y 就不是门，只能改成提前发生也无害”写成了过强的二分法。
证据／false-red：有效顺序也可由触发链中的其他执行接缝保证，例如 Y 完成后才产生 X 的触发事件，或 scheduler／hold 机制在放行 X 前读取 Y；X 的直接执行者不读 Y，门仍然成立。终审报告 `closeout-review-final.md:29` 自己也保留了“可显式 hold job 生命周期且经验证的外部机制”这一合法方案。
影响：未来会把存在可验证因果门的正确设计误判为“愿望”，并强制采用“提前发生也无害”；对本轮 job cleanup 的结论正确，但泛化规则会制造 false-red。
修复建议：把判据改为追踪**完整触发／放行链**：谁产生触发、谁决定放行、哪一环读取或因果编码 Y、检查与动作是否原子；只有整条链都没有可执行接缝时才判“不是门”。“让 X 提前发生也无害”应列为首选消门方案，但保留“建立并验证会读取／编码 Y 的外部 gate”这一合法替代。
推荐修复方：`gpt-souls:instruction-smith`，修后仍须独立复评。

## A1–A7 逐项核验

- **A1：满足。** 具体形态在正文 `:8,18`，可执行判据在 `:20`，本轮实例在 `:10,15-16`；不是只写“意识到了”。但判据须按上述 major 收窄，否则其可执行性伴随 false-red。
- **A2：属实。** `git show 922b741b:docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md` 有 56 个数据行，56 行的“清理前置”列逐字相同；`docs/tmp/2026-08-08-history-worker-batch-1b-closeout-review-final.md:23-29,47` 明确将断口判为 major，初轮 verdict 为 0 blocker／2 major。
- **A3：属实。** 两个 slug 对应文件均存在，frontmatter `name` 精确一致；前者讲“闸门缺可达触发点／触发宿主消失”，后者讲“通过性结论不自证”，链接语义匹配。
- **A4：不构成重复。** 既有条目限定于 `downgrade-self-adjudicated-gates` 的未来会话触发与裁决流程；新条目讨论任意顺序门、不可控生命周期事件及“消门”设计。两者同属执行接缝家族，但适用域、失败机制和修法不同，保留独立条目并互链合理。
- **A5：符合体例。** `MEMORY.md:34` 同时含触发症状“写 X 必须晚于 Y”、防漏动作“查触发方／改成提前无害”和本轮辨识样本；长度与相邻 `:33,35` 同档。该行也需随 major 一并收窄，不能继续复述过强二分法。
- **A6①：一致。** `verification-log.md:160` 给出的三笔 commit 均只改过该 skill 目录，确实命中第 11 行“本轮编辑过该目录不得投证实票”；全节均标“数据不足／不投票”。
- **A6②：分类正确。** `session-closeout/SKILL.md:177` 的 V7 只断言起草前与最终提交后两个机械提交时点；本轮两者均执行，缺陷位于 V7 没覆盖的 lifecycle gate 执行接缝，故是新增负样本而非 V7 证伪。
- **A6③：仓库可复核部分相符。** 四份 receiver 当前均 tracked／未 ignore；三笔 skill 编辑提交属实；`git diff-tree -r 43ffac97` 精确为三份收尾产物；`43ffac97` 是当前 HEAD 祖先。`verification-log.md:165` 所述提交前瞬时 working-tree 状态无法仅凭事后 Git object 完整重建，但与 `43ffac97` 的变更内容和 reviewer 追加复审节的历史一致，未发现反证。
- **A7：发现一条 false-red major。** 即上列完整触发链／外部 gate 被“直接触发方不读 Y”错误排除的问题；除该项外，未发现会让正确状态无法通过的 blocker／major。

## 主观建议

未提出不影响定稿的主观建议；本轮按要求只报 blocker／major。
