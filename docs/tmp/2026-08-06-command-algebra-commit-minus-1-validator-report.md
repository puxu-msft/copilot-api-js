# Commit -1 T0.0e validator report

## Scope and evidence state

T0.0e implementation and its whole-branch remediation are complete. The historical Commit -1 execution tree `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1` is not a current-state source. The validator delivers the frozen CLI and C1～C11 for synthetic entry evidence only: pointer master reachability and shape, ENTRY/tree ancestry, external manifest/log trust, strict per-run JUnit/runtime/skipped artifacts, manifest/raw/entry reconciliation, exact baseline bytes, trusted-bootstrap/local runtime closure provenance, resolved package-population identity, and atomic no-replace receipt v1 publication.

`tested_code_head=3b5ac1e41d87ab089becd55afe38f788643a4390` identifies only the historical 6728-pass measurement below. Immutable independent-review coverage closes original findings through `reviewed_branch_head=0fe17435f0c4f12ea28be6a1399704e6c289d70f`; `4fe920fca820f7dcee630d76e2aab120952eb7ea` is a backend-green integration merge candidate, not current/final HEAD and not A.

T0.0f, P, T0.0d, real A/P receipt consumption, and T0.1 remain explicit post-`master`-merge phases. They are not Commit -1 pending work. This implementation did not generate or consume real future A/P evidence. **Pre-merge A does not exist**；the final merge result defines an entry candidate that must be retaken and measured afterward.

## Evidence

- `tests/infra/validate-entry-evidence.unit.test.ts` reconciles EV-01～EV-28 and retains synthetic temporary-repository coverage for literal A2/P2 EV-27, receipt collision, non-ASCII C8 controls, C9 three-way controls, missing/directory/symlink artifacts, malformed JUnit and skipped identity schema arms, top-level aggregates, validator/helper provenance, physical-location-flexible packages, and observed/manifest package-population mismatches. Historical test-count snapshots remain in their measured report ranges; this paragraph intentionally does not present one as current.
- C7 maps artifact directory, JUnit, runtime identity, and malformed JUnit directory/hash/read/parse/schema failures to stable rc=6/C7. C8 maps skipped multiset equivalent failures to stable rc=6/C8. C10 maps aggregate artifact read/hash failure to stable rc=7/C10. C9 compares manifest/raw/entry per run. C11 uses an in-validator built-in bootstrap to bind the closure helper before execution, then validates exact git-object baseline/local runtime bytes and exact observed-vs-manifest package names, metadata, integrity, package-relative file population, and hashes before receipt publication.
- Receipt publication uses exclusive temporary creation and no-replace hard-link publication; collision returns rc=8 without overwriting existing receipt bytes.
- The former EV-02～EV-13 monolithic synthetic-graph test exceeded Bun’s 5s timeout under backend contention and was split by semantic condition; this is retained as superseded historical diagnosis, not a current validation failure.
- Historical integrated evidence reported by the coordinator: `bun run test:backend` on `tested_code_head=3b5ac1e41d87ab089becd55afe38f788643a4390` ran unit/it/http in 16 shards with `6728 pass，0 fail，6915 executed，26 skipped，36.68s`; `bun run typecheck` was green at that measurement point. These figures supersede earlier branch-local backend counts only for that exact code head; later fixes and review packages retain their own measured commits/ranges.

## Completion and next action

T0.0a/b/c/e、Commit -1 gates、whole-branch code findings、commit-message traceability 与 current-master sync review 已关闭。剩余动作是把 Commit -1 合入当时真实的 `master`；合入后重取并测量 `ENTRY_SHA=A`，再按 T0.0f → P → T0.0d → T0.1 继续。本文不把 branch/review/master-sync SHA 写成 A，也不写会随提交立刻过期的自指 final HEAD。

## Structural-smell scan and reflection

- `scripts/parallel-test.ts:121-235` — producer/consumer split smell: JUnit and JSON artifacts could drift from shard results. Disposition: fixed in Commit -1 by atomic per-run artifacts and producer/validator reparse; immutable merged-state review coverage inspected and closed this seam.
- `scripts/capture-entry-evidence.ts:147-217` and `scripts/validate-entry-evidence.ts:292-429` — duplicated trust-policy risk across producer and validator. Disposition: intentional independent evidence paths, not merged DRY; validator must distrust producer manifest and revalidate raw artifacts.
- `scripts/validate-entry-evidence.ts` runtime provenance boundary — fixed by a built-in bootstrap that checks the closure helper’s fixed canonical path and ENTRY blob before dynamic import, followed by recursive local/package closure validation; dirty-helper sentinel and package-population mutations prove both gates bite.
- `tests/shutdown/fixtures/two_signal_pty.py:13-67` — log-as-readiness race. Disposition: fixed by concrete READY and `ICANON|ECHO` conditions; retain PTY integration oracle.
- `src/lib/history/in-flight.ts:42,108,148` — module-global test observer leakage. Disposition: fixed by resetter registration and deterministic same-instance/fresh-instance counts.
- `src/lib/context/model-operation-record.ts:595-613,811-813` — observer/algorithm divergence risk. Disposition: fixed by one recursive freeze primitive and a structural test guard; canonical gate expressly excludes metadata/extensions/headers and dispatch/candidate/transform copying because its fixtures do not vary them.

Better internal alternative: use the existing raw artifacts and recorder primitives rather than invent a parallel evidence or profiling pipeline. Criterion discriminating power: each substantive gate has a target mutation; notably cache-hit removal, quadratic arena traversal, dirty validator-helper execution, package-population mismatch, missing JUnit, and malformed artifact paths turn their intended assertions red. Mature third-party alternative: JUnit parsing uses direct dependency `saxes@6.0.0`; no sampling profiler is added for the narrow recorder operation counter because it would reintroduce scheduler noise. Future changes that introduce a new XML or capture axis require re-evaluation.
