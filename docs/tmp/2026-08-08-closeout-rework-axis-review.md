# Instruction text 独立评审

## 评审范围与证据

- 范围：commit `98be376f45a155b4768540c5c16ec52491167952` 对 `.claude/skills/session-closeout/SKILL.md`、`docs/memory/methodology-ff-only-refusal-is-not-a-conflict.md`、`docs/memory/MEMORY.md` 的全部改动。
- 已读取：上述三份最终文件；四个被引用 memory 正文；目标 commit 的完整 diff。
- 已执行：`git ls-tree` 实样；`git apply --directory=` 相对／绝对前缀对照；GNU `patch 2.7.6` 已反向补丁探针；Git `2.43.0` 的 divergent 与 dirty-path `merge --ff-only` 对照；wiki 链接存在性与 `.md` 后缀扫描。

## 总体 verdict

**修复 major 后可进入下一阶段。Blocker：0。**

## 事实性发现

[major] `.claude/skills/session-closeout/SKILL.md:53-70` — “归属轴 vs 返工轴”没有按同一判定对象形成两个可相反的轴；真正成立的是“来源域不同” — §3b 的 `长期价值（即该内容是否必须活过清理）` 已经包含“为避免后来人重做而应保留”的理由；§4 扩展的是扫描来源，从 `$CLAUDE_JOB_DIR/tmp` 文件扩到对话中的非文件知识。所谓反例“一份无接收者日志 vs 一条非文件知识”换了判定对象，不能证明两轴结论相反。真正可给出相反结论的是“最终用户交付物必须归档，但其证据不需要防重复推导”（归属是、返工否）；反向例只能通过把“patch 文件”与“从 patch 提炼的 recipe”换成两个对象得到，仍不证明独立轴 — 建议把 §4 定义为“第二个候选来源／语义回溯”，它负责发现非文件候选；候选是否持久化仍统一交给 §3b 已定义的长期价值与接收载体判据。删除“结论经常相反”或换成同一对象的真实反例；若找不到，就不可主张正交两轴。

[major] `.claude/skills/session-closeout/SKILL.md:53,59-70` — §3b 与 §4 因上述定义同时拥有“哪些证据值得持久化”的裁决权，构成可独立修改的重复判据 — §3b 要求为每个 tmp 项判 `长期价值`、接收载体与最终动作；§4 又要求四类各给“已被谁承接／本轮新写”，并用“会不会重做”决定是否写。以后修改“标定值是否值得留”时，执行者必须同步改两节，否则同一证据可能在 §3b 判可删、§4 判必写 — 建议指定单写入源：§4 只产出候选事实与来源，明确“把候选作为新增行送回 §3b 的 disposition／接收载体判据”；或把统一持久化判据抽到一处，两节仅引用。当前的“本节不覆盖返工轴”只声明不同，未消除裁决重复。

[major] `.claude/skills/session-closeout/SKILL.md:63-70` — 四类清单没有可执行的候选边界，且第 1 类是未降级的自评式硬门，false-red 会把它推成全量盘点 — 文本同时要求“逐条过这四类，每类给出……”和“别做全量盘点”，但没有规定从哪些当轮事件枚举候选；“绝大多数产物……扫过即可”反而确认要全扫。对真实场景“本轮出现一次 ff-only 拒绝”可判第 1／2 类应写，但对普通失败尝试，作者只能自判“下个人最自然反应”与“会不会重做”，没有可观察输入，也没有记录后独立裁决的闭环。建议把输入限定为本轮可枚举事件（否掉的路线、纠正过的因果、改错过的解析、产生或更新的标定值、实际跑过的 mutation），要求逐项 disposition；第 1 类改为可观察代理（是否曾据该反应执行错误／破坏性动作，或现有文档是否会引导该动作），其余主观项记录为 provisional，并在 §1 对本轮新增记忆统一评审。仅写“别全量盘点”不足以抵消前面的无界全称要求。

