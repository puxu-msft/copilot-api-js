---
name: feedback_complete_root_cause_fix
description: 用户为完整修复接受任意代价（工期、复杂度、改动量）；绝不提"最小/快修"权衡；暂缓项必须完整文档化供用户未来决策
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f0b84555-74bb-4219-b5e7-8b3ff13fb864
---

用户明确陈述（本会话）：

> 用户认为，如果问题真实存在，不要做短期、"将就"，用户完全接受工期、开发时间、开发复杂度等等代价，都应该认真全面修复
> 用户希望结果是高性能、结构良好、架构完整、可观测、可维护的

> 对于你认为暂时不该做的事项，用户也有一个原则，认为应该写入文档，全面描述，由用户未来决定是否继续

**Why:** 我之前一直按 ROI 分流（"小修高收益的先做"），并提出"先 X + 下一轮 Y"的方案。这种框架是错的——它隐含地助长短期思维。用户不希望我为"最小扰动"做优化。用户优化的是终态质量：高性能、结构良好、架构完整、可观测、可维护。

**How to apply:**

1. **修复的决策规则**："这是不是我想留下的架构里的一个真实问题？"——若是，就完整修复。不要提"现在小修、以后结构修"——结构修本身**就是**正确的修。

2. **No tradeoff framing**：绝不摆出"最小修 vs 完整修"的选项。选完整的那个并执行。不要预先把范围谈小。分阶段**交付**(基础阶段先落地、高级阶段后续)是允许的;但绝不为"最小化"砍掉让功能真正能用的核心——phasing ≠ cutting the usable core。

3. **Cost is irrelevant**：时间、改动量、代码体量、影响半径——全部可接受。只有终态质量要紧。

4. **For items I want to defer**：把它们写进文档文件，**完整**描述（不是一行 backlog），好让用户日后带着完整上下文决策。把暂缓项文档当作一等产物，而非脚注。
   - 逐项：file:line、根因、当前行为、理想架构、我为何暂缓、若做要改什么。
   - 用户明确会回头看这些——把文档写得对那次回看有用。

5. **Architectural completeness over local correctness**：当一类 bug 冒头（如 3 个文件里的静默 JSON 损坏），重构为一个共享 primitive——别各自孤立地修。重构成本可接受。

6. **Observability is end-state quality**：错误必须浮现（不静默 catch），状态必须暴露（status 端点），转换必须被记录。加可观测性是修复的一部分，不是单独的任务。

7. **NEVER pick the simple workaround when the best fix exists**（用户为此发过火——明确指令）。若干净修法改 50 行、而"最小"回退只要 3 行，选那 50 行的修法。回退好的工作来躲副作用，正是根因思维的反面——找出耦合到那副作用的东西，去修**它**。

8. **Subagent review must include "did the fix violate principles?"**——不只是"修得对不对"。让 reviewer 检查短期捷径、半截修复、以及本该现在做却"甩去暂缓"的模式。

Related: [[feedback_real_problems_over_risk]]（真实问题检测规则）。[[feedback_no_unilateral_action]] 仅在范围歧义问题上仍适用。
