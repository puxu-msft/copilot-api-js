# Mandatory Block Delivery + HTTP/2 Observability — SDD progress ledger

Worktree: /home/xp/src/copilot-api-js/.worktree/mandatory-block-delivery-h2-implementation
Branch: mandatory-block-delivery-h2-implementation
Merged-plan baseline: 6d4314817c0492019477e04a8f25b4864e39f6fb
Plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/README.md
Spec: docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md
Execution mode: full subagent-driven; implementation by isolated implementers, independent task review after integration, no inline product-code edits by controller.

## Baseline

- `git merge-base --is-ancestor 82cd9123 master`: pass; master at `6d431481` when implementation worktree was created.
- `bun run typecheck`: pass at `6d431481`.
- Initial `test:fast` exposed a load-sensitive wall-clock ratio false-red in `canonical-performance.unit.test.ts`. The deterministic replacement is complete and integrated as `30134734` + `352767f2` + `b58dc819` + `d6961943`. Third review: Spec PASS, Quality APPROVED, 0 Critical/Important/Minor. Integrated-tree verification: canonical + resetter 8 pass/0 fail, deterministic ratios 3.8515/3.9854, typecheck pass. Wall-clock is report-only; recursive freeze and actual arena-copy work are deterministic gates with scoped AST SCC controls.
- Task 9 progress scaffold commit: `e43d08ec`.

## Task DAG

- Task 1/1b: the original implementer transcript is physically unavailable, so a successor continued from the nine committed checkpoints. Candidate HEAD `980eaf09` remains unintegrated. The first review's History rich-frame loss, direct synthetic-origin loss, reset false-green, repeated event/id projection, duplicate decoder, and stale transport test are closed; targeted suites reached 121 pass and typecheck. Code rereview found 2 major false-greens: fresh rewrite outputs are rewrapped and inherit the parsed source's `idField`, and an ID containing U+0000 remains in projection while a WHATWG client ignores the wire field. Independent acceptance added one Important public-contract regression: `createResponses({stream:true})` leaks the internal rich wrapper, so existing consumers reading flat `.event/.data` regress from 9/9 to 5/9. The successor is fixing these three current gaps and the misleading test name; both original reviewers must rerun on the next HEAD. Backend verification still belongs on a later integration snapshot that includes the deterministic performance commits.
- Task 2: complete and integrated as `294aa803` + `a5b6eb43` + `1e7b527a`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important/Minor. Integrated-tree verification: grammar + boundary classifier 27 pass/0 fail, typecheck pass.
- Task 3: candidate through `2543ec46` remains unintegrated. Code re-review now gives Spec PASS / Quality APPROVED and confirms the prior Responses committed-prefix and Chat successful-finish Criticals are closed. Independent acceptance nevertheless found one remaining Important production seam: an in-band Chat wire error first produces a failed `response-terminal`, then the route finish producer reports the same `acc.streamError` as `terminal-failure`, so grammar emits a second `post-terminal-frame` diagnostic instead of one frozen typed error outcome. Commit `41e79a60` fixes this duplicate consumption while preserving the explicit non-wire terminal-failure seam. Independent acceptance now PASSes with 0 Critical/Important/Minor and 34 tests / 215 assertions; final code-review confirmation is still pending. Task 4 remains blocked until that second verdict arrives and the candidate is integrated with Task 1b's projection seam.
- Task 4: blocked by Task 3; readiness map complete. Preserve distinction between delivery-owner serializer and raw transport serializer; eliminate manual candidate-session field loss.
- Task 5: blocked by Task 4; frozen graph baseline complete: 6 roots/11 pumps, all 11 currently pendingLegacy. Guard must freeze root→pump pairs, cut at owner entry, and discover private sink owners without wrapper false positives.
- Task 6: blocked by Task 5; config-contract readiness complete with 0 blocker/0 major.
- Task 7: complete and integrated as `6b545360` + `b1873020` + `87e1eda1` + `1d24d9bf`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important, 2 non-blocking Minor. Integrated-tree verification: 57 pass/0 fail, typecheck pass, DATA callback unchanged at `src/lib/transport/http2-client.ts:1205`. Minor disposition: add `req` receiver AST mutation to downstream architecture/runtime verification; stale pre-hardening counts in the worktree-local report are not a product artifact.
- Task 8: complete and integrated as `38d0d1c5`..`025c0ba8` (10 commits). Final code review: Spec PASS, Quality APPROVED, 0 Critical/Important, 1 stale-progress Minor. Independent verification: Acceptance PASS, 0 Critical/Important/Minor, 12 probes/56 assertions. Integrated-tree verification: ledger 14 pass/0 fail, typecheck pass. Primitive remains inert; no production wiring. Progress Minor is superseded by this ledger and final git lineage.
- Task 9: remediation candidate `e43d08ec..9f9b0d7b` remains unintegrated. Original migration/decoder/fixture findings are closed, but ready-summary integrity still fails after `SUMMARY_PROJECTION_READY_KEY=1`. PoC Task 34 has completed API inventory, B1, B2, and B3 correctness. On this Linux x86-64 host, Bun 1.3.14 can expose a trigger-readable connection-local getter through a C extension plus `bun:ffi` host toggle, while Node v24.16.0 can use a closure UDF; the shared scope helper rejects every nested scope and Promise/thenable return, all tested failures clear mode, and cleanup-removal mutations turn the oracle red. Independent review additionally proved that thenability checks happen after callback execution, so only a SQLite transaction—not the sync-only return contract—rolls back Promise-executor or `then`-getter side effects; B2's final capability and quality verdicts are approved with 0 blocker/Critical/Important/Minor. B3 proves normalized refs + integrity epochs detect uncoordinated canonical/evidence changes, but ordinary SQL can also rewrite every integrity/status/marker row into a self-consistent ready state. Whether that counterexample is in scope is an unresolved A-level trust-boundary decision: frozen spec requires canonical/evidence corruption and future formats not be published, but does not state whether a writer with ordinary SQL access may directly re-certify derived state. Scope A trusts all derived authorization state against direct SQL forgery—including marker/status/attestation, ready projection, normalized refs, and version rows—while scope B forbids those ordinary DML rewrites and therefore requires an unforgeable writer authority. The original reviewer is re-adjudicating this A/B framing before it goes to the user. B3 performance measurement is complete: all get/list/session/stats query plans avoid the manifest blob but perform a per-summary correlated refs anti-join; at 32 refs and 256 KiB payload, median paired deltas were approximately +22.83/+1318.50/+778.09/+11344.05 µs respectively on the in-memory Bun 1.3.14 PoC, with no pass threshold or zero-regression claim. Mature-driver research continues; cross-platform native delivery and no-compiler installs remain unproven. Do not hand the authority design to the Task 9 implementer yet and do not patch ready reads with per-row full hydrate.
- Task 10: blocked by Tasks 7, 8, 9; activation graph complete. Scheduler port, H2 lease install/freeze, dispatch slots, envelope, unique persistence sink, and transaction-A consumer must land in one activation commit.
- Task 11: blocked by Tasks 7 and 10; runtime-harness readiness complete with 0 blocker/0 major.
- Task 12: blocked by Tasks 1-11; docs/acceptance readiness complete. Live docs remain not-implemented; Bun clean-RST backlog stays open.
- Baseline deterministic performance fix: complete and integrated; see Baseline entry above. No open review findings.