[major] `docs/memory/methodology-ff-only-refusal-is-not-a-conflict.md:8`、`docs/memory/MEMORY.md:35` — “`--ff-only` 不可能留下冲突态”作为无前提全称不成立 — 在 Git `2.43.0` 临时仓库先制造 3 条 unmerged index entries，再执行 `git merge --ff-only other`：命令以 rc=128 拒绝，前后 `git ls-files -u` 都是 3 条且逐字相同；它不会**新建**冲突态，但会保留调用前已有的冲突态。干净 divergent 与 dirty-path 对照均为 0 条，说明窄结论成立。按 A5 口径这是 major；修为“在调用前 index 无 unmerged entries 时，`--ff-only` 的这次拒绝不会创建冲突态”，诊断步骤先检查 `git ls-files -u`，若非空则那是前置状态，不能把所有拒绝归入文中的两个成因。同步修 MEMORY 钩子。

## 逐项核验回执

- **A1：不成立。** 见第 1 条 major；当前文本证明了扫描来源不同，没有证明同一对象上的两个正交轴。
- **A2：会制造双源。** 见第 2 条 major。结构怪味：`.claude/skills/session-closeout/SKILL.md:47,63-70`，类型为“同一持久化裁决重复实现”；处置为本轮修，统一单写入判据后再定稿。
- **A3：部分不可执行。** 四类名称能提示方向，但候选全集与第 1 类判法未闭合；见第 3 条 major。
- **A4：false-red 未被挡住。** “别把它做成又一次全量盘点”与“逐条过四类／绝大多数扫过即可”相冲突，没有可观察的限界；见第 3 条 major。
- **A5：三项确认、一项收窄。** `git ls-tree HEAD -- <path>` 实样为 `100644 blob <oid><TAB><path>`；`git apply --directory=.claude` 对校准后的相对前缀通过，而绝对前缀报 `error: invalid path`；GNU `patch 2.7.6` 对已反向补丁确实打印 `Assume -R? [n]` 与 `Apply anyway? [n]`（stdin 无输入时退出，不应把“必挂住”理解成无条件事实）；`--ff-only` 见第 4 条 major。
- **A6：目标均存在且语义匹配，无 major。** 三个 slug 分别支撑“通过性不自证”“mutation 必须证实生效”“隔离树的主线 fast-forward 边界”。`[[git-commit-pathspec-commits-worktree-not-index.md]]` 带后缀不符合主流写法（无后缀命中 9 处，带后缀共 3 处），但同库已有先例且目标存在，只是 minor 风格问题。
- **A7：体例满足，但必须随第 4 条同步修。** 钩子有触发症状、分型动作与防数据损失动作；长度显著高于邻项属 minor。其“结构上不可能留冲突态／两个真因”复制了正文的过强全称，修正文时必须同一语义改动同步。

## 计数与收口

- Blocker：0
- Major：4
- Minor：未按本轮要求展开；A6 的 `.md` 后缀与 A7 长度已在逐项回执标明。
- 主观建议：无。

# 复审轮（`4f3a10ed`）

## 评审范围与证据

- 范围：`git diff 98be376f..4f3a10ed` 的四份改动，重点复核上一轮 4 条 major 的闭环及整改新增缺陷。
- 已读取／执行：最终 `.claude/skills/session-closeout/SKILL.md:45-73`、最终 ff-only memory、MEMORY 钩子、完整整改 diff；全仓 grep “长期价值／持久化裁决／候选／返工”等重复判据。上一轮 Git `2.43.0` 三组探针继续适用，相关命令行为未再改写。

## 总体 verdict

**修复 major 后可进入下一阶段。Blocker：0。**

## 事实性发现

[major] `.claude/skills/session-closeout/SKILL.md:47,61,73` — “裁决权单归 §3b”尚不可执行，且 §4 又重新立了裁决 — §3b 的行 schema 强制要求“绝对路径、类型、清理前置条件”，非文件候选没有绝对路径，也没有可清理对象，无法按第 61 行“作为新增行送回 §3b”；第 73 行随后又在 §4 用两个代理判“死路值不值得写”，正是声称已经消除的第二套持久化裁决。修复建议：把通用 disposition schema（候选标识／来源、长期价值、接收载体或替代证据、最终动作）抽成唯一小节；§3b 的 tmp 文件行在其上追加路径／类型／清理字段，§4 的非文件行引用同一通用 schema；删除 §4 的本地“值不值得写”门，或明确它只产生 provisional 证据、最终仍由统一 disposition 裁决。

