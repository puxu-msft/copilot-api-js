# Instruction-text 评审报告

**评审范围：** `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md`、`/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/verification-log.md`，并对照 `/home/xp/src/copilot-api-js/.claude/skills/anthropic-precontent-recovery/SKILL.md`、权威 plan 与 user-level rules。结构怪味扫描覆盖触发边界、方法步骤、证据语义、自验升级门及跨 skill 权威边界。

**已读取／执行的证据：** 完整读取上述文件，以及 `/home/xp/src/copilot-api-js/docs/plan/2026-07-23-upstream-silence-recovery/README.md`、`/home/xp/.claude/rules/agents/{60-evidence-and-criteria,63-engineering-practice,64-concurrency-and-refactor}.md`；在绑定根目录 `/home/xp/src/copilot-api-js` 的命令中核对 frontmatter、规则物理行号、历史实例和易变配置值扫描。命令确认 `name_matches_directory=True`、description 含流程摘要；五条关联规则分别位于 64:14、63:50、63:52、63:57、63:67，两个判据位于 60:27-28；目标 skill 未写入四个当前配置值，而 plan README:19 记录了历史四个 terminator。

**总体 verdict：** 修复 major 后可定稿。

**blocker 数量：** 0。

## C1-C7 逐项核验

- **C1 已确认。** 五个实际 identifier 均存在，物理位置与 skill 引用一致：`scoped-invariant-written-as-global` 在 64:14；其余四个在 63:50、52、57、67。
- **C2 已确认。** `scoped-invariant-written-as-global` 防的是把成立作用域写大；本 skill 防的是只在部分机制落实，所述“方向相反且互补”成立。其余分工也与规则正文相符。
- **C3 已确认。** skill 只给一至两句职责摘要及指针，没有复制这些规则的动作清单或实例正文。
- **C4 已确认。** 历史形态与 plan README:19 一致；skill 未固化四个键值、当前告警或当前测试清单，只保留历史形态并指向权威 docs。与 `anthropic-precontent-recovery` 没有双源：后者维护 B2 稳定领域合同，两者共同把裁决原文归于 plan Global Constraints。
- **C5 已确认。** 两个判据名存在；“清单随发现增长”和“逐项都对仍可能在组合处留缝”的用法没有改变原口径。
- **C6 未完全成立。** `name`、四类触发、排除项及正文一致性均通过，但 description 明写“它给的是……的方法，取代……”，属于流程摘要，见 M1。
- **C7 未完全成立。** 三条件并不导致永远无法满足；一次明确记录的“skill 已存在但事前未召回”即可满足第 2 条。但当前文字把“存在时仍发生”直接等同“未召回”，判据并不等价，见 M6。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:2` — frontmatter 的 description 泄露了方法摘要 — “它给的是……建机制清单的方法，取代……”让模型可只按摘要行动而跳过正文，直接违反本轮 C6 的限定 — 删除这句流程说明，仅保留四类事件、具体症状和局部 helper 排除项。

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:24-31` — 第一步没有必需的可见产物，无法判定是否遵守 — “能拿着这句话去问”完全可在心内自评；执行者可直接填后续表而静默跳过，V2 也只能偶然观察到 — 把“结果式改写”设为 inventory 的必填表头／字段，要求先落下一句结果陈述，后续每个 producer 都显式指回它。

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:33-63` — “谁能产生结果”的 producer inventory 混入三类非 producer，方法合同自相矛盾 — `operator 告警`明说不制造违例，test fake 主要遮蔽证据，文档主要传播错误实现；但第三步又要求每层填写 producer 与“能否独立制造违例” — 保持 producer 表只收直接生产者；另拆“可观察性／oracle 忠实度／契约传播”核查表，分别定义可判字段。

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:13-20` — “普通局部 helper bug”排除项没有可观察边界，是最直接的合理化逃生门 — 一条产品不变量恰可在 helper 中被发现，执行者只要按修复位置命名为“局部”就能绕开 inventory — 明定触发优先级：涉及冻结不变量或完整落实声称时不得因代码位置局部而排除；仅当违例结果与所有已知 producer 都封闭在单一 helper 合同内且不作完整性声称时才排除，并要求写下这项 triage 结论。

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:89-93` — “不能证明什么”漏掉控制项的生产接线与代表性边界 — 五字段中的正负 control 可能只打到 fake/helper，逐层全绿仍不能证明真实入口读取了该机制，也不能证明覆盖了该层全部输入形态；现有三项只讲清单、层间缝和授权 — 增补“control 只证明其实际驱动的 witness，不证明生产接线或输入完备性”，完整性声称须用真实入口与独立 oracle 校准。

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/verification-log.md:21-25` — always-on 升级条件第 2 条把“skill 已存在”错误等同于“skill 未召回” — skill 可能已被召回但方法仍漏层；按现文仍满足字面条件，却应触发修 skill 而非升级加载层。第 37 行其实已要求记录是否召回 — 条件改为“缺口形成前未召回，且记录明确为否”；若已召回仍漏，则记为方法证伪并修 skill。这样仍可满足，不会造成永远不可能升级。

## 主观建议

无。上述六项均是可执行性或逻辑一致性的事实性缺陷；未发现 blocker。没有适用的成熟第三方机制可替代这一项目内判断方法，问题在指令合同本身而非重复造轮子。


## 复评轮

**评审范围：** 重新完整读取 `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md` 与 `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/verification-log.md`，只核六条闭合、修复回归、M3 双角色边界、M4 排除门及 description。

**总体 verdict：** 修复下列 major 后可定稿。

**blocker 数量：** 0。

**上一轮六条处置：** M1、M2、M4、M5、M6 已闭合；M3 的原始自相矛盾已消除，但拆表新引入了角色互斥问题。description 现只列触发事件和症状，没有残留流程摘要。M4 三条件未过紧：普通小 bug 只需留下可反驳的 triage 结论，不必先建完整 inventory；而冻结不变量与完整性声称优先触发的边界正确。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:44-64` — 表 A／B 被写成互斥类别，会漏掉同时扮演两种角色的具体机制 — 例如带自动 remediation 的 operator alert 既提供可观察性，也能直接终止请求；生成 schema 既传播“合法／推荐”契约，也可能给运行时供应违例默认值。按“表 B 项不产生结果、两表别混”会把其 producer 角色排除 — 明确分类对象是“角色”而非“artifact”：同一具体机制若兼具角色，须在两表各记一行；只禁止用表 B 字段替代其表 A producer 记账。

## 主观建议

无。除上述新引入的角色互斥缺陷外，未发现 blocker 或其他 major。


## 复评轮 #2

**评审范围：** 复核 `/home/xp/src/copilot-api-js/.claude/skills/enforcing-invariants-across-mechanism-layers/SKILL.md:43-67,123-130` 的双角色判据及形式主义风险。

**总体 verdict：** 可以定稿。

**blocker 数量：** 0。

**复评结论：** 上轮 major 已闭合。`SKILL.md:47` 把两个问题分别绑定到可观察谓词——“能否直接产生”与“是否遮蔽／传播”——并要求单表记录说明另一角色为何不适用；`SKILL.md:130` 又给出对应的正反观察形态，因此可以判定是否遵守。措辞没有要求所有机制完整填两表：不适用角色只需一句理由，只有双角色才重复记账，未形成形式主义式全量双填。

## 事实性发现

未发现 blocker 或 major。

## 主观建议

无。
