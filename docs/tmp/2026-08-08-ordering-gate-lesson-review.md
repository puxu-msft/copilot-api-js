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


## 复审轮（`324c4419`）

### 复审范围、证据与 verdict

- 复审范围：`0a788890..324c4419` 的 4 个文件，重点核对原 major、三处同步表述、残余旧二分法及 A1 三要素。
- 已执行：读取完整 diff 与 `324c4419` 三处最终文本；全范围 grep 旧／新判据措辞；核对 commit `324c44197e8f662e3080e58dfcd0c2ae371bbadb` 及已提交评审报告。
- 总体 verdict：**修复 major 后可定稿**。
- Blocker：**0**。Major：**1**。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md:8,16,24` — 原 false-red 已消除，但中心判据反向写松：链上“有一环读取／编码 Y”只是必要条件，不足以证明 Y 真正门控 X。
证据／false-green：一条旁路 observer 可以读取 Y 只用于日志，scheduler 仍无条件放行 X；或 gate 读取陈旧 Y、失败时 fail-open、另一个 X 入口绕过它。现行 `:8` 因“并非整条链都没有读取”不会判其为假门；“问是否原子”也没规定答“否”时必须判红。` :16` 的“实测 gate 确实生效”未定义能区分上述错误状态的 oracle。
修复建议：把成立条件写成**控制依赖**而非存在性读取：每个 X 入口的放行都依赖权威且新鲜的 Y 谓词；Y 不满足／不可读时 X 必须被阻断；检查与放行原子，或有等价失效机制。因果事件方案还须证明事件只会在 Y 成立后产生且无替代触发路径。
验证至少双控：已知 Y 未完成时 X 被阻断，已知 Y 完成时 X 可通过；另枚举所有 X 入口验证无旁路，并让目标 gate 失效／读陈旧值确认判据变红。“实测过”本身不能替代这些可判别结果。
推荐修复方：`gpt-souls:instruction-smith`，修后继续由本评审者复核。

### 复核问题逐项结论

1. **false-red 已闭合，false-green 尚未闭合。** `:10` 正确保留上游因果事件和 scheduler／hold 两类合法门；但 `:8` 把“至少有读取”误当成足够接缝，留下上述旁路读取反例。
2. **外部 gate 出路仍太容易走。** “必须实测验证”方向正确，但缺少负控、正控、入口全集与失效／陈旧值对照；未来仍可用一个无判别力的 happy-path 探针自称生效。
3. **三处表述彼此一致，且旧二分法无残留。** grep 只在本评审报告的历史 finding 中保留旧措辞，这是 durable review record，不是活判据；memory 正文、`MEMORY.md` 钩子、verification-log 已同步。新缺陷是三处一致复述了同一个“读取存在性即够”的弱判据。
4. **A1 三要素仍齐全但判据未硬化完成。** 具体形态在 `:8,18-22`，本轮实例在 `:12,19-20`，可执行动作在 `:24`；然而动作尚不能拒绝“旁路读取／陈旧读取／fail-open／入口绕过”，故本轮仍有 major。


## 复审轮二（`5edcc54f`）

### 复审范围、证据与 verdict

- 复审范围：`324c4419..5edcc54f` 的 4 个文件；重点核对四种 false-green、合法因果事件的 false-red、三处语义一致性及 A1 三要素。
- 已执行：读取完整 diff 与 `5edcc54f` 的 memory 全文；以两组关键词扫描 `docs/memory`、`session-closeout` 与评审记录中的旧／新表述；核对 commit `5edcc54fa241adbc6a59e53efc23431caae4ad21`。
- 总体 verdict：**修复 major 后可定稿**。
- Blocker：**0**。Major：**1**。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md:12-15,19,38`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/MEMORY.md:34`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/.claude/skills/session-closeout/verification-log.md:168` — 四种 false-green 已被控制依赖与四项验收关掉，但四条被写成所有门都须同时满足的条件，仍会 false-red 合法的 happens-before／capability 门。
证据：若 Y 的权威 owner 只在完成后发出不可伪造的 permit／event，X 仅由消费该 permit 触发且无替代入口，那么 Y→X 已由因果能力编码；X 无须在放行时再读“Y 本身的真相源”。同理，若 `Y-has-occurred` 单调不回退，读取与放行无需原子也不会产生 TOCTOU。正文 `:15,19` 承认因果事件合法，却又以 `:12` 的直接权威谓词和 `:14` 的原子性为无条件前提；`MEMORY.md:34` 与 verification-log `:168` 更省略了因果事件条款，字面上必判红上述正确设计。
修复建议：把判据分成两种闭合形状，而不是四条全局合取。**状态门**须读权威且在放行点仍有效的 Y，fail-closed，并以原子 check-and-act、lease／generation token、锁或 Y 单调性消除竞态；**因果／capability 门**须证明 permit／event 只能由 Y 成立产生、不可伪造／不可从旁路产生、每个 X 入口都必须消费它。两类都保留负控、正控、入口全集和各自失效对照。
三处同步修订：索引钩子与 verification-log 必须明确“状态门或因果／capability 门”两种合法闭合形状，不能只保留“权威新鲜谓词＋原子”的状态门摘要。
推荐修复方：`gpt-souls:instruction-smith`，修后继续由本评审者复核。