[major] `.claude/skills/session-closeout/SKILL.md:63-69` — 五类候选仍漏掉“本轮实际取得、未来无法从仓库静态重建的正向观察／能力边界”，会产生 false-negative — 例如首次探针直接确认某 runtime／外部 API 支持一种行为，既没有被否路线、错误因果或解析，也不是标定值或 mutation；若不保存探针条件、结果与能力边界，后来人仍会重跑调查。修复建议：增加受限第 6 类“本轮实际运行且支撑实施／裁决的外部或运行态探针结果”，只收无法由已提交代码、规范或 canonical artifact 廉价重建者；记录对象／版本／环境、命令、观察与不证明什么，避免扩大成全量知识扫描。

[major] `docs/memory/methodology-ff-only-refusal-is-not-a-conflict.md:8-16,34`、`docs/memory/MEMORY.md:35` — `git ls-files -u` 为空仍不能推出“只剩分叉／脏路径” — Git `2.43.0` 临时仓库制造冲突后把文件 `git add` 为已解决、但不提交 merge；此时 `git ls-files -u` 为 0，`git merge --ff-only other` 仍 rc=128：`fatal: You have not concluded your merge (MERGE_HEAD exists)`，前后仍为 0。这是第三种前置状态。并且 divergent 与 dirty-path 的 stderr 不同，前者才是 `Not possible to fast-forward`，后者是 `local changes ... would be overwritten`，当前正文把一个具体报错与两因混写。修复建议：先检查完整 `git status`／in-progress operation state，再查 unmerged entries；若有前置状态，只报告并确认归属，不能命令“先解决”（共享树可能属于别人）；状态干净后按实际 stderr 分流：fast-forward impossible→拓扑分叉，would be overwritten→重叠 dirty path。随后重跑，因为前置状态与分叉可以同时存在。

## 复审结论

- 上轮 major 1／2：方向已采纳，但因非文件候选无法填写 §3b 的文件专用 schema，且 §4 第 73 行再次裁决“值不值得写”，尚未闭合。
- 上轮 major 3：无界全量扫描已闭合；两个代理中“实际执行过”可由 transcript／操作记录观察，“文档或报错是否会引导”仍需语义判断，但 provisional + §1 独立评审足以避免作者自判。新增 false-negative 见本轮第 2 条。
- 上轮 major 4：原反例已正确吸收，但二分仍不完备；resolved-but-uncommitted merge 是确定反例，且“先解决前置状态”在共享树中越过归属边界。
- 结构怪味：`.claude/skills/session-closeout/SKILL.md:47,61,73`，类型为“通用 disposition 与文件专用 schema 混层，导致声明单源但实际双判”；处置为本轮修，因为它直接使非文件候选流程不可执行。
- Blocker：0。Major：3。总体 verdict：**修复 major 后可进入下一阶段**。
- 修复路由建议：instruction text 交 `gpt-souls:instruction-smith` 整改；Git 命令行为继续用临时仓库正反探针复核。

# 复审轮二（`a60ce4ac`）

## 评审范围与证据

- 范围：`git diff 4f3a10ed..a60ce4ac` 的四份改动，并 grep 最终 skill／memory／MEMORY／CLAUDE.md 的同源表述。
- 已复用的独立实测：Git `2.43.0` 临时仓库中，`status` 含不重叠 staged 修改时 `merge --ff-only` 可成功；resolved-but-uncommitted merge 时 `ls-files -u` 为 0 但命令因 `MERGE_HEAD` 拒绝。

## 总体 verdict

**修复 major 后可进入下一阶段。Blocker：0。**

## 事实性发现

