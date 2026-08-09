# C4 独立评审

**评审范围**：仅核对 `anchor-numbers-to-commits` 与数字证据规则的关系。

**已读取证据**：
- `/home/xp/.claude/rules/agents/62-docs-and-handover.md:32-34`
- `/home/xp/.claude/rules/agents/60-evidence-and-criteria.md:38-45`

**判定**：需要在 `anchor-numbers-to-commits` 一侧加限定语；底层规则互补，并无规范上的直接冲突。

`/home/xp/.claude/rules/agents/62-docs-and-handover.md:32-34` 管的是“是否把易变测量值写进文档”：默认不写值，确需写值才进入例外。`/home/xp/.claude/rules/agents/60-evidence-and-criteria.md:38-44` 管的是“值一旦写入，证据最低标准是什么”：必须带口径，并以不同原理交叉验证。因此后三条预设的只是条件分支，不要求文档必须含数字。

现行措辞仍有一个 major 级解释缝：`62:33` 单列“锚到 commit 或报告，并写明测于彼时”，容易被当成写值例外的完整条件；但 `60:38-44` 还要求路径、命令、commit 口径及两法交叉验证。尤其“锚到报告”并不保证该报告自身保存了这些证据，可能让一个只带日期或报告链接、未经交叉验证的值看似合规。

**具体改法**：在 `/home/xp/.claude/rules/agents/62-docs-and-handover.md:33` 末尾加一句：

> 本例外不替代 `60-evidence-and-criteria` 的数字证据门：值一旦写入，仍须带路径、重算命令与 commit 口径，并经不同原理交叉验证；锚到报告仅在该报告保存了这些口径与交叉验证证据时成立。

无需修改 `every-number-carries-scope`、`cross-check-with-two-methods` 或 `[hard]` 总门；它们作为“写入后”的条件规则继续成立。

**总体 verdict**：修复上述 major 后可定稿。**Blocker：0。**

## C4 复评

**成立。** `/home/xp/.claude/rules/agents/62-docs-and-handover.md:33-34` 先把写值列为例外，再明确声明该例外“不放宽” `/home/xp/.claude/rules/agents/60-evidence-and-criteria.md:39` 的 `[hard]` 门；锚 commit 已不再读成完整条件。

## C5

**未发现双源。** 当前磁盘上的 `/home/xp/.claude/skills/authoring-skills/SKILL.md:54-61` 并不存在题述“当场有界／跨任务产物／依赖产物”三问，而是明确以“是否需要程序检查并拦人”为准；`/home/xp/.claude/skills/authoring-skills/verification-log.md:13,28,65-67` 也是同一机械检查判据，二者对样本会给出相同结论。

若题述三问是尚未落盘的候选文本，则本轮无法核对该版本；它不能用来覆盖上述当前文件证据。

## C8

**[major] 分界对普遍条件句与情境做法存在双重归类。** `/home/xp/.claude/rules/00-user/21-git-workflow.md:15` 的 `never-push--the-user-does-that` 被 `/home/xp/.claude/skills/authoring-skills/SKILL.md:24` 明列为 rule，但它也可按 `SKILL.md:22,25` 读成“只在发布这一类任务中需要的做法”，从而被判进 skill；任一条件式全局约束都能同时写成“无论做什么，若 X 则 Y”和“做 X 时才需要 Y”。

**补丁措辞**：在 `/home/xp/.claude/skills/authoring-skills/SKILL.md:22` 后加优先级：“先看约束是否必须在触发行为发生前常驻：涉及权限／授权、不可逆动作、数据保护或指令优先级，漏召回一次就会越权或造成不可恢复后果的条件式不变量，仍进 rules；其余能由可识别情境可靠召回、主要提供步骤与方法的内容才进 skill。不要仅因命题可写成‘若 X 则 Y’就判为普遍，也不要仅因它只在 X 时执行就判为情境做法。”

**本轮 verdict**：C4、C5 可定稿；C8 修复 major 后可定稿。**Blocker：0。**

## C8 复评

**[major] 对 `never-push--the-user-does-that` 可判，但决胜判据仍不能稳定覆盖难例，因此整体不成立。** `/home/xp/.claude/rules/00-user/21-git-workflow.md:15-20` 的漏召回直接造成未经授权且事实上不可逆的发布，按 `/home/xp/.claude/skills/authoring-skills/SKILL.md:29-34` 明确留在 rules。

难例是 `/home/xp/.claude/rules/agents/60-evidence-and-criteria.md:38-45` 的 `verified-by-a-wrong-query`：漏掉一次，普通数字写错只需返工，但同一错误数字也可能支撑删除、迁移或发布，导致不可逆后果。现判据未说明按直接后果、典型后果还是最坏下游用途裁决；按最坏后果会把几乎所有质量方法留在 rules，按普通后果又会移走承重门。

**补丁措辞**：在 `SKILL.md:29` 后加：“只计算漏掉该条本身直接解除的保护，不把任意遥远下游用途算成后果；若同一条混有‘不可逆动作前的最低不变量’与普通方法，拆分归属：最低不变量常驻 rules，情境步骤与案例进 skill，并由 rule 以触发词指向。”

## C6

**未构造出反例，未发现 major。** 在用户已裁决“必做动作与纯文本流程允许、禁止的是实际验收设施”的定义下，两个方向闭合：

- 尝试“既有测试红则不得提交”：`SKILL.md:76-77` 将一次性运行既有判据视为必做步骤；它没有新装验收设施，不能再改称“实质门禁”而重开用户裁决。
- 尝试“人工 reviewer 批准后才继续”与“调用外部 approval service”：前者确会拦人，已被 `schema-rigor-without-gates` 的 `/home/xp/.claude/skills/authoring-skills/SKILL.md:50` 捕获；后者还被 `steps-are-not-gates` 的 `SKILL.md:63-70` 捕获。
- 反向尝试“脚本生成目录”“formatter 改写文本”“一次性 mutation 跑既有测试”：程序没有据结果作放行裁决，按 `SKILL.md:63-70,76-80` 仍是工具／步骤，两条都不会判为设施。

**本轮 verdict**：C6 可定稿；C8 仍需修复 major。**Blocker：0。**

## C8 三评

**成立，可定稿。** `/home/xp/.claude/skills/authoring-skills/SKILL.md:36-40` 已使 `verified-by-a-wrong-query` 得到确定归属：`/home/xp/.claude/rules/agents/60-evidence-and-criteria.md:39` 直接保护“交付物中的数字不得以无口径、未交叉验证的断言形态出现”，最低不变量留 rules；`:40-45` 的查询案例、AST 选型、行号复验与具体交叉验证流程拆入 skill。

同样难的 `/home/xp/.claude/rules/agents/63-engineering-practice.md:21-28` `mutation-baseline-must-contain-the-real-impl` 也可确定：`:21` 的“恢复基线必须含真实实现”及“不得从缺失实现的基线恢复”直接阻止不可恢复的数据丢失，留 rules；`:22-28` 的事故叙述、exact patch 构造顺序、reverse-apply check 与隔离 worktree 配方属于情境流程，进对应 skill，由短 rule 以 mutation／恢复触发词指向。

**Verdict**：C8 可定稿。**Blocker：0，major：0。**
