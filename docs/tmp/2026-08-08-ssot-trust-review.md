# SSOT／moving HEAD／session-closeout 指令对抗评审

## 结论记录（逐条闭合）

### PASS-1：一个权威来源允许多处语境完整复述

最终文本明确把“权威来源”与“文字只能出现一次”分开：英文生效规则 `/home/xp/.claude/rules/00-user/41-doc-mgmt.md:9-11` 允许 README、DESIGN、API、skill、handover、kickoff、memory 按读者需要完整解释，同时要求同一权威引用与冲突回正；中文权威源 `/home/xp/.claude/rules/00-user_zh/41-doc-mgmt.md:11-13` 给出同义约束。项目投影 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/CLAUDE.md:14`、交接 skill `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/.claude/skills/session-closeout/SKILL.md:57-61` 与模板 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/.claude/skills/session-closeout/handover.md:82-98` 均落实为“可完整复述＋必须引用＋易变内容同基线同步”。错误状态方面，无权威指针、基线不一致或内容分岔会被一致性门及 V6 判红（`SKILL.md:130,157`）；正确状态方面，稳定且执行首步必需的完整复述被明确允许，不会再因“重复”本身误拦（`SKILL.md:130,157`）。

### PASS-2：类型／明细／进度写入权仍唯一

英文规则 `/home/xp/.claude/rules/00-user/41-doc-mgmt.md:10` 与中文权威源 `/home/xp/.claude/rules/00-user_zh/41-doc-mgmt.md:12` 逐项保留 type owner＋consumer re-export、detail→derived summary、active progress ownership transfer 三类单写入机制；项目规则 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/CLAUDE.md:14,40` 再次钉住类型 owner 与唯一写入源。进度转移有可执行动作：先折入 HANDOVER，再把旧 progress 标为取代并停止更新（`SKILL.md:115-118`）；V14 将“旧 progress 仍继续更新”判为失败（`SKILL.md:166`）。因此允许解释性复述不会让第二写者合法化；反向也不会把带权威引用的说明误判成双写。

### PASS-3：无关 HEAD 前进不触发重复全量复验

英文生效规则 `/home/xp/.claude/rules/00-user/01-core-principles.md:17-18` 先列明具体升级信号，再限定无关 peer commit 不使既有证据失效、不产生新收尾边界，并把复验收窄到受影响范围；中文权威源 `/home/xp/.claude/rules/00-user_zh/01-core-principles.md:19-20` 同义。session-closeout 的查-peer 动作没有被删除，而是改为“命中相关路径／契约／测试基础设施或出现失败／矛盾才复验”（`SKILL.md:134-140`）；HANDOVER 与 KICKOFF 模板同样写明相关变化条件（`handover.md:15,96-98`）。错误状态方面，真实失败、矛盾、相关路径／契约／测试设施变化仍会触发受影响范围复验，避免 false-green；正确状态方面，无关 HEAD 前进不再触发重复全量门，避免 false-red。交付／发布时项目规定门仍运行一次（两份 user-rule 的 `moving-shared-head-is-not-failure`），没有把“先信任”扩大成“永不复验”。

### RETRACTED PASS-4：初始窄范围扫描未见 live 残留，后由 MAJOR-3 推翻

对最终的项目 CLAUDE、`.claude/`、`docs/memory/`、英文与中文 user rules 运行定向检索：`rg -n --glob '!docs/archive/**' --glob '!docs/tmp/**' ... '(同一事实只写一处|同一事实只能出现一次|只放...指针|只留...指针|不复制...(状态|事实)|唯一事实源|single source of truth|only...(pointer|once)|never restat|不得复述|绝不复述)' ...`。命中逐项 disposition：`CLAUDE.md:14` 与两份 user-rule 是对旧误读的否定；`feedback-one-authority...:12` 是事故叙述；`methodology-time-base...:13` 是历史实例；`handover.md:87` 只允许高 churn 细节用指针；`CLAUDE.md:23` 是 API／DESIGN 的具体内容分工，不把该约束泛化到所有语境；`verification-log.md:103` 是旧观测记录而非当前规范，且明确说明修法已并入新 memory。未发现仍要求“同一事实只能出现一次”或“所有复述一律删成指针”的 live 命令。反向检查也保留了必要的具体归属：端点字段详情仍由 API 维护，progress 内容仍限定为 git 记不下来的三项（`SKILL.md:114`），没有以消除绝对禁令为由取消边界。

### MAJOR-1：KICKOFF 的 moving-HEAD 摘要漏掉三类全局复验触发器

全局规则把复验触发器定义为：实际失败、相互矛盾的证据、相关路径／契约变化、异常 merge／integration 结果、会改变结论真假的条件陈旧、用户明确要求核验（英文 `/home/xp/.claude/rules/00-user/01-core-principles.md:17-18`；中文 `/home/xp/.claude/rules/00-user_zh/01-core-principles.md:19-20`）。session-closeout 的查-peer 正文保留了“失败／矛盾证据／相关变化”（`SKILL.md:137`），但紧接着要求 KICKOFF 写成“**只有**真实失败或基线后相关路径／契约／测试基础设施变化才复验”（`SKILL.md:140`）；模板标题和槽位也只保留“真实失败或相关变化”（`handover.md:96-98`）。这会把“异常 merge／integration 结果”和“不体现在相关路径 diff 中、但会改变结论真假的环境／版本／运行实例条件陈旧”排除在 KICKOFF 的字面触发器之外。错误状态可通过：例如依赖版本或运行实例变了，但相关路径未变且尚未显式失败，接手方按“只有”不会复验；正确状态并不会因补回这两类具体信号而被误拦，因为无关 HEAD 前进仍不是信号。建议把 `SKILL.md:140` 与 `handover.md:96-98` 校准为全局规则的完整触发集合，至少增加“异常合并／集成结果、会改变结论真假的条件已陈旧、用户明确要求核验”；不要退回“任何新 HEAD 都复验”。

### PASS-5：中英文规则语义等价

逐条对照最终文件：`trust-first-but-keep-eyes-open`／`moving-shared-head-is-not-failure` 在英文 `/home/xp/.claude/rules/00-user/01-core-principles.md:17-18` 与中文权威源 `/home/xp/.claude/rules/00-user_zh/01-core-principles.md:19-20` 的前提、升级信号、受影响范围复验、交付门例外均对应；`one-authority-allows-contextual-restatement` 在英文 `/home/xp/.claude/rules/00-user/41-doc-mgmt.md:9-11` 与中文 `/home/xp/.claude/rules/00-user_zh/41-doc-mgmt.md:11-13` 的权威定义、完整复述许可、三类唯一写入机制、易变 provenance 与冲突处理均对应。脚本确认两组 canonical identifier 在两边都存在；英文子 bullet 标题没有逐字出现在中文是翻译结果，不构成语义缺失。false-green 方向未见英文放宽而中文仍禁止、或中文放宽而英文丢失单写入门；false-red 方向两边都明确禁止因 DRY／SSOT 削成裸指针。

### PASS-6：新 memory 与索引闭合

机械检查结果：`feedback-moving-shared-head-is-not-failure` 与 `feedback-one-authority-allows-contextual-restatement` 两个正文文件都存在，`docs/memory/MEMORY.md` 中各恰好命中 1 次（命令输出：`file=True index_count=1`）；最终索引位置为 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/docs/memory/MEMORY.md:88-89`，正文为 `feedback-moving-shared-head-is-not-failure.md:1-13` 与 `feedback-one-authority-allows-contextual-restatement.md:1-15`。两份正文 frontmatter 的 `name` 与文件 slug 一致，description 含可召回症状，正文分别链接对应全局权威规则；SSOT memory 另被 `methodology-downgrading-a-gate-needs-a-reachable-trigger.md:18` 反向引用。未发现孤儿正文、重复索引或断链。