[major] `.claude/skills/session-closeout/SKILL.md:61,74` — §4 产出的 provisional 候选没有可达的独立裁决时点 — 收尾固定顺序是 §1 → §3b → §4；第 61／74 行要求这些在 §4 才生成的行“进 §1 独立评审”，但 §1 已经执行完，也没明确要求回跳。因此执行者可以走完整个顺序，却留下未裁决候选并进入 §5 提交／§6 交接。修复建议：在 §4 末尾加机械闭环“候选行全部写入同一 manifest → 回到 §1 对本轮新增行评审 → 0 blocker／0 major 后更新 disposition → 才进入 §5”；同时说明是否需要重审既有 tmp 行，避免把非破坏性新增候选误写成清理清单全量作废。

[major] `.claude/skills/session-closeout/SKILL.md:70` — 第 6 类仍在独立评审之前用“无法……廉价重建”做作者自评式过滤，遗漏项永远进不了 provisional 清单 — “廉价”没有外部阈值；同一个运行态探针，作者可凭“规范里能推”不列，而接手者可能因版本／环境条件仍必须重跑。它与第 61 行“本步只产出候选、不判值不值得留”冲突。修复建议：候选边界改成可观察事件，例如“本轮实跑且其结果支撑了实现、裁决或交付断言的运行态／外部探针”全部列 provisional；是否可由代码／规范／canonical artifact 重建，作为通用 disposition 的“不可变替代证据”字段交独立评审裁决，而不是候选前置过滤。

[major] `docs/memory/methodology-ff-only-refusal-is-not-a-conflict.md:10-15,37`、`docs/memory/MEMORY.md:35` — “判据是 status 干净／状态干净后才按 stderr 分流”是 false-red，普通 dirty status 并不阻止 fast-forward — 独立探针中，当前分支有与候选改动不重叠的 staged 文件时，`git merge --ff-only candidate` rc=0，快进成功且 staged 修改保留。若另有不重叠 dirt 同时发生拓扑分叉，当前文本会因 status 不干净而卡在前置状态，读不到真正的 `Not possible to fast-forward`。修复建议：`status` 只用于识别并确认归属“正在进行且会阻止新 merge 的操作”，不是 clean gate；随后始终执行／读取这次 `--ff-only` 的实际 stderr。`would be overwritten` 再定位重叠 dirty path，`Not possible...` 再判分叉；不重叠 dirt 不处置。同步修改 MEMORY 钩子的“判据是 status 干净”。

## 复审轮二结论

- 通用 schema 与文件追加字段的分层已闭合；非文件候选现在能填写全部通用字段及来源／复现方式，未发现新的双源裁决。
- “不自行解决前置状态”本身正确且不会无故卡死；问题是把任何 dirty `status` 都当成必须先处理的阻断门。正确下一步应是确认 in-progress operation 归属，同时仍按本次命令实际 stderr 行动。
- 三处一致性：ff-only memory 与 MEMORY 钩子同步，但同步复制了 `status 干净` 的过严判据；skill 第 6 类与同段“全部 provisional”存在内部冲突。
- 结构怪味：`.claude/skills/session-closeout/SKILL.md:61,70,74`，类型为“候选发现后回跳评审缺失 + 筛选职责泄漏到发现层”；处置为本轮修，因为会分别产生未裁决交付与静默漏项。
- Blocker：0。Major：3。总体 verdict：**修复 major 后可进入下一阶段**。
- 修复路由建议：instruction text 交 `gpt-souls:instruction-smith`；Git 判据继续保持“读实际命令输出”，避免再新增全局 clean gate。

# 复审轮三（`185236d1`）

## 评审范围与证据

- 范围：`git diff a60ce4ac..185236d1` 的四份改动，并 grep 最终 skill／memory／MEMORY／CLAUDE.md 的同源表述。
- 已走查：按最终六步顺序模拟“tmp 中有 mutation patch，§3b 初看可删，§4 才发现 mutation 记录粒度不足、patch 承重”的正确样本；复用 Git `2.43.0` 前述正反探针核对 ff-only 文本。

## 总体 verdict

**存在 blocker。Blocker：1。**

## 事实性发现

