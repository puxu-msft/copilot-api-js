---
name: session-closeout-and-handover
description: 收尾与跨会话交接的唯一归属指针——六步清单、HANDOVER/KICKOFF 写法、产物入库纪律全在 skill `session-closeout`，本条只留触发钩子
metadata:
  type: feedback
---

**收尾（含跨会话交接）的 how-to 单一源是 skill `session-closeout`，不要在别处重写。** 本条是索引层的触发钩子：**看到「交付/报告/ExitPlanMode/提交前/任务跨会话/上下文将满」就去读那个 skill 的正文**（骨架另有 `handover.md` 模板），别凭记忆复述六步。

六步只记名字：① subagent audit ② doc-sync + 跨文档 grep ③ 归档 plan 与实验产物 ④ 提炼教训 + 维护记忆库 ⑤ 细粒度提交 ⑥ **跨会话交接**。唯一顺序例外：因「上下文将满」触发时 ⑥ 先做。

**Why:** 收尾是最容易「能复述规则却没落笔前过一遍」的一步；而交接（第 ⑥ 步）是 2026-07-27 那轮才补进去的——此前它只散在 user-rule 的 when（`handover-if-context-window-almost-full`）里，没有 how，于是每次交接都在重新发明写法，且反复付同样的学费：`/tmp` 里的 subagent 报告和探针输出**一重启就没**、共享 worktree 里未追踪的产物**离一次 `git clean` 只差一步**（那轮三份研究报告就是在提交前被并发清理抹掉、靠 `/tmp` 原件救回）。

**How to apply:** 别在这里找可执行细节——**全部动作、命令与判定纪律都在 skill 正文与 `handover.md` 模板里**，这条记忆只负责把你送过去。2026-07-28 双 reviewer 复审已把当时写在这里的三条摘要（产物入库、验收判据+证伪方式、写下自己犯过的错）连同更精确的动作收进 §6，摘要留在这里只会与正文各自漂移。

Related：[[methodology-background-agent-result-surfacing-failure]]（agent 结论必须落产物文件）、[[methodology-probe-conclusion-scope-and-peer-invalidation]]（探针产物必须写清「没有证明什么」）。