### 复核问题逐项结论

1. **四种蒙混已实质关掉。** 旁路日志读取不满足“放行控制依赖”；陈旧读取违反有效性；fail-open 违反 Y 不满足／不可读时阻断；入口绕过违反每入口与入口全集。机械判旁路日志时，沿每个 X 入口的数据／控制流检查 Y 的结果是否支配放行动作即可，单纯 observer 读取不能通过。
2. **仍有 false-red。** 对 live mutable-state gate，权威／有效／竞态消除要求正确；但把直接读 Y 与原子 check-and-act 强加给因果 capability 或单调历史谓词并不必要。正文虽提因果事件，四条的全局合取和两个摘要仍与它冲突。
3. **旧“直接执行者不读即假门”与“存在性读取即够”的活判据均无残留。** 历史 finding 里的旧句是 durable review record，可保留。三处对状态门表述一致，但索引与 verification-log 遗漏正文的因果事件合法路径，存在上述实质不一致。
4. **A1 三要素齐全，可执行性仍差一个分型。** 具体形态在 `:10-19,32-36`，本轮实例在 `:21,33-34`，动作与验收在 `:23-30,38`；拿到 state gate 可判，但拿到合法 capability gate 会被互相冲突的 `:12-15` 判据卡住，故尚未完成硬化。


## 复审轮三（`f5e50554`）

### 复审范围、证据与 verdict

- 复审范围：`5edcc54f..f5e50554` 的 4 个文件；重点核对 A/B 分型、自洽性、穷尽性、机械判法、共同验收及三处同步。
- 已执行：读取完整 diff 与 `f5e50554` memory 全文；扫描三处活判据及历史 finding；以多前置部署门、线性一致副本两类正确设计分别做 false-red／false-green 对照。
- 总体 verdict：**修复 major 后可定稿**。
- Blocker：**0**。Major：**2**。

### 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md:30-37`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/MEMORY.md:34`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/.claude/skills/session-closeout/verification-log.md:168` — 共同“正控／负控”把 Y 错当成 X 的充分条件，且未要求观测结果确由目标门产生，既会 false-red 合法多前置门，也会 false-green 假门。
证据：若部署 X 同时要求 Y=测试通过与 Z=人工批准，Y 完成但 Z 缺失时 X 正确地仍被阻断；现行“已知 Y 完成时 X 确实放行”必判红正确门。反向地，在 Y 未完成且 Z 也缺失时 X 被阻断，可能全由 Z 门造成；一个完全不读取 Y 的假门也能通过负控。失效对照同样可能被兄弟门代咬。
修复建议：双控必须隔离目标机制。正控写成“Y 成立且所有其他独立前置均满足时，目标 Y 门不再阻断 X”；负控保持其他前置满足，只翻转 Y，并核对阻断来自目标 Y 门。失效对照须只破坏目标 gate／permit，并确认失败位置或 provenance 命中目标机制，而非仅看最终 X 没发生。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md:17`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/memory/MEMORY.md:34`；`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/.claude/skills/session-closeout/verification-log.md:168` — A 型把“权威”定义为必须直接读取 Y 真相源、排除任何副本／摘要，误杀具有可验证一致性／新鲜度契约的合法状态门。
证据：线性一致读副本、受 lease 保护的 materialized state、带 generation／version 并在放行时校验的快照，都可让读取结果在决策契约上等价于权威状态；它们物理上仍是“副本或摘要”，会被 `:17` 字面拒绝。正文 `:19` 又把 lease／generation token 列作合法竞态消除机制，形成内部张力。
修复建议：把“权威”定义为“该来源的契约足以裁决 Y，或其值可追溯／验证为权威状态且满足所需一致性与新鲜度”；拒绝的是**未经验证、可能滞后的副本／摘要**，不是副本这一载体本身。三处摘要同步避免“权威 Y”被未来读者按物理单写源理解。

### 复核问题逐项结论

1. **A/B 两型已解耦，上一轮串味闭合。** B 明确不要求放行时重读 Y；A 允许单调 Y 免原子 check-and-act。除“权威”定义过窄外，两型内部条件自洽。
2. **未发现需要新增的第三种闭合形状。** 调度 DAG、消息／回调、签名 token、物理可达性都可归入 B；锁／谓词／时间窗／配额可归入 A；混合实现可分别证明其承担顺序保证的 A 或 B 腿。当前缺陷在两型共同验收与 A 的来源定义，不在二分覆盖面。
3. **旁路 observer 判法可执行。** 对每个 X 入口验证 Y 结果是否控制放行，并用只翻转／破坏 Y gate 的对照确认其因果作用；但仅做静态 dominance 不足，须按第一条 major 隔离兄弟门。
4. **A1 三要素齐全。** 具体形态在 `:8-29,45-51`，本轮实例在 `:43,46-47`，判据／动作在 `:12-41,53`；分型本身可执行，但共同 controls 尚不能可靠裁目标门，故仍未完成硬化。
5. **三处 A/B 分型与翻车史一致，无旧活判据残留。** 历史 finding 保留旧措辞合理；本轮两条新 major 在三处摘要中同源复述，需同步修正。
