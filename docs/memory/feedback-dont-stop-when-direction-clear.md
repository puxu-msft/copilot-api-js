---
name: feedback-dont-stop-when-direction-clear
description: 方向明确后别停下来问"先做哪个 A/B/C"；只有破坏性操作/真 either-or/上下文不足/选项有实质架构后果差异才停
metadata:
  type: feedback
---

方向一旦明确,直接做下一项,**别停下来问"先做 A 还是 B 还是 C"**。把"有多个待办"误当成"需要用户拍板的决策点",会制造无谓往返、显得没主见。多数 A/B/C 只是**执行顺序**,不是需要授权的岔路。

**判据(问 vs 不问的分界):不是"有没有多个选项",而是"这些选项是否架构/语义等价"。**
- **等价**(纯执行顺序、先改哪个文件、先写哪个测试)→ 自己选,直接做。
- **不等价**(不同架构后果 / 不可逆 / 违反既有 constraint)→ 才停,且按 [[feedback-give-user-decision-data-not-pitch]] 给量化选项,而非裸问"A 还是 B"。

只有四种情况正当停下征询:(1) 破坏性/不可逆操作(原则1 那类);(2) 真 either-or 抉择(选 A 即排除 B 且无客观最优);(3) 上下文不足以判断;(4) 选项有**实质架构/语义后果差异**(即 give-user-decision 的触发场景)。除此之外别问。

**Why:** 排程性的"先后顺序""要不要顺手做"自己定就好;停下来问只在结果会**因选择而实质不同**时才有价值。

**How to apply:** 自问"不同选择会导向**不同的最终结果**吗?" 会 → 可能值得问;只是顺序/是否顺手 → 自己排,做就是了。与 [[feedback_no_unilateral_action]] 互为反面(那条:范围歧义→先问;这条:方向明确→别问),与 [[feedback_never_stop_for_turn_length]]、[[feedback_never_stop_at_compile_intermediate]] 同属"别停"家族——四条合起来才是完整的"何时可停"边界。
