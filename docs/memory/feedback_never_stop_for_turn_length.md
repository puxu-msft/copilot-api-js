---
name: feedback_never_stop_for_turn_length
description: 永远不要以这轮太长或额度为由推迟或停下工作;用户有充足的时间/额度——把任务彻底做完
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

**永远不要因为"这一轮变长了"或出于对 token 额度的顾虑,而停下、设检查点或推迟剩余工作。** 用户有充足的时间和额度("你有充足的时间、额度"),并明确表示不希望基于长度的停顿("永远不要因为'这轮太长没做'停下,记住!")。

**Why:** 在 phase-3 测试重组期间,我反复把剩余工作(多轮 review、文档)定性为"下一轮——这轮太长了",而用户当场断然拒绝了这种做法。

**How to apply:** 在一次连续的推进中把每个任务做到真正完成——包括那些我会忍不住贴上"后续"标签的部分(多轮 review、文档更新、清理)。只在以下情况暂停:(a)真正卡在一个该由用户来做的决策上,或(b)工作确实已经完成。"工作量很大" / "回复已经很长了"永远不是提前交还的正当理由。继续用 subagent/并行处理来消化工作量,而不是推迟。与 [[feedback_complete_root_cause_fix]] 和 [[feedback_optimize_long_term_maintainability]] 相关。