### MAJOR-2：V6 的历史“证实”记录仍把完整复述当违规，和新判据同处 live verification-log

新 V6 已正确规定“权威引用＋语境完整复述”，并明确“多处完整描述本身不是缺陷”（`SKILL.md:157,166`）。但它的 live 记录文件仍保留旧判据下的正面结论：`verification-log.md:22` 把“KICKOFF 逐条复述 T1–T6”记为违反；`verification-log.md:67` 把判据细节只放 HANDOVER、KICKOFF 只有指针称为“判据起作用”，并把若复制判据视作本应避免的同步成本；`verification-log.md:81` 同样把“只属 HANDOVER，KICKOFF 无需动”记作 V6 成功。历史事实可以保留，但这些行没有标明“按旧 V6 口径、已被 2026-08-08 新判据取代”，而 `verification-log.md:2,6-12` 明确把本文件作为当前自验与毕业依据。错误状态能通过：后续维护者可能据旧“证实票”把完整 KICKOFF 再削回指针；正确状态会被误拦：带权威引用且同基线的完整复述仍会被旧记录叫作“归属越界”。建议不删除历史，逐条加 superseded 注记，并明确这些票不得计入重写后的 V6 新口径；新 V6 从 0 票重新观察。

### MAJOR-3：旧“同一事实只写一处”仍存在于明确标为 live 的实施计划（撤回 PASS-4）

