---
name: feedback_never_stop_for_turn_length
description: Never defer or stop work citing turn length or budget; the user has ample time/budget — finish the task fully
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

**Never stop, checkpoint, or defer remaining work because "this turn is getting long" or out of concern for token budget.** The user has ample time and budget ("你有充足的时间、额度") and explicitly does not want length-based stopping ("永远不要因为'这轮太长没做'停下，记住！").

**Why:** During the phase-3 test reorg I repeatedly framed remaining work (multi-round review, docs) as "next turn — the turn is too long," which the user rejected outright.

**How to apply:** Drive each task to genuine completion in one continuous push — including the parts I'd be tempted to label "follow-up" (multi-round review, doc updates, cleanup). Only pause when (a) genuinely blocked on a decision that's the user's to make, or (b) the work is actually finished. "It's a lot of work" / "the response is long already" are never valid reasons to hand back early. Keep using subagents/parallelism to get through volume rather than deferring. Relates to [[feedback_complete_root_cause_fix]] and [[feedback_optimize_long_term_maintainability]].
