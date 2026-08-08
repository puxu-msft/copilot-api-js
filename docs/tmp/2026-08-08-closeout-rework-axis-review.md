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