[blocker] `.claude/skills/session-closeout/SKILL.md:49,63,71,78` — provisional 评审虽已移到 §5 前，但仍晚于 §3b 的不可逆删除，正确状态会被流程自身毁掉 — 固定顺序让 §3b 在第 49 行“持久化／评审 → 清理精确路径”，之后 §4 才发现非文件候选；而第 71 行明确承认 mutation 记录粒度不足时 tmp patch 本身承重。具体场景：§3b 单看 patch 已有 Git object 而判删，§4 回溯 mutation 后才发现需靠 patch 重建精确变异，此时唯一 patch 已删除，补派评审只能发现损失、不能恢复。修复建议：把 §3b 拆成“枚举但暂不删”与“统一 disposition 后清理”；顺序改为 §3b inventory → §4 非文件候选 → 合并 manifest 独立评审 → 持久化并验证接收载体 → 清理精确文件 → 复扫 → §5。或把 §4 候选发现整体前移到 §3b 删除门之前；不能只把评审放到 §5 前。

[major] `.claude/skills/session-closeout/SKILL.md:63` — “没有新增 provisional 候选时才免”让候选完整性仍由作者自判，零候选时恰好没有独立方检查漏项 — 这是通过性／空结果不自证：作者漏掉第 2、3 或 6 类事件后会得到“0 行”，并据豁免跳过唯一能发现遗漏的补审；流程可形式合规但 false-green。修复建议：补审不因 0 行豁免；零候选也提交“六类逐类 0 + 本轮命令／裁决事件范围”的清单，由独立 reviewer 审核候选发现完整性。若要避免重复派审，应把这份零／非零清单在第一次 §1 前生成并纳入该轮，而不是由作者自行豁免。

## 复审轮三结论

- 第 6 类两个事实可观察到足以进入候选：命令执行可由 transcript／日志确认，“被用于实施或裁决”需指向具体 downstream 动作或裁决句才能复核；当前通用“来源（本轮哪个事件）”字段可承载该指针，未另报 major。
- ff-only 文本两个方向均已闭合：in-progress operation 只报告并确认归属，不要求清理普通 dirt；实际 stderr 决定后续，重叠 dirt 由 Git 报告。三处 grep 表述一致，未发现新的成因全称或 clean gate。
- 结构怪味：`.claude/skills/session-closeout/SKILL.md:49,63-78`，类型为“发现依赖晚于不可逆消费”；处置为本轮修，因为会删除后来才被证明承重的唯一证据。
- Blocker：1。Major：1。总体 verdict：**存在 blocker**。
- 修复路由建议：instruction text 交 `gpt-souls:instruction-smith`，重点重排 §3b／§4 的动作依赖，而非再补局部例外。

# 复审轮四（`7a5430f7`）

## 评审范围与证据

- 范围：`git diff 185236d1..7a5430f7` 及最终 `.claude/skills/session-closeout/SKILL.md:45-82`；按“§4 新发现 tmp patch 承重，评审决定保留”与“六类均为空”两条路径第一人称走查。

## 总体 verdict

**存在 blocker。Blocker：1。**

## 事实性发现

[blocker] `.claude/skills/session-closeout/SKILL.md:49,63-67,77` — 删除已正确后移，但 §4 新候选经评审判定应保留后，没有回到“持久化／提交并验证接收载体”的动作 — 第 49 行只在 §4 **之前**执行持久化与验证，之后是补审 → 清单评审 → 删除；具体正确样本中，§4 发现 mutation 记录粒度不足、tmp patch 承重，补审同意保留，但流程没有要求把 patch 接收到项目、提交并验证，仍可直接进入删除。修复建议：把顺序写成 inventory／初始 disposition → §4 发现 → 候选补审并更新 disposition → **按更新后的完整 manifest 持久化／提炼、提交并验证全部接收载体** → 完整 manifest 独立评审 → 删除；或明确补审后必须回跳第 49 行的持久化门且重新审更新后的完整清单。

