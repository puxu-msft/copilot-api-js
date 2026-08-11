---
name: feedback-verify-deferred-task-not-already-landed-before-designing
description: "投入写设计/plan/handoff 前先核实当前真实状态——无论自以为「暂缓/backlog」还是用户要求实现某功能,并发密集仓库里它可能早已被 peer 落地;grep 现码 + RFC/DESIGN 状态行核实,别凭正文/记忆的时间点声明;撞车别急着删自己刚写的分析"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 79ff48bb-02b7-4df3-a1f9-06f727721113
  modified: 2026-07-20T20:49:23.245Z
---

为一个**自以为「暂缓/backlog」**的任务、**或用户直接要求「实现/全面重构某功能」**的任务投入写设计文档 / plan / handoff 前,**先核实它当前真实状态**——在并发密集的仓库(本项目常有多 agent 会话同时改),docs/memory 里的「暂缓」「待本 RFC 实现期做」是**写下那一刻的时间点声明**,peer 会话可能已把它**落地**或**正在实现**;用户要求的功能也可能**几周前就已 landed**、用户自己未必知道当前实现状态。核实动作:`git log --oneline` 扫近期 commit、`grep -rn <关键机制名>` 现码、读对应 RFC/spec/DESIGN 的**状态行**(不是正文——正文常是历史问题描述,状态行才反映当前)。

**Why(本会话踩坑)**:用户问「reaper 空转缺陷④ 值得修吗」,我据 RFC 正文「暂缓」判定它未做,花了整轮写完整 standalone RFC(`stale-reaper-cancellation.md`)+ 自包含 HANDOFF kick-off。派 subagent 复审时它跑 `bun run typecheck` 报 5 个 `reaper-cancel` 缺键错——才发现**并发会话早已把 ④ 实现了 ~80%**:`stream.ts` 的 `StreamReaperCancelError` + guard `reaperSignal` 已 landed(commit `d6eacf0`),设计权威是 `pre-response-abort` RFC 的 C4 行、状态行明写「④ 已落地」。我的整份 RFC 从一开始就是对已完成工作的重复。等我再看时全特性已 landed + 演化出 `dispatch-cancel` 第四 provenance。

**第二个错(用户直接纠正)**:发现撞车后我**立刻 rm 掉自己刚写的两份文档**说「避免两份打架 RFC」。用户当场纠正「你为什么删除自己写的 RFC?找回来,拿它和同伴版本做对比」。**教训:发现与 peer 撞车时,先保留自己的分析做多轮对比**(哪边决定更对、自己有没有 peer 遗漏的独有资产),对比清楚再决定删/并/存档——别以「去重」为名单方面抹掉未对比的工作(呼应 `no-destructive-workspace-loss`:自己写的分析也有对比价值)。最终该 RFC 被正确**归档**到 `docs/archive/2606-landed-rfcs/`(landed RFC 的正确归宿),不是删除。

**第二实例(2026-07-20,不同入口同一失误)**:用户问「若配置 model_overrides 把 opus 映射到 gpt-5.5,Anthropic endpoint 能否走 translate?」→「必须能,全面重构」。我走了整轮 brainstorming(多问答厘清 + 呈现方案 A 新建 openai-anthropic codec + 写完整 spec `docs/spec/anthropic-via-openai-translation.md` + 提交 af4af2b),**全程没先核实**。用户随后反问「项目经历了发展,spec 是否已实现?」——实测 [router.ts](../../src/lib/pipeline/router.ts) + [resolver.ts:186](../../src/lib/models/resolver.ts#L186) 才发现整套功能(`resolveModelTarget`/`@cc/@responses/@messages`/`model_mappings`/decideRoute 分层)**2026-07-11 就作为「通用翻译矩阵 Phase 0-7」全 landed master**([[project-universal-translation-matrix]]、DESIGN.md 活现状行、正式 RFC `2026-07-11-anthropic-via-openai-translation`),我的方案 A(新 codec)还被更优的 router 拆分 + hub-spoke 取代、我自定的「cc 优先」也被用户 2026-07-13 改成「responses 优先」。**教训拓宽**:不只「自以为暂缓」会踩,**「用户要求实现 X」同样必须先核实 X 是否已 landed**——用户未必知道当前实现状态,尤其大特性可能几周前就完成。核实成本(一次 `grep resolveModelTarget src/` + 读 DESIGN 状态行)<< 整轮 brainstorm + spec。

**第三实例(2026-07-27,反向失效:已被删除而非已被落地)**:接手一份 2026-07-22 写的交接文档「Request Lineage v2 后端 100% 完成、测试 108 pass,继续做 UI commit 5-9」。实测 `git rev-list --count $(git merge-base master feat)..master` = **2754 commits / 6 周**(merge-base 停在 2026-06-15),而 master 已于 **2026-06-29 `431d52d9` 把整个 lineage 子系统删除**(-2784 行,8 模块 + 2 张表 + REST + 108 测试),理由是实测「500 root ≈ 500 entry,真实流量零聚类;rootHash 折入逐 turn 漂移的 system[0]」。同期 master 还把 History 重写为 V3(`entries_v2` DDL 已不存在)、主服务器改 API-only 不再托管该前端。也就是说交接文档描述的"完成的后端"建在一个已退役的存储层上、且该子系统本身已被判死。**新失效模式**:前两个实例是「grep 到了 → 原来 peer 已做」,本例是「**grep 不到 → 极易误读成"还没做"**,实则是"做过、被否决、已删除"」。判别动作不同:前者 `grep -rn <机制> src/` 就够,后者必须 `git log --oneline <merge-base>..master -- <子系统路径>` 才看得见删除提交。另:交接文档写于 07-22 但描述的状态定格在 06-16,**交接文档的日期 ≠ 其断言的有效期**——有效期以断言被写下的那一刻为准。

**How to apply**:
- 动手写设计/plan/handoff **第一步 = 核实当前状态**:`git log --oneline -20 | grep <topic>` + `grep -rn <机制标识符> src/` + 读 RFC **状态行**。一条命令的成本 << 写整份重复 RFC。
- **恢复搁置分支/接手跨周交接时,第一个命令是 `git log --oneline $(git merge-base master <branch>)..master -- <该子系统路径>`**,不是读交接文档。它同时暴露「peer 已落地」与「peer 已删除」两个方向;单靠 `grep src/` 只能看见前者,后者会表现为"搜不到",被误读成"还没实现"。
- 交接文档/handoff 的**日期不是其断言的有效期**——「后端已 100% 完成」的有效期是它被**写下**的那一刻。跨周恢复时把它当二手时间点声明(`secondary-source-is-not-instruction`)重新核实,别当现状。
- 「暂缓」的可信度校准:docs/memory 是二手时间点声明(`secondary-source-is-not-instruction`),并发仓库里尤其易过期;`architecture-health-first` 说真实资源泄漏/可观测撒谎必须修,peer 往往已经在修。
- 撞车 = 先对比不先删:多轮 subagent 对比 + 亲自核验决定性主张(本次实测确认 peer 的 provenance-first 比我的「Phase 1 单折 fetch」更对——后者会给 Responses-via-fallback 引入过渡期假 `complete`),再决定删/并/存档。
- 是 [[feedback-verify-named-target-resolves-before-large-work]] 的时间维度姊妹(那条查「目标是不是对的东西」、本条查「这事是不是已经做了/正在做」);并发协作纪律见 [[feedback-merger-yields-but-merge-must-happen]] [[git-commit-pathspec-commits-worktree-not-index.md]]。
