---
name: feedback-architecture-health-is-user-need
description: 长远架构健康本身就是用户需求，不是奢侈品——绝不以"目前能用"或"还没有具体触发点"否决一次结构性重写
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

用户陈述的原则（2026-06-13，原话）：**"长远的好架构对用户而言就是真实驱动力"**。

**Why:** 把 [[feedback_complete_root_cause_fix]] 再深推一层。那条记忆说"成本不是决策因素"；这条说架构健康本身**算作真实的用户需求**，而不只是"一个跟成本权衡时会输掉的 nice-to-have"。一个被准确命名的架构债，本身就足以构成重写的理由——你不必等"一个具体触发点"或"下一次破坏性扩展"。

**Original mistake I made this session:** 当用户问"是否值得彻底重写 TUI 在架构里的位置？"，我给了个"平衡"的回答，结论是"现在不值得重写，等触发点到了再说"——我援引了"目前稳定 / 还没有第三个 sink / 没有 IDE 问题"。用户纠正：长远架构本身是驱动力。被纠正后我对抗性地调动 subagent，得出相反结论（重写**确实**有理），并有 10 条具体的债项支撑。

**How to apply:**
- 当用户问"是否值得重写 X？"，**不要**默认"不，目前能用"。对抗性地调动 subagent，用 file:line 证据列举具体债项，算出扩展痛苦矩阵。
- **Subagent 默认会给 ROI/成本框架的裁定**("现在不值得"/"成本高"/"等触发再说")——这不只是我自己的毛病,subagent 不经校正也会复制同样的默认。把它的 ROI 裁定当**可疑**并主动推翻;adversarial prompt 要**显式要求它抛开 ROI、只按"问题是否真实 + 架构是否更好"评判**,否则它会把"成本高"包装成结论喂回来。
- **可接受**的不重写理由：(a) 提出的债项是虚的（subagent 查实它们不成立），或 (b) 重写**并不真正改善**清晰度/可扩展性/可观测性（必须用实证论证，而非"感觉过度设计"）。
- **不可接受**的理由："目前能用"、"没有急性疼痛"、"成本高"、"可能搞坏东西"、"应该等触发点"——全是对本原则 + [[feedback_complete_root_cause_fix]] + [[feedback_real_problems_over_risk]] 的直接违反。
- 流程：(1) 用对抗性 prompt 做 brainstorm/subagent；(2) 拿到 10+ 条带 file:line 的具体债项清单；(3) 起草 RFC；(4) 3 轮 subagent review 直到所有 FAIL/WARN 解决；(5) 实现。

Related: [[feedback_complete_root_cause_fix]], [[feedback_real_problems_over_risk]], [[feedback_optimize_long_term_maintainability]]。
