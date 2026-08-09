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

## D1

**[major] 拆分并非零丢失。** 原 `/home/xp/.claude/rules/agents/63-engineering-practice.md` 的规范性条款逐项对账如下：
- “恢复基线含真实实现／不得从缺实现的基线恢复／动手前确认”在新 rule `:21`，并由 skill `:36-38,47` 展开。
- “exact patch 先构造再注入、同一冻结 patch 反向恢复；不得拿变异前 `git diff` 反向恢复；reverse check 失败或重叠即停问；构造不出就隔离；副本只作基线证明”在 skill `:42-47`。
- “共享树不得整文件恢复；只有结构性无同伴的隔离树可整文件恢复；瞬时 clean 不证明独占”在新 rule `:21-22`，skill `:38,47,49` 复述。
- “恢复后 diff 出现冻结 patch 外改动即停问”在 skill `:45`；“先提交实现或留变异前副本是两种合法基线路径”由新 rule `:21` 的 `git show`／diff 副本覆盖。
- **两边都找不到**原末句的“变异后再 `git status` + 全量回归复核”；skill `:15` 仅要求恢复后重跑当前测试，`:45` 仅查 diff，均不等价。应把该步骤补入 skill 协议末尾。

## D2

**[major] 只读新 rule 仍可破坏工作。** `/home/xp/.claude/rules/agents/63-engineering-practice.md:21` 只明禁“整文件恢复”；执行者可先按 `:23` 构造 exact mutation patch，却恢复时用 `git checkout -p`／IDE “Discard Hunk”选中该 hunk，抹掉同 hunk 内未提交实现或并发改动，字面上没有整文件恢复且未违反明文最低不变量。

最低不变量应改为：“共享工作树只允许反向应用**注入时那份冻结 exact patch**恢复；反向检查失败或与后续改动重叠就停下问用户。尤其禁止整文件覆盖，也不得用交互式 hunk restore 代替。”详细构造流程仍留 skill。

## D3

**未发现 false-red。** 新 rule `:22` 明确允许自己新建的隔离 worktree／`/tmp` 一次性仓库整文件恢复；前提仍是 `:21` 的基线含真实实现，这恰好排除隔离树中实现尚未进入恢复基线的危险情形。

## D4

现 description `positive-control-your-tests/SKILL.md:3` 明列 `git checkout`、`git restore`、snapshot copy 与“恢复变异”，能召回题给场景。相邻漏召回场景是“用 `git apply -R` 撤销临时 patch”或 IDE “Discard Hunk”：既未出现 checkout／restore／copy，也可能不叫 mutation；建议追加 `reverse-apply a patch`、`discard/revert a hunk` 触发词。

## D5

**未发现未声明双源。** skill `:32` 明确 rule `mutation-baseline-must-contain-the-real-impl` 是 authority，skill 是 operational protocol；rule `:21-23` 与 skill `:36-49` 对基线、共享树整文件恢复和隔离例外的复述目前一致。D2 所述是最低不变量覆盖不足，不是两处冲突。

**Verdict**：修复 D1、D2 major 后再复评。**Blocker：0，major：2。**

## D 复评

**D2 已闭合。** `/home/xp/.claude/rules/agents/63-engineering-practice.md:21` 已从“禁止若干危险恢复形态”改为“共享工作树唯一允许反向应用注入时冻结的 exact patch”，并要求 reverse check 失败或与后续改动重叠即停问。逐行手改、`git restore -p`、`git checkout -p`、IDE Discard Hunk、拿副本覆盖、从另一个 ref 恢复、重新生成一份看似等价的 patch，均不满足“注入时那份冻结 patch”，不能形成字面绕过；`:23` 指向完整协议。

**D1 已闭合，未发现仍在两边都缺失的原规范条款。** 对账结果：基线必须含真实实现及事前确认在 rule `:21`、skill `:36,49-56`；exact patch 须先构造再注入、不得反用事前 `git diff`、reverse check 与冲突停问在 skill `:42-43`；无法构造 patch 转隔离环境在 `:44`；副本仅作基线证据且不得覆盖共享文件在 `:49-56`；共享树白名单、交互式 hunk 禁令在 rule `:21`、skill `:47`；结构性隔离例外与瞬时 clean 不足在 rule `:22`、skill `:58`；恢复后 `git status`、`git diff`、异常停问及受影响全量回归在 skill `:45`；“先提交／冻结副本”两条合法基线路径在 skill `:49-54`。

**未发现新 false-red。** 共享树的手工／交互式恢复虽可能在某次碰巧安全，但无法机械保证不吞同 hunk 的未提交实现或并发 WIP，禁止符合最低不变量；exact patch 无法表达时，skill `:44` 提供隔离 worktree／throwaway repo 路径。结构上无同伴的隔离环境仍由 rule `:22`、skill `:58` 明确允许整文件恢复，前提只是恢复基线确含真实实现。