[major] `.claude/skills/session-closeout/SKILL.md:61,65-67` — “六类逐项说明为何为空”不足以让独立 reviewer 判出漏项，因为候选事实只在父会话对话里，而 reviewer 默认看不到该对话 — 作者可以漏掉一次被纠正的因果，再在空清单写“第 2 类：无”；若评审输入只有该清单与仓库，独立方没有 oracle，仍只能审作者自述。修复建议：补审 prompt 必须提供可检查的本轮事件源，例如父 transcript 绝对路径（或完整导出的相关 transcript／tool-call 时间线）及六类扫描范围；reviewer 要从该来源独立枚举，再与清单双向 diff。确实无法提供事件源时，空结论只能标“未验证”，不得授权删除可能承载该知识的 tmp 项。

## 复审轮四结论

- §3b 等 §4、§4 不等删除，不构成互等死锁；“§4 补审前一个文件都不删”本身不过严，补审完成后仍可按 manifest 精确删除并复扫。
- 新缺陷在补审后的接收载体闭环缺失，而非删除门本身。
- Blocker：1。Major：1。总体 verdict：**存在 blocker**。
- 修复路由建议：instruction text 交 `gpt-souls:instruction-smith`，将发现、裁决、持久化、验证、删除写成单向依赖链。

# 复审轮五（`2853f437`）

## 评审范围与证据

- 范围：`git diff 7a5430f7..2853f437`、最终 `.claude/skills/session-closeout/SKILL.md:45-86`，以及调用方提供的父 transcript、job tmp 根和候选清单。
- 独立枚举：按关键词与末段时间窗切片父 transcript，定位本轮提出候选、六轮整改与复审事件；用 Python `Path.iterdir()` 独立确认 job tmp 为 56 个普通文件。`fd -H` 只返回 42 项，因为仍忽略 14 个 gitignored 文件；本轮没有拿该错误查询否定冻结人口。

## 总体 verdict

**存在 blocker。Blocker：2。**

## 事实性发现

[blocker] `.claude/skills/session-closeout/SKILL.md:53,65-71` — 回流只覆盖“tmp 项被重新判定承重”，没有覆盖“非文件 provisional 候选经补审判定应持久化” — §4 的中心对象正是非文件知识；补审若判一条被纠正的因果或死路值得留，第 53 行不会触发，流程也没有要求写入 memory／skill／正式文档、提交并验证载体，随后即可进入清单评审与删除。核心目标仍可形式合规地丢失。修复建议：回流条件改为“补审令任一 disposition 的接收载体／最终动作发生变化，或批准任一非文件候选持久化”；统一回到持久化／提炼 → 提交并验证**全部**更新载体 → 完整 manifest 重审，不能只写 tmp 项。

[blocker] `.claude/skills/session-closeout/SKILL.md:49,71` — 明知拿不出独立事件源时，文本只要求标“形式复核”，却没有禁止该结果满足删除前的 0 blocker／0 major 门 — 一份无 oracle 的形式报告完全可能写 0 major，第 49 行随后允许删除；而候选完整性正决定 tmp patch／日志是否是唯一承重证据。这是确定的未核验删除路径。修复建议：事件源不可独立枚举时 fail-closed：该轮不得给候选完整性放行票、不得删除任何 tmp 项；只能先持久化所有可能承重项，或取得可审事件源后再闭环。

[major] `.claude/skills/session-closeout/SKILL.md:71,75-86` — 双向对账要求本身可执行，而且本次实跑已发现调用方候选清单漏项 — 父 transcript `:11444` 之后除 ff-only／ls-tree 外，还明确发生并被纠正：伪“两轴”与双源裁决、不可达补审点、自证空清单、`status 干净` false-red、先删后发现、审出承重无回流、reviewer 无独立 oracle。这些分别命中第 1／2／3 类，但调用方只列 ff-only memory 与既有标定／mutation 承接。多数内容已由本评审报告、最终 skill 或 `methodology-ordering-gate-needs-a-trigger-that-reads-it.md` 承接，所以不是新增数据丢失；但仍须逐项进入候选 manifest，写明“已有载体／无需新增”，否则当前“清单已完整”结论不成立。

## 复审轮五结论

