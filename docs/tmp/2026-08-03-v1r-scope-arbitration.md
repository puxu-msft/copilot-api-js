# V1R 判据范围裁决

## 争议清单与裁决资格

- 裁决资格：具备。我未参与被审会话、原 skill 文本或独立审计报告的编写。
- [1] bullet 2 的范围：**支持主会话异议的核心命题**——按 V1R 明定 oracle，它是封闭枚举；审计把它扩为任意支撑论断的结果，没有文本依据。但 skill 内部存在范围不自洽。
- [2] bullet 1 的 7 处 delegation：待下节裁决。
- [3] exposure 总数与 V1R：待下节裁决。

## [1] bullet 2 的范围

**裁决：支持异议方。** V1R 的直接 oracle 是 “When to use” bullets，而 bullet 2 是封闭枚举，不是开放例示。

独立证据：

1. `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:24` 原文是 “A test, lint, build, benchmark, or mutation result …”。它没有 `e.g.`、`such as`、`including`、`for example`、省略号或概括性上位词；括号中的例子只例示 claim 文案，不扩张 result 类型。
2. `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:170,176` 明定 V1R 只认 “exposure matching a ‘When to use’ bullet”，且称这四条 bullets 是审计的 “only input”。因此不能用别节更宽的语言暗中改写 exposure 集合。
3. 审计报告 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-closeout-audit-session-0205d11f.md:42-62` 列出的 16 处 acceptance 是 reviewer 结论、glob/keyword probe、`git show`、`git status`/diff、commit/hash/tally 等；没有一处被报告为 test、lint、build、benchmark 或 mutation。故这 16 处均不命中 bullet 2。

**内部不自洽发现：** `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:12` 的 Overview 写成所有 command，`:101` 写 “Every load-bearing Bash call”，`:136` 又写 “every command whose result supports a decision or a claim”，明显宽于 `:24` 的五类枚举；frontmatter `:3` 则用“result only means something if it ran in one specific directory”限定到目录敏感结果，并主要列错 checkout/tree 症状。宽泛 gate 指令不能覆盖 V1R 的明示 “only input”，但这种内文冲突足以解释审计者为何误读，属于判据文本缺陷。

**后续影响：** 从 V1R 分母删除 16 处 acceptance；不能用它们证成 falsification。

## [2] bullet 1 的范围

**裁决：六处成立，一处不成立；“没有第二份 `/home/xp/.claude`”不能排除该 trigger。**

独立证据：

1. `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:23` 的直接判据是 delegated work “must happen in a specific tree”。`:16` 定义的 snap-back 错误落点是 original tree，不要求存在同一仓库的第二份副本；`:55` 又实测 prompt-only delegate 会从 launching session cwd 开始。被审会话初始 cwd 是 `/home/xp/src/copilot-api-js`，而前六次 delegation 明确要求核验 `/home/xp/.claude` 的冻结提交，二者就是两个可能落点。目标仓库只有一份，不会让相对路径在错误 cwd 自动指向它。
2. 审计报告 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-closeout-audit-session-0205d11f.md:41,44-45,48,55,58` 对应的六次 `SendMessage` 均明确给出 `/home/xp/.claude` 与冻结 SHA，命中 bullet 1。`:63` 的第七次 `Agent` 不同：它读两个仓库中的绝对路径，并向项目绝对路径写报告，没有要求执行必须发生在某一个 specific tree；把它计入 bullet 1 没有事实基础。
3. frontmatter `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:3` 的四类目录写法比 bullet 1 窄，未明确说 `e.g.`，与 bullet 1 的 “specific tree” 存在同类范围不自洽。但 V1R 自己在 `:170,176` 把 “When to use” bullets 指定为唯一 exposure oracle；不能反过来用 description 缩掉 bullet 1 的明文命中。description 的窄化应作为待修缺陷，而不是审计时的隐藏豁免。
4. 受托 reviewer 确实执行过 skill 与 gate：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/0205d11f-6e73-4330-8784-9d7af59d8499/subagents/agent-ac98e4ac8c7a1a6a4.jsonl:8` 调用 `proving-where-a-command-ran`，`:37-39` 的命令逐次 `cd /home/xp/.claude`、打印 `pwd -P`／top-level／HEAD 并断言冻结 SHA。故这些 reviewer 结果的树来源有证据，不能说实际 review 在错树运行。

**但这不满足 V1R 的 invocation 时点。** `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:170` 与 `verification-log.md:65-73` 要求 delegation trigger 在交付工作前调用；bullet 1 面向的是 dispatcher 的派活决定，因为 dispatch-time 的 `cwd`／`isolation` 只能由 dispatcher 设置（SKILL `:57-61`）。delegate 在接活后、执行前自行 gate，能挽救执行与结果可信度，却不能追溯性地把 dispatcher 的 pre-delegation recall miss 改成 hit。因此六处是 exposure，且对被审主会话仍是六处 miss；同时，审计报告 `:67` 所称 delegated tree 未被 gate 证明是错误的，事实恰好相反。

**后续影响：** 保留六处 bullet 1 miss，删除第七处；把“recall miss”与“结果 provenance 无效”分开，不能由前者推出后者。

## [3] exposure 总数、V1R 与处置

**裁决：成立的 exposure 是 6 处，且全为 miss；V1R 仍然 falsifying，但原审计的 “23/23” 与其后果说明不成立。**

独立证据与计数：

- bullet 1：审计报告 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-closeout-audit-session-0205d11f.md:41,44-45,48,55,58` 的六次 specific-tree delegation 成立；`:63` 的双仓绝对路径审计不成立。
- bullet 2：同报告 `:42-62` 的 16 次 acceptance 都不属于当前文本枚举的五类，计 0。
- bullet 3：报告 `:65` 独立确认没有 cwd-sensitive cleanup，计 0。
- bullet 4：报告 `:65` 确认会话未以解释 reset notice 为目标，计 0。
- 所以总数为 `6 + 0 + 0 + 0 = 6`，且被审主会话在六个 delegation boundary 前均未调用该 skill。按 `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:77` 的既定 settlement，一次 falsification 即送回 prose；因此 V1R 的 falsification 结论仍成立，只是证据从 23 处缩为 6 处。

