---
name: feedback-architecture-health-is-user-need
description: "Long-term architecture health is itself a user need, not a luxury — never reject a structural rewrite by citing \"currently works\" or \"no concrete trigger yet\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

User-stated principle (2026-06-13, verbatim): **"长远的好架构对用户而言就是真实驱动力"** ("long-term good architecture IS the real driver for users").

**Why:** Extends [[feedback_complete_root_cause_fix]] one level deeper. That memory says "cost is not a decision factor"; this one says architecture health itself **counts as a real user need**, not just a "nice-to-have that loses when balanced against cost". A correctly-named architecture debt is sufficient justification for a rewrite — you don't have to wait for "a concrete trigger" or "the next breaking extension".

**Original mistake I made this session:** When user asked "is it worth fully rewriting TUI's place in the architecture?", I gave a "balanced" answer concluding "not worth rewriting now, defer until a trigger arrives" — I cited "currently stable / no third sink yet / no IDE issues". User corrected: 长远架构本身是驱动力. After being corrected I engaged subagent adversarially and reached the opposite conclusion (rewrite IS warranted), backed by 10 concrete debt items.

**How to apply:**
- When user asks "is it worth rewriting X?", do NOT default to "no, currently works". Engage subagent adversarially, enumerate concrete debts with file:line evidence, compute extension-pain matrix.
- **Subagent 默认会给 ROI/成本框架的裁定**("现在不值得"/"成本高"/"等触发再说")——这不只是我自己的毛病,subagent 不经校正也会复制同样的默认。把它的 ROI 裁定当**可疑**并主动推翻;adversarial prompt 要**显式要求它抛开 ROI、只按"问题是否真实 + 架构是否更好"评判**,否则它会把"成本高"包装成结论喂回来。
- Acceptable reasons to NOT rewrite: (a) the proposed debt items are illusory (subagent finds them false), or (b) the rewrite **does not actually improve** clarity/extensibility/observability (must be empirically argued, not "feels overkill").
- Unacceptable reasons: "currently works", "no acute pain", "cost is high", "could break things", "should wait for trigger" — all are direct violations of this principle + [[feedback_complete_root_cause_fix]] + [[feedback_real_problems_over_risk]].
- Process: (1) brainstorm/subagent with adversarial prompt; (2) get a 10+ concrete debt list with file:line; (3) draft RFC; (4) 3 rounds of subagent review until all FAIL/WARN resolved; (5) implement.

Related: [[feedback_complete_root_cause_fix]], [[feedback_real_problems_over_risk]], [[feedback_optimize_long_term_maintainability]].
