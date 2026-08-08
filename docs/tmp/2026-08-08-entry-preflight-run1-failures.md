# Entry preflight run 1 failures and fixes

## Scope and failed evidence

Entry candidate `14974488ef4a881a9fc2f15bb105f67e5f80e1bc` was measured from `/home/xp/src/copilot-api-js/.worktrees/command-algebra-cutover` with the frozen T0.0f producer. The first batch wrote the disk manifest plus run-01 log/JUnit/runtime/skip artifacts under `/home/xp/.claude/jobs/bf526911/tmp/entry-evidence-A-14974488-run1`, then exited 5 before aggregate publication. `evidence-manifest.json` was absent, so no pointer P was created and T0.0d did not start.

The original `run-01.log` reports `16 shards · 7259 tests · 7258 pass · 1 fail · 7259 executed · 30 skipped`. The failing test was `tests/e2e-client/precontent-recovery.it.test.ts` case `ready-live ping recovery yields one coherent SDK message`: the real Anthropic SDK request timed out after the test’s fixed 5-second wall-clock budget under the 16-shard load.

The producer’s immediate stderr said `reported no tests`. That diagnosis was separately wrong: `baseline-runs.sh` selected the last line containing `parallel-test`; the newer `[parallel-test] artifacts=...` line follows the count summary, so the parser discarded the real `7259 tests / 1 fail` summary.

## Fix 1: summary parsing

`baseline-runs.sh` now selects the structured count summary shape containing shards, tests, pass, fail, executed, and skipped fields. It no longer treats a later artifact-location line as the summary.

`tests/infra/capture-entry-evidence.unit.test.ts` runs the real shell script in a temporary Git repository with a fake runner that emits a count summary followed by an artifacts line:

- runner rc 0: wrapper rc 0 and `tests seen: 10`;
- runner rc 7: wrapper remains red, preserves `tests seen: 10`, reports `run 01 exited 7`, and does not claim `reported no tests`.

The exact mutation restoring the old broad `grep 'parallel-test' | tail -1` selector makes the success control fail at the target exit-code assertion. Restoring the exact patch returns the focused tests to green.

## Fix 2: deterministic SDK recovery timing

The test remains a genuine client e2e: a real `@anthropic-ai/sdk` client calls the in-process localhost proxy and `.finalMessage()` remains the oracle for parse/fold behavior. The SDK timeout stays 5 seconds.

The ready-live scenarios no longer use an uncontrolled real `setTimeout(20)`. They wait until the primary upstream call is reached, install `FakeClock`, advance the recovery timers deterministically, then release the primary failure. A separate 30-second Bun test watchdog is only an escape hatch for a wedged harness. `finally` and `afterEach` both restore the fake clock so ordinary rejection and watchdog interruption cannot leak global timers into another test.

The exact mutation setting `preContentRecovery.enabled=false` makes all three ready-live SDK scenarios fail with the real SDK surfacing the stream `APIError`. Restoring the exact patch returns the suite to green.

## Verification

All numbers below are scoped to the `entry-preflight-fixes` worktree based on `14974488ef4a881a9fc2f15bb105f67e5f80e1bc` plus the uncommitted three-file fix at measurement time:

- `bun test tests/infra/capture-entry-evidence.unit.test.ts`: 11 pass, 0 fail;
- `bun test tests/e2e-client/precontent-recovery.it.test.ts --rerun-each=10`: 60 pass, 0 fail;
- `bun run typecheck`: exit 0;
- `bun run test:backend`: 16 shards, 6106 tests, 6106 pass, 0 fail, 7261 executed, 30 skipped;
- `git diff --check`: exit 0.

The `tests/pass` reporter count remains environment-sensitive and is not the population authority. T0.0f’s independent file identity, skipped multiset, and minimum executed floor remain the entry gate.

## Structural smell disposition

- `exp/inter-block-anchor-allocator/baseline-runs.sh:215`: text protocol parsing is a boundary smell, but the selected line is now a strict, tested protocol shape and the independent JUnit/runtime artifacts remain authoritative. Replacing the entire runner summary with another manifest would duplicate the existing artifact channel; no further mechanism is added in this fix.
- `tests/e2e-client/precontent-recovery.it.test.ts:111-157`: the prior real-time sleep leaked scheduler load into a client-behavior oracle. This round fixes it with a controlled clock while preserving the real SDK boundary.
