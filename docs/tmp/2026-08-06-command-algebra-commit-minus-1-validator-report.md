# Commit -1 T0.0e validator checkpoint report

## Checkpoint scope

This checkpoint versions the frozen validator CLI parser plus C1-C6: pointer object/master reachability, unique pointer block and required fields, entry/tree/ancestry relation, external manifest raw hash, and the strict 15-log existence/hash check. It freezes the HANDOVER path, rejects canonical tree-contained manifest/receipt paths including nonexistent destinations and symlink parents, requires `schema_version: 1`, and rejects duplicate log realpaths. The receipt writer uses an invocation-unique exclusive temporary, writes the complete body through `writeFileSync(fd, body)`, then no-replace hard-link publishes; it cleans up only its own created temporary and preserves existing receipt or foreign temporary bytes.

## Evidence

- `bun test tests/infra/validate-entry-evidence.unit.test.ts` passed: five synthetic temporary-repository tests cover the C1-C6 positive path to the explicit C7 stop, pointer failures, realpath-alias logs, unordered legal manifest keys plus version rejection, frozen HANDOVER/nonexistent or symlinked path containment, full receipt body write, and receipt collision preservation.
- `bun run typecheck` passed.
- `bunx prettier --check scripts/validate-entry-evidence.ts scripts/entry-evidence-receipt.ts tests/infra/validate-entry-evidence.unit.test.ts` passed.

## Completion status

C1-C11 are implemented and the positive synthetic graph writes receipt v1 only after all conditions pass. EV-01 through EV-28 each have a focused mutation assertion with the frozen condition message; the structured mutation source mechanically asserts the planned condition counts, unique ownership, no duplicate/orphan IDs, and zero forbidden action terms. Receipt collision returns rc=8 without replacing the pre-existing receipt. `bun run test:backend` remains intentionally unrun because it is a Commit -1 integrated gate, not a T0.0e-only fixture check; C7-C11 are verified solely against synthetic artifacts.
