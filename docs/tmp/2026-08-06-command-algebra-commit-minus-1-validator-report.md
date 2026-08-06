# Commit -1 T0.0e validator checkpoint report

## Checkpoint scope

This checkpoint versions the frozen validator CLI parser plus C1-C6: pointer object/master reachability, unique pointer block and required fields, entry/tree/ancestry relation, external manifest raw hash, and the strict 15-log existence/hash check. It freezes the HANDOVER path, rejects canonical tree-contained manifest/receipt paths including nonexistent destinations and symlink parents, requires `schema_version: 1`, and rejects duplicate log realpaths. The receipt writer uses an invocation-unique exclusive temporary, writes the complete body through `writeFileSync(fd, body)`, then no-replace hard-link publishes; it cleans up only its own created temporary and preserves existing receipt or foreign temporary bytes.

## Evidence

- `bun test tests/infra/validate-entry-evidence.unit.test.ts` passed: 17 synthetic temporary-repository tests execute and register EV-01～EV-28, including literal A2/P2 EV-27, receipt collision, non-ASCII C8 controls, C9 three-way controls, and validator provenance.
- Runtime reconciliation output: `condition coverage: C1=2 C2=2 C3=3 C4=3 C5=2 C6=3 C7=1 C8=1 C9=5 C10=3 C11=3`; `mutation ownership: 28 IDs each map to exactly one condition`; `duplicate IDs: none`; `orphan IDs: none`。
- Reviewer finding dispositions: C7 validates per-run artifact schema/enumeration/containment/raw hashes; C8 validates strict artifact JSON and UTF-8 keyed multiset with non-ASCII false-red control; C9 validates manifest/raw/entry agreement; C11 uses exact git-object bytes and executing-validator blob provenance; the plan-derived runtime registry gates every successful EV assertion.
- `bun run typecheck` passed.
- `bunx prettier --check scripts/validate-entry-evidence.ts scripts/entry-evidence-receipt.ts tests/infra/validate-entry-evidence.unit.test.ts docs/tmp/2026-08-06-command-algebra-commit-minus-1-progress-validator.md docs/tmp/2026-08-06-command-algebra-commit-minus-1-validator-report.md` passed.

## Completion status

C1-C11 are implemented and the positive synthetic graph writes receipt v1 only after all conditions pass. EV-01 through EV-28 each have a focused mutation assertion with the frozen condition message; the structured mutation source mechanically asserts the planned condition counts, unique ownership, no duplicate/orphan IDs, and zero forbidden action terms. C7/C8 additionally validate full per-run artifact schemas, artifact-directory/log binding, JUnit directory enumeration, raw file hashes, and strict runtime/skipped JSON; their identity multiset is UTF-8 bytewise and has non-ASCII reordered testcase/suite positive plus multiplicity negative controls. C11 hashes exact binary-safe git object baseline bytes after fatal UTF-8 decoding, and receipt issuance verifies the executing validator’s path/blob against ENTRY_SHA. Receipt collision returns rc=8 without replacing the pre-existing receipt. `bun run test:backend` remains intentionally unrun because it is a Commit -1 integrated gate, not a T0.0e-only fixture check; C7-C11 are verified solely against synthetic artifacts.
