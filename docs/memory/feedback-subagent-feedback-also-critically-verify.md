---
name: feedback-subagent-feedback-also-critically-verify
description: "subagent 审计的结论本身也必须被重新查验——在每个被引用的 file:line 处读实际代码，绝不整份信任报告"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

把 [[feedback_reviewer_verify_critically]] 再推进一步：那条记忆说「别信声音权威（reviewer/docs/memory）——以实测裁决」。这条补充：**subagent 报告本身就是声音权威，必须重新查验。**

**用户明确纠正（2026-06-13）：**「注意随时引入 subagent audit/review/check，对于 subagent 的反馈也要注意查验复核」——「always pull in subagent audit/review/check, AND also critically verify subagent's feedback」。

**Why:** subagent 读代码并产出结论；该结论可能是：
- 正确（最常见——它们读得准确）
- 过时（它们读了陈旧版本，或文件在审计途中变了）
- 对成因判断错误（它们识别出真实症状但误判机制）
- 对严重程度判断错误（它们把风格细节叫「FAIL」，或漏掉真正的 FAIL）
- 幻觉式的 file/line 引用（罕见但会发生）

如果你把 subagent 的裁决未经查验就转发给用户，**你就成了传递坏信息的声音权威**。

**How to apply:**
- 对 subagent 报告里的每一个 FAIL/WARN，在行动前**自己去读被引用的 file:line**。通过 grep / Read / test 确认 bug 可复现。
- 如果 subagent 对你怀疑有问题的地方说「没发现问题」，**自己跑一个探针**。不要照单全收这个 PASS。
- 当 subagent 的推理链不可见（只有结论）时，带着具体问题派一个新的 subagent，或自己去读。
- 尤其要查验：绝对断言（「X 不可能」「不存在调用者」）、计数（「36 处」）、关于测试结果的主张（「9 个通过」）、以及架构主张（「层 X 从不 import Y」）。
- 转发给用户：裁决 + 你自己的查验 + 你采纳了哪些发现、对哪些有异议。绝不在未确认的情况下复制粘贴 subagent 输出。

**Example from this session:** subagent 的 commit 2 审计标记了「main.ts 与 ConsoleSink 之间 double consola hijack」。我用 `grep -n "setReporters" main.ts start.ts` 查验 → 确认 `main.ts:20 initConsolaReporter()` 和我新加的 `attachConsoleSink(bus)` 都调用了 `setReporters`。真实问题，通过 `hijackConsola: false` 选项修复。如果我没查验，可能会把这个修复当作「subagent 过度警惕」而跳过。

Related: [[feedback_reviewer_verify_critically]], [[feedback_real_problems_over_risk]]。
