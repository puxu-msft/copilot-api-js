---
name: feedback-subagent-feedback-also-critically-verify
description: "Subagent audit findings themselves must be re-verified — read the actual code at every cited file:line, never trust the report wholesale"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

Extends [[feedback_reviewer_verify_critically]] one step: that memory says "don't trust voice authority (reviewer/docs/memory) — adjudicate by empirical test". This adds: **subagent reports themselves are voice authority and must be re-verified.**

**User-stated correction (2026-06-13):** "注意随时引入 subagent audit/review/check，对于 subagent 的反馈也要注意查验复核" — "always pull in subagent audit/review/check, AND also critically verify subagent's feedback".

**Why:** Subagents read code and produce conclusions; the conclusion may be:
- Correct (most common — they read accurately)
- Outdated (they read a stale version, or a file changed mid-audit)
- Wrong about cause (they identify a real symptom but misattribute the mechanism)
- Wrong about severity (they call a stylistic nit "FAIL" or miss a real FAIL)
- Hallucinated file/line references (rare but happens)

If you forward the subagent verdict to user unverified, **you become the voice authority transmitting bad info**.

**How to apply:**
- For every FAIL/WARN in a subagent report, **read the cited file:line yourself** before acting on it. Confirm the bug is reproducible by grep / Read / test.
- If subagent says "no problem found" on something you suspect is wrong, **run your own probe**. Don't accept the PASS at face value.
- When subagent's reasoning chain isn't visible (only conclusion), spawn a fresh subagent with the specific question or do the read yourself.
- Especially verify: absolute assertions ("X is impossible", "no caller exists"), counts ("36 sites"), claims about test outcomes ("9 pass"), and architectural claims ("layer X never imports Y").
- Forward to user: the verdict + your own verification + which findings you adopted vs disputed. Never copy-paste subagent output without confirming.

**Example from this session:** subagent's commit 2 audit flagged "double consola hijack between main.ts and ConsoleSink". I verified by `grep -n "setReporters" main.ts start.ts` → confirmed `main.ts:20 initConsolaReporter()` and my new `attachConsoleSink(bus)` both call `setReporters`. Real problem, fixed via `hijackConsola: false` option. Had I not verified, I might have skipped the fix as "subagent being paranoid".

Related: [[feedback_reviewer_verify_critically]], [[feedback_real_problems_over_risk]].
