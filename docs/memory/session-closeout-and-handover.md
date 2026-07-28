---
name: session-closeout-and-handover
description: 收尾与跨会话交接的唯一归属指针——六步清单、HANDOVER/KICKOFF 写法、产物入库纪律全在 skill `session-closeout`，本条只留触发钩子
metadata:
  type: feedback
---

**收尾（含跨会话交接）的 how-to 单一源是 skill `session-closeout`，不要在别处重写。** 本条是索引层的触发钩子：**看到「交付/报告/ExitPlanMode/提交前/任务跨会话/上下文将满」就去读那个 skill 的正文**，别凭记忆复述六步。

六步只记名字：① subagent audit ② doc-sync + 跨文档 grep ③ 归档 plan 与实验产物 ④ 提炼教训 + 维护记忆库 ⑤ 细粒度提交 ⑥ **跨会话交接**。

**Why:** 收尾是最容易「能复述规则却没落笔前过一遍」的一步；而交接（第 ⑥ 步）是 2026-07-27 那轮才补进去的——此前它只散在 user-rule 的 when（`handover-if-context-window-almost-full`）里，没有 how，于是每次交接都在重新发明写法，且反复付同样的学费：`/tmp` 里的 subagent 报告和探针输出**一重启就没**、共享 worktree 里未追踪的产物**离一次 `git clean` 只差一步**（那轮三份研究报告就是在提交前被并发清理抹掉、靠 `/tmp` 原件救回）。

**How to apply:** 交接落 `docs/plan/<date>-<topic>/HANDOVER.md` + `KICKOFF.md`，**主树即时提交**（入口文档滞留特性分支等于没写；代码改动才进隔离 worktree）。三条最易漏的：**产物先 `git add` 再写引用它们的交接**；**每条待办带验收判据 + 证伪方式**；**把自己犯过的错与成因写进去**——只交结论会让接手会话重犯产出这些结论的错误。写之前先 `git log --oneline -20`，并发会话可能已经落地或推翻了你要交接的东西。

Related：[[methodology-background-agent-result-surfacing-failure]]（agent 结论必须落产物文件）、[[methodology-probe-conclusion-scope-and-peer-invalidation]]（探针产物必须写清「没有证明什么」）。