## Review gates

Each integrated task requires a review package from the recorded pre-task base through integrated HEAD, then independent task review with both verdicts: spec compliance and code quality. Critical/Important findings return to a subagent fixer and the same reviewer re-reviews. Task 12 additionally requires two orthogonal merged-state reviewers with `0 blocker / 0 major`.

Integration identity gate: parallel `Agent` results are not assumed to preserve dispatch order. Before integrating any agent commit, read its report and verify the actual brief path, base SHA, commit SHA, and `git show --name-only`; reject any file outside that task's frozen boundary unless the brief explicitly permits it. This gate was added after one Task 1 agent correctly stopped when it received a Task 2 oracle message intended for a different parallel result.

Cross-task integration seam:
- Task 1b and Task 3 may both touch `response-processor` / direct render. Task 1b owns parsed-SSE provenance → wire-only projection; Task 3 owns wire frame → typed delivery classification. Whichever integrates second must replay both task suites and verify adapter/candidate wrappers preserve the explicit projection boundary without copying parsed provenance into client frames or dropping classified outcomes. A clean three-way merge is not evidence of semantic compatibility.

Independent-oracle findings now binding on implementation/review:
- Task 1: leading BOM, lone CR, and remove-only-first-BOM controls.
- Task 2: six false-green sequences and three false-red controls in `task-2-independent-oracle.md`.
- Task 7: CAS/freeze/builder/observer ordering, deep late-mutation, cancel provenance, DATA AST; stream/session shared-error dynamic proof deferred to Tasks 8+10.
- Task 9: eight migration/recovery/digest/GC/future-format controls in `task-9-independent-oracle.md`.
- Task 5 guard: frozen root→pump pairs, owner-entry graph cut, private sink-owner discovery with wrapper exclusion.

## Global constraints

- Mandatory block/item delivery; boundaryless protocols are response-terminal.
- No production live/cap-retreat bypass; no oversize-block spool fallback.
- HTTP/2 DATA callback unchanged; no extra work in that callback.
- Performance reports only, no fixed gate or zero-regression claim.
- Never start or terminate port 4141; no push.
- Do not update live DESIGN/API state before full implementation and merged-state verification.
