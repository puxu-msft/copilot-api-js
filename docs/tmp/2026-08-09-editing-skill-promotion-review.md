# 「精确编辑文件」skill 扶正评审
评审范围：`/home/xp/.claude/skills/editing-files-precisely/{SKILL.md,verification-log.md}`、`/home/xp/.claude/rules/agents/62-docs-and-handover.md` 的目标子条目、`/home/xp/src/copilot-api-js/docs/memory/{methodology-edit-then-verify-then-commit-never-one-call.md,MEMORY.md}`，以及相邻 skill `making-a-gate-actually-fire`、`positive-control-your-tests`、`improving-user-proposals`、`verifying-authoritative-claims`、`authoring-skills`、`proving-where-a-command-ran`。
已读取／执行的证据：读取上述当前文件；执行 `git -C /home/xp/.claude diff -- …`、`git -C /home/xp/src/copilot-api-js diff -- …`，并用 `git show HEAD:docs/memory/methodology-edit-then-verify-then-commit-never-one-call.md` 取得旧版记忆全文；同伴的 `moving-shared-head-is-not-failure` hunk 仅识别、未纳入裁决。
总体 verdict：存在 blocker；压缩后的 always-on rule 未独立保住“静默删除”方向，修复并复评后方可定稿。
blocker 数量：1。其余计数：major 0，minor 1，nit 0。

## 事实性发现
[blocker] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:16` — K2：不打开 skill 时仍可静默删除 — 规则把可执行约束只写成“凡要保留／重述的原文，`old_string` 都必须覆盖到”，这只约束新串引用的来源，未要求 `old_string` 中“非有意删除”的内容必须回到 `new_string`。具体绕过：用“标题 + 正文”作 `old_string`，`new_string` 只放改写后的正文；作者本意只改正文，却漏回标题，工具成功且规则内没有差集／对称白名单要求能在下刀前判否。建议把双向白名单留在 rule：`new_string` 的非新增内容须来自 `old_string`，且 `old_string` 的非有意删除内容须在 `new_string` 中保留或重述；skill 再展开机械手法。
[minor] `/home/xp/.claude/skills/editing-files-precisely/SKILL.md:3` — K5：相邻路由不完整 — “判断内容该不该改”并不总归 `improving-user-proposals`／`verifying-authoritative-claims`；skill 的结构、description、rule↔skill 归属属于 `authoring-skills`。另一个会被本 skill 的“脚本称成功但目标文件没变”症状抢走的邻居是 `proving-where-a-command-ran`：写盘可能发生在另一 checkout／路径，而不是根本未发生。`positive-control-your-tests` 的临时变异恢复路由与 `making-a-gate-actually-fire` 的通用门路由正确。

## K1 · 旧规则逐条对账
R1 覆盖面匹配、保留／重述原文与双向失败：压缩 rule 第 16 行 + skill 第 12–17 行；“本次新写内容例外”在 skill 第 12 行。
R2 标题／列表行首／表头锚点、两次事故：压缩 rule 第 16–17 行 + skill 第 19 行。
R3 行差集只允许有意增删：skill 第 21 行。
R4 单文件全文、区间外同内容、完整行／连续块的候选检查：skill 第 27–31 行。
R5 固定窗口与只比首尾两种失效、来源判断只能辅助：skill 第 33–38 行。
R6 逐文件逐 span、预期／实际次数不等即停：skill 第 40–43 行。
R7 frontmatter `---\n---` 反例及复验：skill 第 45 行。
R8 工具只验唯一命中、不验区间外重叠，且通读才发现：压缩 rule 第 17 行 + skill 第 8、51–53 行。
旧规则三处都找不到的条款：无；但 R1 虽在 skill 完整存在，压缩 rule 自身的双向保护不闭合，故触发 K2 blocker。

## K1 · 旧记忆逐条对账
M1 编辑／验证／提交分调用、验新文本、提交后查 tree：skill 第 47–49 行 + stub 第 8–10 行。
M2 assert 全在写盘前导致全部丢弃但 commit 继续：skill 第 51 行。
M3 两个本仓 commit 实例及“评审而非自查发现”：stub 第 12–17 行；通用摘要亦在 skill 第 51 行。
M4 `bash -n`／smoke 无判别力及关联教训：skill 第 53–56 行 + stub 第 21 行。
M5 每 replacement 计数、逐次写盘或一次一处：skill 第 42–43、57 行。
M6 提交信息逐句 grep、错误提交后显式纠正、提交信息的权威声音风险：skill 第 58–59 行 + stub 第 19–21 行。
旧记忆三处都找不到的条款：无。

## K3／K4
K3：第四节与 gate skill 是有意的“通用形态→具体配方”重叠，不是重复定义；gate `/home/xp/.claude/skills/making-a-gate-actually-fire/SKILL.md:37-53` 拥有控制流、fail-open 与退出码通则，editing skill 第 47–61 行拥有文件编辑配方。两者处方一致：gate 第 53 行要求会落盘的动作单独确认，editing skill 要求提交前单独验证；第 61 行的边界声明足以写清权威分工。
K4：description 对 (a) `old_string`、(b) 段落消失、(c) 提交声称磁盘不存在均为逐字命中；反向覆盖第一至第五节的下刀、候选检查、批量 span、落盘与引用漂移，未发现会永久召不回的成员场景。

## 结构怪味扫描
扫描范围为新 skill 五节、压缩 rule、stub／索引及上述相邻 skill；判据为重复权威、职责错位、抽象泄漏。除 K5 的路由缺口外，第四节的重叠已有清晰“通则／配方”分工，不记重复实现 backlog。

主观建议：无。


## K 复评
评审范围：仅复核 `/home/xp/.claude/rules/agents/62-docs-and-handover.md:16-21` 的 K2 修复及其 false-red 方向；已读取修后规则与 `/home/xp/.claude/skills/editing-files-precisely/SKILL.md:1-4`。
总体 verdict：仍存在 blocker；K2 尚未闭合。blocker 数量：1。

1. **K2 未闭合。** 路径是：`old_string` 圈一段正文或“标题+正文”，`new_string` 置空或大幅缩短，作者把所有消失内容自称为“有意删除”；②只约束“非有意删除内容”，而“有意”没有要求在下刀前形成可复核的明确删除集合，因此同一作者既分类又受约束，②可被一句自称整体豁免。建议改为：下刀前逐项写明本次有意删除的内容；`old_string` 中只有该预先列明集合允许不进入 `new_string`，其余必须保留或重述。这样才能区分“真要删整段”与漏回标题。
2. **当前措辞不会直接制造 false-red，但补闭合时须保留合法出口。** 真要删除标题／整段时，只要在下刀前明确列为有意删除，就应通过；不得写成“`old_string` 所有内容一律必须进入 `new_string`”，否则会误杀合法删除。


## K 三评
评审范围：仅复核 `/home/xp/.claude/rules/agents/62-docs-and-handover.md:16-22` 的 K2 闭合性与 false-red 方向；总体 verdict：可定稿，blocker 数量：0。
1. **K2 已闭合。** “下刀前先写明”已经要求把删除集合外化为先于编辑存在、可由人读取的文本；“我心里想过了”不是“写明”，事后把消失内容补称为本意也被第 19 行明确排除。写在何种人类可读载体、给谁看不影响这条时间与可见性约束，无需再规定 schema、登记处或门禁；未找到只读该规则仍可合规造成意外静默删除的路径。
2. **未引入假红。** 真要删除标题时，在下刀前把该标题或对应段落明确列入有意删除集合即可；①不约束纯删除，②也明确允许预先列明集合不进入 `new_string`。
