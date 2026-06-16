---
name: feedback_real_problems_over_risk
description: "User prioritizes real architectural problems over backward compatibility / regression risk; gaps in test coverage are evidence to fix, not reason to defer"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f0b84555-74bb-4219-b5e7-8b3ff13fb864
---

User explicitly stated (multiple times this session):

> **用户永远不在乎向后兼容性、回归风险，用户在乎架构健康、长期可维护性、可观测性**

> **如果一个问题真实存在，不要在乎风险，认真去做，再让 subagent 认真 review，如果真出问题说明测试覆盖不够到位**

**Why:** When triaging deferred items, my default leaned toward "ROI / risk-adjusted priority" — treating LOW-severity readability items and "no real bug, just shape" items as deferred. User pushed back: this framing is wrong. The right axis is "does the problem actually exist". If yes → fix it, regardless of perceived risk. Regression risk is mitigated by tests + subagent review, not by avoidance.

**How to apply:**
- When triaging a backlog/review: only ask "is this a real problem?" — not "is the fix risky?" or "will users notice?"
- 区分两类"风格",别把前者误归后者而漏修:
  - **代码一致性 = 真问题,要修。** 同函数/同模块的相似逻辑用了不一致的写法(有客观锚点:**既有模式**),属 CLAUDE.md 原则8"保持代码风格统一"——选定一种模式就贯彻到底。
  - **纯主观 A/B 偏好 = 跳过。** "这行换种写法更好看",无既有模式约束、不影响缺陷,才是 subjective preference,不算问题。
  - 判据是有没有**既有模式做客观参照**:有 → 一致性问题要修;没有、纯审美 → 跳过。
- Don't classify items as "wait until triggered" if the latent risk is real (e.g. resource leaks, silent data loss, race conditions, observability blind spots).
- After implementing, run an independent subagent review (`feature-dev:code-reviewer`). If review finds new real bugs, that proves test coverage was insufficient — add tests in the fix.
- User does NOT want a permission gate for each item — proceed through the full list autonomously.
- Architectural health > backward compat: changing config field names, function signatures, return types is acceptable.

Related: [[feedback_no_unilateral_action]] still applies for **scope ambiguity** (don't expand scope without confirming) — but within an agreed scope, fix everything that's real.
