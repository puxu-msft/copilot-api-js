---
name: methodology-commit-invariants
description: "For large multi-commit refactors, encode \"every commit ends in state X\" invariants in the RFC and verify them per commit — prevents intermediate breakage"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

When doing a multi-commit structural refactor (e.g. 8-commit observability rewrite this session), write **commit-level invariants** into the RFC and verify them after each commit.

**Why:** Large refactors that go "commit 1 builds scaffold, commit 4 makes it work" risk shipping an intermediate commit where the system is half-broken. A bisect later lands on that commit and is useless. With explicit invariants, every commit ships a working system.

**Example from this session (observability rewrite RFC §4):**

> Invariant: **from commit 2 onward, every commit ends with all 4 sinks attached to the bus; the system remains observable end-to-end through the cutover.**

This forced commit 2 to **attach sinks as idle observers** rather than waiting until commit 3b. Commit 2 alone: sinks receive zero events (bus empty), legacy paths still emit; system is observable both ways. Commit 3b: producer cuts over atomically; sinks become authoritative the same commit consumers.ts is deleted. **No commit between 2 and 3e leaves observability half-broken.**

**How to apply:**
- In any RFC with ≥3 commits, write 1–3 explicit invariants in the cutover section. They are testable statements like "the test suite passes", "all sinks attached", "no double-write between old and new path".
- Per commit, the verification step (typecheck + tests + manual check) MUST explicitly include the invariants. If a commit cannot satisfy them, restructure the commit order.
- When the user says "逐 commit、每步等我确认", honor it strictly: subagent-audit each commit before asking for sign-off; never bundle commits.
- Cosmetic regressions (e.g. TTY footer flicker from double consola hijack — caught by subagent this session) violate the spirit even if not the letter; offer a flag/option to defer the regression to a clean cutover point.

**Anti-pattern caught this session:** initial commit 2 plan was "attach sinks, hijack consola, done". Subagent caught that ConsoleSink + legacy ConsoleRenderer both hijacking would shadow each other → fix was a `hijackConsola: false` option used in commits 2-3a, defaulting true for commit 4+.

Related: [[feedback_complete_root_cause_fix]], [[feedback_reviewer_verify_critically]], [[feedback-architecture-health-is-user-need]].