扩大检索到整个 worktree 的非 archive 文档后，发现 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/docs/plan/2026-07-28-vocabulary-leaves-and-barrel-discipline.md:2-6` 明确标为“草稿、待用户裁决＋复审后定稿”，不是归档历史；其 `:172` 仍要求 coding-conventions 作为 SoT、DESIGN “留指针（同一事实只写一处）”。配套的 live 执行方评审 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/docs/plan/2026-07-28-vocabulary-leaves-review-claude.md:2-5,199` 也把该做法列为 N3 的修法。它们会在未来定稿／执行 N3 时继续把正确的带权威引用完整复述误拦为重复，直接违反 user-rule `41-doc-mgmt` 的新 `[hard]` 语义。先前 PASS-4 只扫描项目 CLAUDE、`.claude`、memory 与全局规则，范围不足；本 finding 撤回 PASS-4。其他命中可作为历史评审保留，但这份明确未完成且待执行的计划必须改成“coding-conventions 权威维护；DESIGN 可按架构语境完整概述并引用，易变细节才缩成指针”，其评审建议同步标为已被新规则取代。错误状态当前能通过，因为执行者照 live plan 会恢复旧禁令；正确状态会被该 plan 误拦。

## 最终判定

- **BLOCKER：0。**
- **MAJOR：3。** moving-HEAD KICKOFF 投影缺三类触发器；V6 live 自验记录仍按旧口径奖励裸指针；一份待定稿／执行的 live plan 仍保留“同一事实只写一处”。
- **MINOR：0。**
- **NIT：0。**
- 六项命题中，1、2、5、6 成立；3 的全局规则成立但 session-closeout 投影不完整；4 不成立。修复三项 MAJOR 后需重新评审最终文本，不能沿用本轮 PASS 直接定稿。

## Round 1 处置（主会话，2026-08-08）

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| MAJOR-1 KICKOFF 漏复验触发器 | B | 采纳 | `session-closeout/SKILL.md` 与 `handover.md` 已补全真实失败、矛盾证据、相关变化、异常 merge／integration、关键环境／版本／运行实例条件陈旧、用户明确要求；仍明确无关 HEAD 前进不复验。 |
| MAJOR-2 V6 历史记录奖励裸指针 | B | 采纳 | `verification-log.md` 新增 2026-08-08 口径重置；旧 V6 条目逐项标 `superseded`／不计新票，V6 从 0 票重新观察；V14 改为活跃写入权。 |
| MAJOR-3 live vocabulary plan 残留旧禁令 | B | 采纳 | `2026-07-28-vocabulary-leaves-and-barrel-discipline.md` 改为 coding-conventions 权威维护、DESIGN 可完整概述并引用；配套 review 建议同步标旧验收已被新规则取代。 |
| 扩域发现：全局 handover／finding skills 的同类绝对句 | B | 采纳（用户要求“全面修改规则和记忆”） | `/home/xp/.claude/skills/adopting-agent-findings/SKILL.md` 与 `writing-handover-docs/SKILL.md` 已校准为一个权威来源＋语境完整复述＋易变同步门；`rules/agents/62-docs-and-handover.md` 补 moving-HEAD 边界。 |

全部为会改变模型指令的 B 级处置；原 reviewer 负责复查整改事实，另派未卷入 reviewer 做最终 B 级合议。

## Round 2 复审（原 reviewer，2026-08-08）

### MAJOR-R2-1：V6 仍有一张旧“只有指针／无需同步”正票未标 superseded

`/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/.claude/skills/session-closeout/verification-log.md:16-17` 已声明所有 2026-08-08 前旧 V6 票不计新口径，`:23` 与 `:68` 也逐项标明 superseded；但 `:82` 仍以无 superseded 标记的 `V6 归属分工 — ✅` 保留旧正面裁决，并称“判据细节按分工本来就只属 HANDOVER，KICKOFF 无需动”。这正是 Round 1 MAJOR-2 要消除的误导形态。虽然顶部总括能供谨慎读者推断它属于旧票，逐票标注并未闭合，且同文件另两张旧票已逐项改写，会让这张未改的 `✅` 显得仍有效。错误状态仍可能据它把第一步所需内容削成裸指针；正确完整复述仍可能被旧“无需动”评价误拦。应把该条同样标为“旧口径、已 superseded、不计新 V6 票数”，并按新 V6 重述客观事实。

### MAJOR-R2-2：`adopting-agent-findings` 仍无条件复核每条 reviewer 事实，拆掉 moving-HEAD trust-first

