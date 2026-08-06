# Commit -1 T0.0e validator final report

## Scope and final state

T0.0e is complete in the integrated Commit -1 execution tree `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1` at `3b5ac1e41d87ab089becd55afe38f788643a4390`. It delivers the frozen validator CLI and C1～C11 for synthetic entry evidence only: pointer master reachability and shape, ENTRY/tree ancestry, external manifest/log trust, strict per-run JUnit/runtime/skipped artifacts, manifest/raw/entry reconciliation, exact baseline bytes and validator runtime closure provenance, plus atomic no-replace receipt v1 publication.

T0.0f, T0.0d, real A/P/P receipt consumption, and T0.1 remain explicit post-`master`-merge phases. They are not Commit -1 pending work. This implementation did not generate or consume real future A/P evidence.

## Evidence

- `tests/infra/validate-entry-evidence.unit.test.ts` has 32 synthetic temporary-repository tests and reconciles EV-01～EV-28. Coverage includes literal A2/P2 EV-27, receipt collision, non-ASCII C8 controls, C9 three-way controls, missing/directory/symlink artifacts, malformed JUnit and skipped identity schema arms, top-level aggregate directories, and validator/runtime-helper provenance mutations.
- C7 maps artifact directory, JUnit, runtime identity, and malformed JUnit directory/hash/read/parse/schema failures to stable rc=6/C7. C8 maps skipped multiset equivalent failures to stable rc=6/C8. C10 maps aggregate artifact read/hash failure to stable rc=7/C10. C9 compares manifest/raw/entry per run. C11 binds exact git-object baseline bytes and validator runtime dependencies to canonical ENTRY_SHA blobs before receipt publication.
- Receipt publication uses exclusive temporary creation and no-replace hard-link publication; collision returns rc=8 without overwriting existing receipt bytes.
- The former EV-02～EV-13 monolithic synthetic-graph test exceeded Bun’s 5s timeout under backend contention and was split by semantic condition; this is retained as superseded historical diagnosis, not a current validation failure.
- Final integrated evidence reported by the coordinator: `bun run test:backend` on `3b5ac1e41d87ab089becd55afe38f788643a4390` ran unit/it/http in 16 shards with `6728 pass，0 fail，6915 executed，26 skipped，36.68s`. `bun run typecheck` is green. These final figures supersede earlier branch-local backend counts.

## Completion and next action

T0.0a/b/c/e and Commit -1 integrated gates are complete. The remaining action is a whole-branch merged-state review, followed by merging Commit -1 to `master`. Only after that merge may real T0.0f/T0.0d/P/T0.1 begin.

## Structural-smell scan and reflection

- `scripts/parallel-test.ts:121-235` — producer/consumer split smell: JUnit and JSON artifacts could drift from shard results. Disposition: fixed in Commit -1 by atomic per-run artifacts and producer/validator reparse; final merged-state review must inspect this seam.
- `scripts/capture-entry-evidence.ts:147-217` and `scripts/validate-entry-evidence.ts:292-429` — duplicated trust-policy risk across producer and validator. Disposition: intentional independent evidence paths, not merged DRY; validator must distrust producer manifest and revalidate raw artifacts.
- `scripts/validate-entry-evidence.ts:92-357` — runtime import provenance is a fragile dynamic boundary. Disposition: fixed by canonical ENTRY_SHA closure check before dynamic import; synthetic helper mutations prove the guard bites.
- `tests/shutdown/fixtures/two_signal_pty.py:13-67` — log-as-readiness race. Disposition: fixed by concrete READY and `ICANON|ECHO` conditions; retain PTY integration oracle.
- `src/lib/history/in-flight.ts:42,108,148` — module-global test observer leakage. Disposition: fixed by resetter registration and deterministic same-instance/fresh-instance counts.
- `src/lib/context/model-operation-record.ts:595-613,811-813` — observer/algorithm divergence risk. Disposition: fixed by one recursive freeze primitive and a structural test guard; canonical gate expressly excludes metadata/extensions/headers and dispatch/candidate/transform copying because its fixtures do not vary them.

Better internal alternative: use the existing raw artifacts and recorder primitives rather than invent a parallel evidence or profiling pipeline. Criterion discriminating power: each substantive gate has a target mutation; notably cache-hit removal, quadratic arena traversal, validator helper drift, missing JUnit, and malformed artifact paths turn their intended assertions red. Mature third-party alternative: no library adopted for the narrow recorder operation counter or Bun-stable JUnit shape; a sampling profiler/XML stack would either reintroduce scheduler noise or expand surface without improving this frozen gate. Future changes that introduce richer XML or a new capture axis require re-evaluating that decision.
