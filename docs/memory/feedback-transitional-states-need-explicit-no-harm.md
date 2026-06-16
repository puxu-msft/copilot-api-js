---
name: feedback-transitional-states-need-explicit-no-harm
description: "In multi-commit refactors, intermediate states must be ACTIVELY harmless — not just \"will be replaced soon\". Use feature flags / silent modes to guarantee no behavioral overlap with legacy code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

Extends [[methodology-commit-invariants]]: the "all sinks attached" invariant is necessary but not sufficient. A sink attached at commit N before its producer cuts over at commit N+2 will receive zero events — fine for read paths, but if the legacy code ALSO renders the same output, **both render** during the overlap window. The user sees duplicate output, doubled metrics, conflicting hijacks.

**Why:** Implicit "no harm" assumptions break silently. Tests pass because each path works in isolation; the harm only shows up when both paths emit to the same channel (stdout / WS / DB).

**Example from this session (observability rewrite, commits 2-3e):**
- Commit 2 attached `ConsoleSink` to bus. Legacy `ConsoleRenderer` (via `main.ts:initConsolaReporter`) was still installed. Both would render `[ OK ]` lines for every request after producer cutover.
- Commit 3b atomically cut the producer over to bus. Suddenly both ConsoleRenderer (via legacy `tuiLogger.finishRequest`) AND ConsoleSink (via bus `request.completed`) drew the `[ OK ]` line.
- Subagent caught it in commit 3c review.
- Fix: ConsoleSink got `silent: true` option, hardcoded in `start.ts` during commits 2-3e. The sink stays subscribed (sink-ordering integration test still passes) but doesn't write to stdout. Commit 4 deletes lib/tui and flips silent back to default false.

**How to apply:**
- For every commit in a multi-commit refactor, ask: "If the legacy code runs alongside the new code DURING this commit window, do they both write to the same output (stdout, WS, DB)?"
- If yes, the new code needs an EXPLICIT no-op mode. Don't rely on "no one calls it yet" — calls might leak through tests, edge cases, or future commits.
- Common no-op patterns:
  - `silent: true` flag (write path short-circuits)
  - `hijackConsola: false` flag (don't install global state mutations)
  - Subscribe-only (track state for tests but don't emit)
- Document the flag's lifecycle in the commit message AND in the flag's docstring: "set true during commits N-N+2, flip to false in commit N+3 when legacy is deleted."
- Run a manual UX check at each commit boundary — typecheck/tests pass but they don't catch "stdout has two of every line".

**Anti-pattern caught:**
- "It'll be deleted in commit 4 anyway, why care about the transition window?" — because every commit between is a real machine state someone could git-bisect to. If commits 2-3e produced double output, bisecting a real bug to that range would have you chasing a phantom.

Related: [[methodology-commit-invariants]], [[feedback-rfc-then-implement-for-large-refactors]], [[feedback-mine-the-pass-with-warn]].