全局生效规则 `/home/xp/.claude/rules/00-user/01-core-principles.md:18-19` 明确把 peer research reports／already-established success evidence 纳入先信任对象，只在真实失败、矛盾证据、相关路径／契约／测试设施变化、异常 merge／integration、关键条件陈旧或用户明确要求时复核受影响范围；无关 HEAD 前进不得触发重复全量验证。扩域后的 `/home/xp/.claude/skills/adopting-agent-findings/SKILL.md:13` 却仍要求 reviewer 给出的**每条**客观事实“独立核实，复核成立即采纳”，并以“复核很便宜”作无条件理由，没有 concrete-signal 门或对既有验收证据的保留。该 skill 正在处理 peer review report，直接落入全局规则点名的对象；更具体的旧流程会让模型在每轮复评和 moving HEAD 后重验全部已成立事实。错误状态方面，补 signal gate 不会放过新 finding：未建立的 reviewer 新事实可作为需要首次确证的 claim，已建立证据则在具体信号出现时范围化复核；正确状态方面，当前绝对句会把已确认事实反复判为“尚未采纳”。应区分“reviewer 新提出、尚无既有证据的事实须首次确证”与“已有验收证据的事实按 trust-first 继续采用”，并逐字接入全局升级信号。

### MAJOR-R3-1：`writing-handover-docs` 硬编码不存在的 `docs/TRACKING.md`，与项目权威路由冲突

扩域后的 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:21-23` 写死“本项目是 `docs/TRACKING.md`”，并要求任何交接待办都读该状态真相源；但目标 worktree 中该路径不存在（只读探针输出：`TRACKING missing`），项目规则 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/CLAUDE.md:14` 明确指定 `docs/DESIGN.md` 的“活的架构现状”表为当前活／wip／bypass／退役路径入口，再下到具体 spec／ADR。该全局 skill 把一个别项目示例误写成本项目事实，会使正确执行者第一步读不存在路径，随后可能自行造第二状态源；也会让“已核对状态”门无法通过。应改成机械可执行的通用动作：先读当前项目 CLAUDE／文档路由定位具名状态权威；本项目实例为 DESIGN 活架构现状及其所指 spec／ADR。`:40-42` 已把 TRACKING 降成示例，那里不构成问题。

### MAJOR-R3-2：`writing-handover-docs` 的“必须用命令验证”与其后的一手来源规则自相矛盾

`/home/xp/.claude/skills/writing-handover-docs/SKILL.md:23` 无例外规定交接件中每条“待做／已知缺陷／下一步”都必须“当场用命令验证”；但同一 skill `:63-74` 正确规定事实应取当前最强独立证据，并明确“用户裁定过 X”没有命令可跑，应回原话／ADR／记忆等一手来源，确实无法验证则标待验证。前一句是更早出现的加粗“判据”，模型可能据它误判后文的一手来源不合规，或编造一个 shell 查询冒充用户裁决证据；反方向也可能因后文例外而把可运行的仓库状态 claim 全部降成读文档。应把 `:23` 改为“逐条用当下最强独立证据验证；仓库／运行态 claim 跑命令，用户裁决回一手来源，无从验证则标待验证”，与 `:63-74` 逐字同轴。

### Round 3 已闭合项

- **Round 1 MAJOR-1 已闭合。** `session-closeout/SKILL.md:140` 与 `handover.md:96-98` 已逐项覆盖全局 `01-core-principles:18-19` 的六类 concrete signal，并保留“无关 HEAD 不复验／只复验受影响范围”，双向无新缺口。
- **Round 1 MAJOR-2／Round 2 MAJOR-R2-1 已闭合。** `verification-log.md:16-17,23,68,83` 现已把三张旧 V6 票逐项标为 superseded／不计票，并按新 V6 重述客观事实；未再发现无标记的旧 V6 正票。
- **Round 1 MAJOR-3 已闭合。** vocabulary live plan `:170-176` 与配套 review `:191-199` 均改为 coding-conventions 权威维护、DESIGN 可完整概述并引用；旧“只能留指针”明确作废。
- **Round 2 MAJOR-R2-2 仍未闭合。** `adopting-agent-findings/SKILL.md:13` 仍无条件要求逐条独立复核 reviewer 事实，未区分首次确证与已有验收证据，继续与 moving-HEAD trust-first 冲突。

### Round 3 严重级别汇总

- **BLOCKER：0。**
- **MAJOR：3 个未闭合。** R2-2（reviewer 事实无条件重验）、R3-1（硬编码不存在的 TRACKING）、R3-2（命令验证与一手来源自相矛盾）。

