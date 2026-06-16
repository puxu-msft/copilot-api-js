---
name: feedback-give-user-decision-data-not-pitch
description: "When the user must make a scope/architecture trade-off, present 3-4 OPTIONS with quantified impact (LOC, files, deviations from architecture intent) — not a single recommended path with a \"what do you think?\". Let them choose from data."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

User-stated correction (2026-06-14): "等等，你再问用户一次，给出详细的参考，给用户决策支持" — "wait, ask the user again, give detailed reference, give the user decision support".

I had given a 2-option AskUserQuestion ("post-finalize" vs "create-and-take-over" middleware mode) without surfacing the architectural cost of each. User pushed back: don't give me yes/no, give me data to choose.

**Why:** Architecture-scoping decisions are the user's territory (per 原则4 / [[feedback_no_unilateral_action]]). But the user can only make a real choice if you've done the legwork: read the relevant code, found the constraints (e.g. existing comment "routing validation BEFORE ctx creation prevents dangling history entries"), quantified each option's LOC + file count + violations of the existing architecture. "A or B?" is not a decision — "A is 100 LOC and follows existing constraints, B is 400 LOC and violates messages/handler.ts:163, C defers to commit 4" IS a decision.

**Pattern that worked (commit 3e middleware scope):**
1. Grep for every caller, constraint, comment that touches the area
2. Read each constraint carefully — surface the EXISTING architectural intent
3. Identify 3-4 concrete options
4. For each option, fill in:
   - **Scope**: what files change, approximate LOC
   - **Constraint compatibility**: respects / violates existing intent
   - **Subagent risk**: known regressions or unanswered questions
5. Recommend one, but make the recommendation visible alongside the others' data
6. AskUserQuestion with all 4 as choices

**Example of the difference:**

❌ Bad: "Should I use post-finalize or create-mode for the middleware?"

✓ Good (excerpts from actual session):
- "**Post-finalize**: Handlers still call manager.create + c.set('requestContext', ctx). Middleware reads c.get post-next, calls failIfNotFinalized/completeFromHttpStatus. **Preserves messages/handler.ts:163 intent** (routing validation BEFORE ctx creation, avoids dangling history entry). Scope: ~6 routes + new middleware. Estimated 100-150 LOC."
- "**Create-mode**: Middleware creates ctx with endpoint inferred from path. Handlers no longer call manager.create. **Violates messages/handler.ts:163 intent** — any routing/payload validation error will leave a dangling history entry. Scope: ~6 routes restructured + path-to-endpoint map. ~300-400 LOC."
- "**Defer**: Only add SYNTHETIC_PATHS skip, push failIfNotFinalized to commit 4. ~30 LOC, but RFC promises break-quiet."

**How to apply:**
- Whenever the user pushes back on a yes/no, treat it as a signal you didn't surface enough data
- Before AskUserQuestion for any scope decision, spend 5-15 min grepping to fill in real numbers
- Always include constraint references — file:line if they exist as comments
- Recommend one but rank options by architectural fit, not just by smallness

Related: [[feedback_no_unilateral_action]] (the scope/decision is user's), [[feedback-architecture-health-is-user-need]] (don't bias toward "small" — bias toward "fits intent"), [[methodology-commit-invariants]], [[feedback-dont-stop-when-direction-clear]] (architecturally-equivalent options → don't stop to ask; only non-equivalent ones route through this memory).
