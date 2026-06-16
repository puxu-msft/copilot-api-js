---
name: feedback-mine-the-pass-with-warn
description: "When subagent reports \"PASS with 1 WARN\", treat the WARN as a real lead — often a thin layer over a deeper regression you'd otherwise miss"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

Extends [[feedback-subagent-feedback-also-critically-verify]]: subagent audits routinely come back as "PASS with 1 WARN" or "WARN low priority". The default temptation is to ship. **Don't.** Investigate the WARN one level deeper — it's often the visible tip of a real regression the subagent only half-caught.

**Why:** Subagents are good at surface-level checking (grep, type, lint, basic test). They're weaker at multi-step causal chains. A "dead export" they flagged might be dead BECAUSE you broke the calling contract — and the calling contract being broken IS a regression, just one the subagent didn't trace back.

**Example from this session (commit 4 / observability rewrite):**
- Subagent: "PASS — can ship. WARN: `notifyShutdownPhaseChangedAndFlush` is a dead export (no callers). Consider deleting per 原则9."
- I dug: the function was dead because `shutdown.ts:setPhase` now calls `bus.publishAndFlush`. Good.
- Dug deeper: bus.publishAndFlush in bus.ts returns `pendingWsBuffer: 0` as a hardcoded placeholder. WsSink's handler for `system.shutdown_phase_changed` was synchronous — bus doesn't await its work.
- **Real regression**: shutdown's phase frame was sent but the WS TCP drain was NOT awaited. Sockets could close before phase frame left the box. Legacy `notifyShutdownPhaseChangedAndFlush` had this drain semantic; my migration silently dropped it.
- Fix: made WsSink's handler `void | Promise<void>`, returned `broadcastAndFlush()` promise on `needsFlush`; bus.publishAndFlush awaits async handlers, so chain reconstructed end-to-end.

**How to apply:**
- When a subagent report ends in "PASS but here's a small WARN", treat it as a YELLOW flag, not GREEN. Spend 5-15 min following the WARN's causal chain before committing.
- Specifically ask: "What did the LEGACY code do that this WARN-flagged dead/orphan code was protecting? Did my migration preserve that?"
- Re-grep for the protection mechanism's purpose, not just its presence. (`broadcastAndFlush` doesn't sound dangerous; "WS TCP drain before force-close" does.)
- If you find a real regression, fix it BEFORE committing, not in a follow-up. Per [[feedback_complete_root_cause_fix]] / 原则8.

Related: [[feedback-subagent-feedback-also-critically-verify]], [[feedback_reviewer_verify_critically]], [[feedback_complete_root_cause_fix]].