**Verdict**：D1、D2、D3 均通过，可定稿。**Blocker：0，major：0。**

## E1

**未发现旧版能召回而新版召回不到的场景。** 逐项对账：
- `authoring-skills` 旧版的“新写 skill／改结构、加验收设施、拆 references/scripts、概念命名与编号、散文还是脚本、三个相邻域路由”均由新版 `/home/xp/.claude/skills/authoring-skills/SKILL.md:3` 的域声明、非穷举场景及相同邻居分工覆盖；新版还补了改 description、rule↔skill 归属与拆分、扩充现有 skill。
- `positive-control-your-tests` 旧版的“关键绿灯承重、首次即绿、声称 verified、mutation 不咬、checkout/restore/copy 恢复、实现未提交、共享树／peer 编辑、patch/hunk 各种拼法”均由新版 `/home/xp/.claude/skills/positive-control-your-tests/SKILL.md:3` 的完整 mutate→observe→restore 意图、“undo a temporary source edit, in any spelling”及非穷举例子覆盖。

## E2

`authoring-skills` 新 description 覆盖全部 `##` 节：`skill-text-is-the-product`→“skill 该长什么样／内容放哪层”；`rules-hold-judgements-skills-hold-practices`→rule 或 skill 归属／拆分；`schema-rigor-without-gates`→验收设施；`slug-the-reusable-concept`→概念命名；`default-to-prose-not-script`→散文或脚本；`volatile-numbers-belong-in-commands`→“skill 该长什么样”的内容规范；“拆文件”→长到要拆；“description”→改 description／召回；“自验”→验收设施与 skill 形状。未覆盖节点：无。

## E3

**裁决编码忠实，未写弱。** `/home/xp/.claude/skills/authoring-skills/SKILL.md:198-202` 原样保留“接受误触发、拒绝漏召回”，并推出“不得为减少误触发收窄”“拿不准就触发”。“不适用”没有拆台：文本把它限定为已知邻居间的路由，而非抑制不确定召回；当前 description `:3` 的三个排除项也都有明确邻居，且不会排除“修改这些文档对应 skill”这一 authoring 意图。

## E4

**[major] “按意图写 → 失败可见”仍不成立。** 反例：`positive-control-your-tests` 因完整生命周期意图被正确召回，但任务是恢复测试运行时动态生成、随后手改的临时 fixture；正文恢复节只处理 source edit／Git patch。模型可以读完后直接自行恢复并退出，不报告“正文答不上”，调用方也看不到缺口。召回只使缺口**可检测**，不会自动使它可见。

建议把 `/home/xp/.claude/skills/authoring-skills/SKILL.md:190` 改为：“按意图写 → 失败可检测。skill 被召回后，若正文不能回答域内问题，必须显式报告缺口，并优先扩充这一份而非另起一份；只有完成这一步，失败才对外可见。”同时把 `:200` 的“没人会知道”保留给漏召回情形。

**Verdict**：E1–E3 通过；修复 E4 major 后可定稿。**Blocker：0，major：1。**

## F

**F1：通过。** `/home/xp/.claude/skills/authoring-skills/SKILL.md:202-203` 正确区分“未召回所以不可检测”与“召回后发现正文缺口所以可检测”，并把“当场说出没覆盖 X、优先扩充本 skill”写成必做动作；说出缺口会把执行者私有认知变成调用方可见事实。第三种情形是“skill 被召回且给出一个看似完整但实际错误的答案”，此时执行者没有检测到缺口；但这是正文正确性／事实核验问题，不是 description 的召回或域覆盖问题，不构成本判据的缺口。

**F2：通过。** 通用判据只在 `rewriting-drops-coverage-silently` 的 `SKILL.md:16-27` 定义；归属节 `:59` 只规定本场景要执行逐条对账，并明确把方法、双向核账要求和实证指回上节，没有另写一套比较轴或独立例外，未形成双源。指针同时包含触发时机“拆完”与目标 slug，足以召回。

**F3：通过，判据可执行。** 以本轮 `positive-control-your-tests` description 改写为样本：旧版可切成“关键绿灯承重、首次即绿、声称 verified、mutation 不咬、checkout／restore／copy 恢复、实现未提交、共享树／peer 编辑、patch／hunk 恢复”等召回场景；逐项对照新版 `/home/xp/.claude/skills/positive-control-your-tests/SKILL.md:3` 的完整 mutate→observe→restore 域、`undo a temporary source edit, in any spelling` 与非穷举例子，可机械列出每项仍有承载处，因而能判定本次零丢失。E1 已由本轮未卷入评审实际执行，证明它不是只可描述、不可操作。

**主观建议**：`SKILL.md:18` 的“每一次……都会丢掉”与本轮 E1 的零丢失结果字面冲突；宜改成“都可能静默丢掉”，但不影响 `:20-22` 判据的可执行性，按本轮口径不阻断定稿。

**Verdict**：F1–F3 全部通过，可定稿。**Blocker：0，major：0。**