- 回流条款对“tmp 项重新判承重”这一条路径闭合，更新行、提交验证载体、旧评审作废、完整清单重审均已写明；缺口是非文件候选与无 oracle 分支。
- 独立事件源方案实际可用：无需整读 transcript，按末段时间窗、六类关键词和 review task notifications 可重建事件集合；本轮双向 diff 确实咬出多项漏列，证明它不是走过场。
- 结构怪味：`.claude/skills/session-closeout/SKILL.md:53,65-71`，类型为“统一 disposition 的回流条件仍按 tmp／非文件对象分叉，且 oracle 缺失时 fail-open”；处置为本轮修，因为两条都能越过删除门。
- Blocker：2。Major：1。总体 verdict：**存在 blocker**。
- 修复路由建议：instruction text 交 `gpt-souls:instruction-smith`；用统一的“disposition 是否变化”驱动回流，并让无独立 oracle 的删除门 fail-closed。

# 复审轮六（`a2b37589`）——候选双向对账补充

- 证据源：父 transcript 末段 `:11444-11856`；按评审通知、整改摘要及关键词切片独立枚举，未整读全文。
- ① ff-only 安全诊断／exact reverse patch：命中 transcript `:11444`，已列，承接匹配。
- ② `git ls-tree` 列序取证陷阱：命中 transcript `:11444`，已列，承接匹配。
- ③伪“两轴”、④不可达裁决点、⑤自证空清单、⑥过严 clean gate、⑦先删后审、⑧缺回流、⑨无 oracle、⑩按对象类型分叉：均在 `:11458-11856` 的评审／整改链中可独立枚举，已列；新 memory 的表格逐项承接。
- **漏项 A（第 1／2 类）**：§3b／§4 “两处各判”与非文件候选无法填写文件 schema，不能只并入③伪“两轴”或⑩对象分叉；它是“声明单源、实际双判／schema 混层”的独立被否路线，见既有报告首轮第 2 条与复审轮一第 1 条。新 memory 七形态没有这一格。
- **漏项 B（第 1 类）**：四类清单最初无候选边界、死路判据为作者自评；后又以“无法廉价重建”在第 6 类入列前自评过滤。二者促成“六类可枚举事件＋一律 provisional”，不等同⑤空清单或⑨无 oracle；新 memory 未承接。
- **第 4 类（标定值）“无新增”不属实**：本轮新增并反复修订了 job tmp 人口观测；调用方称“56 项冻结人口”，本次独立 `Path.iterdir()` 复算也是 56，而 `fd -H` 只得 42（仍漏 gitignored 文件）。这至少是一条新增口径／工具能力边界，应列 provisional，并指向既有 56 项 manifest／终审记录作为接收载体。
- **第 5 类（mutation／正负控）“无新增”属实**：末段整改没有实际注入新的 production mutation；“patch 粒度不足则承重”只是规则示例。Batch 1b 既有 mutation／floor 双控已在 dispositions 与 progress 承接，不是本轮新增。
- **第 6 类（运行态／外部能力探针）“无新增”不属实**：本轮 reviewer 实跑 Git `2.43.0` 的 unmerged-index、resolved-but-uncommitted `MERGE_HEAD`、divergent／dirty-path stderr、不重叠 staged dirt fast-forward，以及 GNU patch／`git apply --directory` 行为；这些结论直接驱动多轮裁决。① memory 承接其大部分，但候选清单应显式 disposition，不能以“已写进①”代替入列。
- 结论：10 项清单仍漏 A、B 与第 4／6 类新增事实；第 5 类无新增属实。

# 复审轮七（`8ba962df`）
- 对账范围：父 transcript 末段 `:11444-12043`，按候选关键词、评审通知与整改摘要切片。
- 12 项流程／事实候选均能在事件源定位，且分别由 ff-only memory 或九形态 execution-seam memory 承接。
- 第 4 类已列 job tmp 56／42／56 人口与 `fd -H` ignore 陷阱；第 6 类已列六项 Git／GNU patch 探针及版本边界；第 5 类无新增。
- **diff 为空：未发现新的漏列候选。** `Server error mid-response` 后恢复同一 reviewer、缩小任务并逐条落盘属于既有 agent 运维纪律的应用，不是本轮新增知识。