**审计报告需要纠正两点：** 将 V1R 从 “23 exposures / 23 misses” 改为 “6 exposures / 6 misses”；撤回 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-closeout-audit-session-0205d11f.md:67` 关于 delegated execution tree 未经 gate 证明的推论。V1R 测的是 skill 是否在规定边界前被主会话召回，不是 reviewer 最终证据是否可信。

**长期处置：两边都要改，但不应把本次冻结审计按新口径追溯重算。**

1. 由 `gpt-souls:instruction-smith` 修改 `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md`：把 bullet 2 明写为一个单一、可解码的口径。依 frontmatter `:3` 与 skill 核心目的，推荐口径是“任何**只有在特定目录／树运行才有意义**、且即将支撑 claim 的 command result”，并把 test、lint、build、benchmark、mutation 写成 `for example`；这既不会漏掉 cwd-sensitive `git status`，也不会把 cwd 无关的绝对路径 `git show <commit>`／hash／纯文本 reviewer 判断全收进来。同时将 Overview、`:101`、`:136` 与该目录敏感限定对齐，消除同一 skill 内宽窄冲突。若维护者反而决定只守五类，就必须同步收窄这些宽泛段落；不能保留两套范围。
2. 修改 `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md` 的 V1R exposure 记录要求：除 exact bullet 外，每项必须说明“为什么结果依赖 specific directory/tree”或 delegation 的“目标 tree 与可能错误落点”，并明确不得用 Overview／gate 节扩张 canonical “When to use”。这不是复制 trigger，而是给 auditor 一个可复核的分类证据门，可同时压 false-red 与 false-green。
3. 本轮六处 miss 是按修改前、冻结时的明文判据所得，仍应作为 V1R falsification 记录；未来修改后的 cohort 使用新口径，并记录文本版本／commit，避免跨版本混算分母。

## 价值观分歧

无。争议可由当前文本、transcript 与既定 V1R 协议裁决；不需要用户在 YAGNI／长期性之间另作选择。

## 附带观察

- skill 与 always-on rule 的范围也不一致：`/home/xp/.claude/rules/00-user/20-tool-use-preference.md:12` 已写成 “whenever a result is about to support a claim”，比 SKILL bullet 2 宽。它不改变本次 V1R 的明示 oracle，但应与上述 skill 修订一并对齐。此项不属于本次 V1R 数量裁决，不定级。
