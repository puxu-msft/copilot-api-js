---
name: feedback-rfc-then-implement-for-large-refactors
description: "For multi-thousand-line refactors, write an RFC + survive ≥3 rounds of subagent adversarial review BEFORE implementing — don't start coding from a \"we agreed\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

User preference (2026-06-13): when offering "一次性大重写 / 先出设计 RFC 再动手 / 仅做最高价值 70%", they chose RFC-first for an estimated ~2500-line observability rewrite.

**Why:** Big refactors that start from a verbal "we agreed" routinely turn out to have:
- Missing event sources the design didn't account for (this session: subagent v1 review caught 4 missed broadcast namespaces — history.stats_changed, history.cleared, system.shutdown_phase_changed, system.rate_limit_state — that would have caused front-end regression if implementation started without them)
- Inverted assumptions (this session: middleware finalization was going to be deleted; subagent caught that would balloon error-visibility latency from milliseconds to 200s)
- Conflicting decisions across sections (this session: count-tokens-via-fake-completed (decision A) would have nullified the isolation goal (decision B))

Each catch saves real implementation rework. Reaching "stable RFC" via 3 rounds of subagent adversarial review costs maybe 30-60 min and prevents the much larger rework on actual code.

**How to apply (process):**
1. **Brainstorm/audit first**: get a concrete debt list (file:line evidence) — don't start designing from "feels broken"
2. **Write RFC** in `docs/rfc/<topic>.md`: problem statement, architecture, dependency direction, type union, sinks/modules, cutover plan (commits, NOT phases), out-of-scope, open questions for user, verification
3. **Subagent adversarial review** with explicit prompt: "look for missed event sources, contradictions across sections, false self-claims, lurking bugs". Do NOT use a generic "review this RFC" prompt.
4. **Verify subagent's findings** per [[feedback-subagent-feedback-also-critically-verify]]
5. **Repeat** until subagent reports zero FAIL/WARN (usually 2-4 rounds)
6. **Ask user** to resolve open questions in §6 BEFORE coding
7. **Implement** with commit invariants per [[methodology-commit-invariants]]

**Don't skip even one round.** This session: v1 RFC had 4 FAIL + 8 WARN, v2 had 3 red + 4 yellow, v3 had 3 text-self-consistency issues. Each round genuinely improved the design — none felt redundant.

Related: [[feedback-architecture-health-is-user-need]], [[methodology-commit-invariants]], [[feedback-subagent-feedback-also-critically-verify]].
