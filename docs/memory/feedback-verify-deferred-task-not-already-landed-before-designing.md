---
name: feedback-verify-deferred-task-not-already-landed-before-designing
description: "在并发密集的仓库里,「暂缓/backlog」是时间点声明、可能已被 peer 会话落地或在做;为一个自以为暂缓的任务写设计/handoff 前,先 grep 现码 + RFC 状态行核实当前状态;发现撞车别急着删自己刚写的分析"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 79ff48bb-02b7-4df3-a1f9-06f727721113
  modified: 2026-07-20T19:17:57.303Z
---

为一个**自以为「暂缓/backlog」**的任务投入写设计文档 / handoff 前,**先核实它当前真实状态**——在并发密集的仓库(本项目常有多 agent 会话同时改),docs/memory 里的「暂缓」「待本 RFC 实现期做」是**写下那一刻的时间点声明**,peer 会话可能已把它**落地**或**正在实现**。核实动作:`git log --oneline` 扫近期 commit、`grep -rn <关键机制名>` 现码、读对应 RFC/spec 的**状态行**(不是正文——正文常是历史问题描述,状态行才反映当前)。

**Why(本会话踩坑)**:用户问「reaper 空转缺陷④ 值得修吗」,我据 RFC 正文「暂缓」判定它未做,花了整轮写完整 standalone RFC(`stale-reaper-cancellation.md`)+ 自包含 HANDOFF kick-off。派 subagent 复审时它跑 `bun run typecheck` 报 5 个 `reaper-cancel` 缺键错——才发现**并发会话早已把 ④ 实现了 ~80%**:`stream.ts` 的 `StreamReaperCancelError` + guard `reaperSignal` 已 landed(commit `d6eacf0`),设计权威是 `pre-response-abort` RFC 的 C4 行、状态行明写「④ 已落地」。我的整份 RFC 从一开始就是对已完成工作的重复。等我再看时全特性已 landed + 演化出 `dispatch-cancel` 第四 provenance。

**第二个错(用户直接纠正)**:发现撞车后我**立刻 rm 掉自己刚写的两份文档**说「避免两份打架 RFC」。用户当场纠正「你为什么删除自己写的 RFC?找回来,拿它和同伴版本做对比」。**教训:发现与 peer 撞车时,先保留自己的分析做多轮对比**(哪边决定更对、自己有没有 peer 遗漏的独有资产),对比清楚再决定删/并/存档——别以「去重」为名单方面抹掉未对比的工作(呼应 `no-destructive-workspace-loss`:自己写的分析也有对比价值)。最终该 RFC 被正确**归档**到 `docs/archive/2606-landed-rfcs/`(landed RFC 的正确归宿),不是删除。

**How to apply**:
- 动手写设计/plan/handoff **第一步 = 核实当前状态**:`git log --oneline -20 | grep <topic>` + `grep -rn <机制标识符> src/` + 读 RFC **状态行**。一条命令的成本 << 写整份重复 RFC。
- 「暂缓」的可信度校准:docs/memory 是二手时间点声明(`secondary-source-is-not-instruction`),并发仓库里尤其易过期;`architecture-health-first` 说真实资源泄漏/可观测撒谎必须修,peer 往往已经在修。
- 撞车 = 先对比不先删:多轮 subagent 对比 + 亲自核验决定性主张(本次实测确认 peer 的 provenance-first 比我的「Phase 1 单折 fetch」更对——后者会给 Responses-via-fallback 引入过渡期假 `complete`),再决定删/并/存档。
- 是 [[feedback-verify-named-target-resolves-before-large-work]] 的时间维度姊妹(那条查「目标是不是对的东西」、本条查「这事是不是已经做了/正在做」);并发协作纪律见 [[feedback-merger-yields-but-merge-must-happen]] [[git-commit-pathspec-commits-worktree-not-index.md]]。
