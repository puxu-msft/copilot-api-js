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

- Task 1/1b: implementation complete on successor candidate `51286a05`; the original implementer transcript was physically unavailable, so the successor continued from the nine committed checkpoints. Final code review is Spec PASS / Quality APPROVED with 0 blocker/major/minor, and final acceptance PASSes with 0 Critical/Important/Minor. Explicit `preserve`/`fresh` rewrite provenance, fresh same-value IDs, public flat `createResponses`, internal rich `ParsedSseFrame`, History projection, reset/NUL/retry semantics, and production rewrite coverage are all closed. Task 37 integrated this candidate with Task 3's shared response-processor seam as `bd6afab5`; typecheck、target lint、139项定向、47项修复门和全backend `5664 pass / 0 fail` 已通过，等待独立合并态复审后关闭。
- Task 2: complete and integrated as `294aa803` + `a5b6eb43` + `1e7b527a`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important/Minor. Integrated-tree verification: grammar + boundary classifier 27 pass/0 fail, typecheck pass.
- Task 3: complete and integrated through local `98f15061` (the reviewed 18-commit adapter chain plus two handoff fixes). Final code review is Spec PASS / Quality APPROVED and acceptance PASS with 0 Critical/Important; integrated-tree verification is 125 pass / 0 fail across 14 files, typecheck pass, and target lint pass. The final shape uses one branded attempt-opts assembly path, preserves no-candidate live outcome shape, and keeps Chat/Responses/Anthropic buffered semantics green. Task 37 semantic merge with Task 1b is committed as `bd6afab5` and awaits independent merged-seam review；Task 4 remains blocked only on that review gate.
- Task 4: blocked by Task 3; readiness map complete. Preserve distinction between delivery-owner serializer and raw transport serializer; eliminate manual candidate-session field loss.
- Task 5: blocked by Task 4; frozen graph baseline complete: 6 roots/11 pumps, all 11 currently pendingLegacy. Guard must freeze root→pump pairs, cut at owner entry, and discover private sink owners without wrapper false positives.
- Task 6: blocked by Task 5; config-contract readiness complete with 0 blocker/0 major.
- Task 7: complete and integrated as `6b545360` + `b1873020` + `87e1eda1` + `1d24d9bf`. Final review: Spec PASS, Quality APPROVED, 0 Critical/Important, 2 non-blocking Minor. Integrated-tree verification: 57 pass/0 fail, typecheck pass, DATA callback unchanged at `src/lib/transport/http2-client.ts:1205`. Minor disposition: add `req` receiver AST mutation to downstream architecture/runtime verification; stale pre-hardening counts in the worktree-local report are not a product artifact.
- Task 8: complete and integrated as `38d0d1c5`..`025c0ba8` (10 commits). Final code review: Spec PASS, Quality APPROVED, 0 Critical/Important, 1 stale-progress Minor. Independent verification: Acceptance PASS, 0 Critical/Important/Minor, 12 probes/56 assertions. Integrated-tree verification: ledger 14 pass/0 fail, typecheck pass. Primitive remains inert; no production wiring. Progress Minor is superseded by this ledger and final git lineage.
- Task 9: 用户已于 2026-08-08 裁决范围 A；ready-summary 完整性架构与20格 canonical DML final-state matrix 已在 `993a64a9` 定稿并独立复审通过（Architecture PASS、Necessity CONFIRMED、0 blocker/Critical/Important/Minor）。接力分支 `agent-a76fa535d0dc7246e` 已从该终稿实现4个未集成 checkpoint：`c0db13ef` substrate、`7300cd5d` normalized refs、`9c1dcc6b` journal refs精确对账、`b2d629cb` progress；仍缺 strict primitive、20格 invalidation、ready snapshot、repair/GC复用和完整验收。范围排除 native UDF、签名、防篡改、范围B双轨与 production activation；不得把4个checkpoint误报为Task 9完成。
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

- Trust-first threat modeling: absent concrete anomaly evidence, assume participants are non-malicious and cover data corruption, program bugs, and operator mistakes only; do not add anti-malicious authority, signing, tamper resistance, or parallel tracks. Task 9 range A is the current application of this user decision.
- Mandatory block/item delivery; boundaryless protocols are response-terminal.
- No production live/cap-retreat bypass; no oversize-block spool fallback.
- HTTP/2 DATA callback unchanged; no extra work in that callback.
- Performance reports only, no fixed gate or zero-regression claim.
- Never start or terminate port 4141; no push.
- Do not update live DESIGN/API state before full implementation and merged-state verification.
