# 「把记忆扶正成 skill」落地评审

- 评审范围：`/home/xp/.claude/skills/making-a-gate-actually-fire/{SKILL.md,verification-log.md}`、`/home/xp/.claude/rules/agents/63-engineering-practice.md:51-53`、`/home/xp/src/copilot-api-js/docs/memory/methodology-gates-i-write-fail-at-the-execution-seam.md`、`MEMORY.md:37`；索引其余并发 dirty hunk 不在范围内。
- 已读取／执行的证据：两个仓库的当前 diff、两个旧版 Git 对象、四个当前文件；`git diff --check` 两仓均退出 0。未运行测试：对象是指令文本，无对应行为测试。
- 总体 verdict：修复 major 后可进入下一阶段。
- Blocker：0。发现计数：major 1、minor 2、nit 0。

## J1 · 零丢失逐条账
- M1 范围与共同根因（写 skill/rule/验收条款；门无人执行；指令错误静默生效）→ skill `SKILL.md:2,7-18`。
- M2 历史归属（`session-closeout`、六轮、2 blocker／十余 major、后续迁入位置）→ stub `:15`，轮次数也见 skill `:22`。
- M3 裁决点不可达 → skill `:26`；M4 自证空结果 → `:27`；M5 评审无 oracle → `:28`。
- M6 判定后无回路 → skill `:29`；M7 按对象类型分叉 → `:30`；M8 不可逆 fail-open → `:31`。
- M9 顺序写反 → skill `:32`；M10 声明单源实际双判及 schema 错位 → `:33`；M11 无边界与入列前自评过滤 → `:34`。
- M12 首次双向对账漏项、自述不构成独立枚举 → skill `:56-58`、stub `:13`。
- M13 补到 10 项仍漏两格、补后须继续对到 diff 为空 → skill `:60-62`、stub `:14`。
- M14 过严 clean gate／全局合取产生 false-red，修法是分型 → skill `:50-54`；M15 四问 → `:11-18`；M16 Related 路由 → stub `:17`。
- R1 批处理可能取消门、`check && action` → rule `:51`、skill `:38-44`；R2 管道依赖 `pipefail` → 同处。
- R3 换行不会短路 → rule `:51`、skill `:44`；R4 纯本地可逆操作可用 `&&`，落盘／发布／不可逆动作才可能要求拆调用 → rule `:53`、skill `:48`。
- [major] 三处均找不到：旧记忆中的“伪两轴”、`job tmp` 人口口径与 `fd` 枚举陷阱、Git／GNU patch 探针；旧规则中的 `batching-calls` 显式触发背景，以及“锚点校验 FAILED 但 commit 仍落地、错误归因被纠正”的实例。它们虽多为证据而非新判据，但 J1 要求全文零丢失，当前迁移不满足；将项目实例留 stub，通用 batching 实例留 skill。

## J2 · 不打开 skill
- [minor] 仍能绕过：纯本地可逆路径可写 `check; action`；它与换行同为无条件顺序执行，却未被压缩规则点名，门会消失。持久／发布／不可逆路径另有“拆调用”最低线，因此此绕过只落在返工级范围，不构成 blocker。

## J3 · 反向假红
- 未发现：rule `:53` 明确允许纯本地、可逆且退出码正确传播的 `check && action`；`:52` 还覆盖 `grep -c`／glob 把正确状态短路的反向错误。“限于会落盘……”是拆调用的必要范围，不是宣称所有写盘动作都必须拆。

## J4 · 召回
- 静态召回面同时覆盖两侧：description `SKILL.md:2` 明列“skill/rule 里的验收条款”和“同一次工具调用（`check && action`、管道、换行）”。反向测试未显示任一侧永远召不回，当前无依据拆 skill；真实 selector 表现尚未实测，`verification-log.md:22-28` 已诚实登记 B2 未决。

## J5 · 双源
- [minor] rule `:51-53` 与 skill `:38-48` 各自规范同一组 command gate、退出码和拆调用边界；stub `:7` 又把含工具调用在内的整套方法称为 skill 权威，但 rule 没声明自己是权威 restatement，当前权威边界不清。九形态本身无此问题：stub 只列名并明确指向 skill。
- 修复建议：明确切开所有权——rule 权威拥有“不打开 skill 也必须成立”的最低批处理约束，skill 权威拥有九形态、诊断流程和实证；stub 按该边界分别指向，不再把重叠部分笼统归给 skill。

主观建议：未发现。

## J 复评
- 复评 verdict：仍有 1 个 minor，修后可定稿；blocker 0。
- 1．J1 已闭合。按原 M1–M16、R1–R4 重跑：新增 stub `:16-18` 覆盖全部项目实例，skill `:48` 覆盖通用实证，rule `:51` 覆盖 `batching-calls` 背景；未发现三处都找不到的旧条款。
- 2．J5 的 rule↔skill 边界已闭合：rule `:52` 声明最低约束权威，skill `:38` 明示仅展开且冲突服从 rule，重复细节属于带权威的语境复述，不是第二裁决源。
- [minor] stub `:9` 却称“全部实证”归 skill，随即在 `:14-18` 声明本仓实例留 stub、不进 skill，自相矛盾；把 `:9` 收窄为“通用实证”，即可与现有权威边界一致。
- 3．J2 修复未引入新绕过或假红：`;` 仅在承担 `check→action` 成败门时被判无门，不禁止其用于无需短路的合法顺序命令；纯本地可逆门仍可用 `&&`，写盘／发布／不可逆动作仍按 rule `:54` 拆调用。
