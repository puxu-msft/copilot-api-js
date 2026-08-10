# 问题轴分组对抗性评审

评审范围：`/home/xp/.claude/rules/agents/62-docs-and-handover.md`、`/home/xp/.claude/rules/agents/63-engineering-practice.md`、`/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md` 中除 `mutation-baseline-must-contain-the-real-impl` 外的全部条目，仅检查 H1～H4。
已读取／执行的证据：逐条读取三份规则原文并手工双向对账“原条目 → Q 组”和“Q 组 → 原条目”；未运行代码或测试，因为本轮裁决对象是指令文本的触发问题与成员账目。
总体 verdict：修复 major 后可进入下一阶段。
blocker 数量：0。

## H1 · 名词轴残留

事实性发现：
[major] `/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md:14`、`/home/xp/.claude/rules/agents/63-engineering-practice.md:44` — Q3 仍由“不变量”名词聚合 — `scoped-invariant-written-as-global` 在提出／审查全称不变量时问作用域，`fix-at-the-shared-base-not-where-you-noticed` 在缺陷已出现、准备选修复层时问复用面；时刻与困惑均不同。
[major] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:11`、`:16` — Q4 仍由“文本改动”对象聚合 — `replacement-must-cover-what-it-restates` 在每次 replacement 设计／应用时核 span，`reread-docs-after-writing` 在整份文档完成后核最终整体；前者担心替换边界，后者担心全局自洽与遗漏。
[major] `/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md:28`、`:33`、`:36` — Q15 仍由“迁移期运行物”对象聚合 — 三条分别发生在 live path 切换前、配置变更后核运行进程持有值、以及决定过渡 symlink 的 Git 跟踪方式时；它们不是同一时刻的同一困惑。

## H2 · 该合而未合

事实性发现：
[major] `/home/xp/.claude/rules/agents/63-engineering-practice.md:42`、`:49`、`:59` — Q1 与 Q2 实为同一个 seam-compatibility 问题的主客体倒置 — 三条都在变更落地前问“相邻既有契约是否与这项设计互相冲突”；“谁碰坏谁”取决于叙述中的“我”，不是稳定的读者问题。
[minor] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:28`、`:32`、`:39` — Q5 与 Q17 不能整体视为同组或异组 — `stale-context-at-session-end` 与 `anchor-numbers-to-commits` 确实共享“时间变化后陈述还成立吗”，但 Q5 的 `kickoff-inherits-upstream-defects` 处理的是上游材料即使新鲜也可能带未闭合缺陷；因此两组只有部分重合。
[minor] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:32`、`:41` — Q6 与 Q17 还存在未承认的同题关系 — 两者都在写入易变事实时问“怎样避免把快照固化成长期错误”，差别只是一个选择文件寿命层、一个选择数字表达形态。
[minor] `/home/xp/.claude/rules/agents/63-engineering-practice.md:51`、`/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md:26` — Q11 与 Q14 不属于该合未合 — Q14 判断 oracle 是否只测静态代理而非执行结果；Q11 假定 check 本身可判，却检查失败退出码是否真的阻断 action。前者可正确而后者失效，反之亦然。

## H3 · 时刻错配

事实性发现：
[major] Q3、Q4、Q15 — 上述 H1 已分别给出“立 claim vs 选修复层”“逐 replacement vs 文档完稿”“切换前 vs 变更后运行态 vs Git 跟踪决策”的触发时刻差异；任一只点名单一时刻的 description 都会漏成员。
[major] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:28`、`:39` — Q5 的两条也相距过远 — 一条在长会话末尾刷新仓库事实，另一条在写 kick-off 前审上游评审债与全称行为；“上下文是否过期”召不回一份刚写完但仍有 blocker 的上游文档。
[minor] `/home/xp/.claude/rules/agents/63-engineering-practice.md:11`、`:13` — Q8 有较小但真实的时刻分叉 — structural smell 要求每轮／每阶段主动扫描并落纸，best-approach 明定轮末反思；若 description 只以“轮末复盘”召回，会把前者从阶段过程压成事后动作。

## H4 · 缺组与账目

事实性发现：
[major] 三份原文与待攻击清单 — “23 条（含两个子条）”计数错误 — `/home/xp/.claude/rules/agents/62-docs-and-handover.md` 为 5 个顶层条目 + 2 个子条目 = 7，`/home/xp/.claude/rules/agents/63-engineering-practice.md` 排除 mutation 后为 10，`/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md` 为 7，总计 24；当前 Q1～Q17 也实际列了 24 个成员。双向对账未发现遗漏或重复，错误在总数命题。
[major] `/home/xp/.claude/rules/agents/62-docs-and-handover.md:39` — `kickoff-inherits-upstream-defects` 被硬塞进 Q5 — 新鲜的上游文档同样可能有未闭合 blocker／major 或未经实跑的全称行为，故它不以“上下文过期”为前提。
[major] `/home/xp/.claude/rules/agents/64-concurrency-and-refactor.md:33`、`:36` — Q15 还硬塞了两条 — `environ-is-frozen-at-process-start` 适用于任何运行态配置核验，不要求迁移；`track-transitional-symlinks` 直接防的是 Git 清理删除过渡依赖，且原文明确现存进程不会塌、失败落在未来子进程。

主观建议：无；本轮按要求不评措辞、不提出归属方案。
