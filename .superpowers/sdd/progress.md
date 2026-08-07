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
- `bun run test:fast`: one load-sensitive failure at `tests/history/v3/canonical-performance.unit.test.ts:80`, `sseRatio=12.325864384601346`; isolated rerun of the same file: 3 pass, `sseRatio=6.962627217602097`. Independent debugger confirmed wall-clock ratio false-red. Candidate deterministic fix `49ff6670` is NOT integrated: reviewer found 3 accepted Important issues—copy observation mirrors rather than measures real copy, recursion guard is name-based, and `medianMs > 0` still gates. Original implementer is fixing; same reviewer must re-review.
- Task 9 progress scaffold commit: `e43d08ec`.

## Task DAG

- Task 1: candidates `e722404c` + checkpoint `c5a2fbfe` NOT integrated. Spec review PASS but quality CHANGES_REQUIRED. Retry syntax and inner-BOM control are fixed and committed in `c5a2fbfe`; empty-ID remains blocked on a shared `client-sink` canonical-vs-wire seam. Spec requires dispatched parser `id` always be a string, including empty; do not “fix” by making parser ID optional. Independent debugger is locating the shared-base fix. Task remains in progress and blocks Task 12.
- Task 2: complete and integrated as `294aa803` + `a5b6eb43` + `1e7b527a`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important/Minor. Integrated-tree verification: grammar + boundary classifier 27 pass/0 fail, typecheck pass.
- Task 3: unblocked and in progress; readiness map complete. Responses adapter selection must include HTTP-vs-WS transport/mode, not only ClientFormat.
- Task 4: blocked by Task 3; readiness map complete. Preserve distinction between delivery-owner serializer and raw transport serializer; eliminate manual candidate-session field loss.
- Task 5: blocked by Task 4; frozen graph baseline complete: 6 roots/11 pumps, all 11 currently pendingLegacy. Guard must freeze root→pump pairs, cut at owner entry, and discover private sink owners without wrapper false positives.
- Task 6: blocked by Task 5; config-contract readiness complete with 0 blocker/0 major.
- Task 7: complete and integrated as `6b545360` + `b1873020` + `87e1eda1` + `1d24d9bf`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important, 2 non-blocking Minor. Integrated-tree verification: 57 pass/0 fail, typecheck pass, DATA callback unchanged at `src/lib/transport/http2-client.ts:1205`. Minor disposition: add `req` receiver AST mutation to downstream architecture/runtime verification; stale pre-hardening counts in the worktree-local report are not a product artifact.
- Task 8: unblocked and in progress. Existing lease/refcount patterns are idempotent and cannot satisfy required duplicate-freeze/release fail-loud behavior; implement a closed primitive importing Task 7's unique schema, with no production wiring.
- Task 9: candidate `e43d08ec..b8abe3d2` NOT integrated. Code review FAIL/CHANGES_REQUIRED with 2 Critical blockers + 3 Important: ensureV3Schema preempts the migration in production startup; ordinary manifest hydrate publishes missing/corrupt evidence; manifest version decoding diverges across consumers; frozen committed v1/v2 DB fixtures and three-generation consumer matrix are absent; report overstates evidence. Findings were independently confirmed from startup/store/migration/tests and returned to the original implementer. Minor disposition: remove ephemeral agent paths at Task 9 closeout; defer live `docs/history-v3-schema.md` update to frozen Task 12 doc-sync gate. Acceptance verifier may add findings but cannot erase these. Initial §6b audit: 7 commits, 0 missing progress updates.
- Task 10: blocked by Tasks 7, 8, 9; activation graph complete. Scheduler port, H2 lease install/freeze, dispatch slots, envelope, unique persistence sink, and transaction-A consumer must land in one activation commit.
- Task 11: blocked by Tasks 7 and 10; runtime-harness readiness complete with 0 blocker/0 major.
- Task 12: blocked by Tasks 1-11; docs/acceptance readiness complete. Live docs remain not-implemented; Bun clean-RST backlog stays open.
- Baseline deterministic performance fix: candidate `49ff6670` NOT integrated. Review found 3 accepted Important issues (copy observation dual-track, name-based recursion guard, wall-clock still gating); original implementer is fixing and same reviewer must re-review.

## Review gates

Each integrated task requires a review package from the recorded pre-task base through integrated HEAD, then independent task review with both verdicts: spec compliance and code quality. Critical/Important findings return to a subagent fixer and the same reviewer re-reviews. Task 12 additionally requires two orthogonal merged-state reviewers with `0 blocker / 0 major`.

Integration identity gate: parallel `Agent` results are not assumed to preserve dispatch order. Before integrating any agent commit, read its report and verify the actual brief path, base SHA, commit SHA, and `git show --name-only`; reject any file outside that task's frozen boundary unless the brief explicitly permits it. This gate was added after one Task 1 agent correctly stopped when it received a Task 2 oracle message intended for a different parallel result.

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