### MAJOR-R3-3：`session-closeout` 查-peer 的执行动作仍用“只有”漏掉三类全局升级信号

KICKOFF 投影已经补全，但其上游执行契约仍未完整校准：`/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/.claude/skills/session-closeout/SKILL.md:137` 规定“**只有**触及相关路径／契约／测试基础设施，或已出现真实失败／矛盾证据时”才范围化复核，遗漏全局 `/home/xp/.claude/rules/00-user/01-core-principles.md:18-19` 的异常 merge／integration、会改变结论真假的条件陈旧、用户明确要求核验。`:140` 只管 KICKOFF 应如何写，不能修复写方自己在生成 KICKOFF 前按 `:137` 漏做复核；于是文档可能完整列出触发器，当前交接事实却已经在漏检状态下写成。应把 `:137` 的“命中后的动作”同步为完整六类 signal，并继续限定只复核受影响范围；这不会让无关 HEAD 触发全量复验。Round 3 前述“Round 1 MAJOR-1 已闭合”需收窄为“**KICKOFF 文本投影已闭合，但相邻查-peer 执行契约未闭合**”。

### Round 3 补充处置状态

- **Round 2 MAJOR-R2-2 已闭合。** `/home/xp/.claude/skills/adopting-agent-findings/SKILL.md:10-15` 现已区分 reviewer 新事实的一次首次确证与已有代码／探针／验收／前轮证据的继续信任，并逐项接入六类升级信号；无关 HEAD 或重复复述不会触发从零重验。
- **当前 BLOCKER：0。**
- **当前 MAJOR：3 个未闭合。** R3-1、R3-2、R3-3。

## Round 4 复审（原 reviewer，2026-08-08）

### Round 3 三项整改核验

- **R3-1 已闭合。** `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:22` 不再硬编码不存在的 `docs/TRACKING.md`，而是要求先从当前项目 `CLAUDE.md`／文档路由定位具名状态权威，并正确点名 copilot-api-js 的 `docs/DESIGN.md`“活的架构现状”及其所指 spec／ADR；`:41-43` 仅将 TRACKING 保留为通用示例，不会覆盖项目路由。
- **R3-2 已闭合。** `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:24` 已把判据改成“当下最强独立证据”，机械区分仓库／运行态 claim 的命令或探针、用户裁决的一手来源、无法验证时标“待验证”；与 `:64-75` 的证伪式自审逐项同轴，不再诱导伪造 shell oracle，也不放过可运行的状态事实。
- **R3-3 已闭合。** `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/.claude/skills/session-closeout/SKILL.md:137` 的写方查-peer 动作现已完整覆盖真实失败、矛盾证据、相关路径／契约／测试基础设施变化、异常 merge／integration、会改变结论真假的条件陈旧、用户明确要求核验六类升级信号，并限定只复验受影响硬事实；`:140` 与 `handover.md:96-99` 的 KICKOFF 投影使用同一集合，无关 HEAD 前进仍不触发重复全量验证。

### 相邻契约复核

- `/home/xp/.claude/skills/adopting-agent-findings/SKILL.md:10-15` 明确区分 reviewer 新事实的一次首次确证与已有代码／探针／验收／前轮证据的继续信任，并使用同一六类升级信号；未重新引入 moving-HEAD 追验。
- `/home/xp/.claude/rules/agents/62-docs-and-handover.md:28-31` 要求收尾时刷新 HEAD、分支、工作树和项目状态权威，但明确该动作不因 shared HEAD 前进而推翻既有验收证据，复验升级回指 `moving-shared-head-is-not-failure`；“刷新交接当前状态”与“重复验收已合并特性”边界清楚。
- Round 1 的 V6 superseded、vocabulary plan／review 校准结论维持成立；本轮未发现整改引入的新 blocker／major，也未发现正确状态会被新条款误拦。

### Round 4 严重级别汇总

- **BLOCKER：0。**
- **MAJOR：0。**
- **结论：原 reviewer 复审通过；Round 1～3 的全部 blocker／major 已闭合，可进入未卷入第三方的 B 级最终合议。**

**Final status check：BLOCKER 0，MAJOR 0。** 实施计划状态“已完成（2026-08-08；原 reviewer 与未卷入第三方均 0 blocker / 0 major；待提交）”忠实对应本报告 Round 4 的 0／0 结论（`:115-117`）与第三方终审 `/home/xp/src/copilot-api-js/.claude/worktrees/revise-ssot-trust-408-skill/docs/tmp/2026-08-08-final-instruction-arbitration.md:30-32` 的“可定稿：0 blocker，0 major”；“待提交”未被两份评审报告反证。
