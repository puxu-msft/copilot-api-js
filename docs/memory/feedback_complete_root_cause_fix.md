---
name: feedback_complete_root_cause_fix
description: "User accepts arbitrary cost (time, complexity, churn) for complete fixes; never propose minimal/quick-fix tradeoffs; defer items must be fully documented for future user decision"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f0b84555-74bb-4219-b5e7-8b3ff13fb864
---

User explicitly stated (this session):

> 用户认为，如果问题真实存在，不要做短期、"将就"，用户完全接受工期、开发时间、开发复杂度等等代价，都应该认真全面修复
> 用户希望结果是高性能、结构良好、架构完整、可观测、可维护的

> 对于你认为暂时不该做的事项，用户也有一个原则，认为应该写入文档，全面描述，由用户未来决定是否继续

**Why:** I had been triaging by ROI ("small fix high impact first") and offering "X first + Y next round" plans. This framing is wrong — it implicitly promotes short-term thinking. The user does not want me to optimize for minimal disruption. The user optimizes for end-state quality: performant, well-structured, architecturally complete, observable, maintainable.

**How to apply:**

1. **Decision rule for fixing**: "is this a real problem in the architecture I'm trying to leave behind me?" — if yes, fix completely. Do not propose "small fix now, structural fix later" — the structural fix IS the right fix.

2. **No tradeoff framing**: never present "minimal fix vs complete fix" choices. Pick the complete one and execute. Don't pre-negotiate scope down. 分阶段**交付**(基础阶段先落地、高级阶段后续)是允许的;但绝不为"最小化"砍掉让功能真正能用的核心——phasing ≠ cutting the usable core。

3. **Cost is irrelevant**: time, churn, code volume, blast radius — all acceptable. Only quality of end state matters.

4. **For items I want to defer**: write them to a documentation file with FULL description (not a one-liner backlog), so the user can decide later with full context. Treat the deferred-items doc as a first-class artifact, not a footnote.
   - Per-item: file:line, root cause, current behavior, ideal architecture, why I deferred it, what changes if it's done.
   - The user explicitly will revisit these — make the doc useful for that revisit.

5. **Architectural completeness over local correctness**: when a bug class shows up (e.g. silent JSON corruption in 3 files), refactor to a shared primitive — don't fix each in isolation. Refactor cost is acceptable.

6. **Observability is end-state quality**: errors must surface (no silent catch), state must be exposed (status endpoints), transitions must be logged. Adding observability is part of the fix, not a separate task.

7. **NEVER pick the simple workaround when the best fix exists** (user got angry about this — explicit instruction). If a clean fix changes 50 lines vs a "minimal" revert that takes 3 lines, take the 50-line fix. Reverting good work to dodge a side-effect is the opposite of root-cause thinking — find what's coupling to the side-effect and fix THAT.

8. **Subagent review must include "did the fix violate principles?"** — not just "is the fix correct?". Ask the reviewer to check for short-term shortcuts, half-fixes, and "punted to deferred" patterns that should have been done now.

Related: [[feedback_real_problems_over_risk]] (real-problem detection rule). [[feedback_no_unilateral_action]] still applies for scope-ambiguity questions only.
