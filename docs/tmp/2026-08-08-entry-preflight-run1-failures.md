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

The ready-live scenarios no longer use an uncontrolled real `setTimeout(20)`. They wait until the primary upstream call is reached and install `FakeClock` in selective mode: only the proxy's exact 1ms commit/heartbeat business timers are intercepted, while the SDK's 5-second request deadline and localhost I/O timers remain on real wall time. The test then advances those business timers deterministically before releasing the primary failure. A separate 30-second Bun test watchdog is only an escape hatch for a wedged harness. `finally` and `afterEach` both restore the clock so ordinary rejection and watchdog interruption cannot leak timer state into another test.

A dedicated 50ms SDK negative control uses an abort-aware never-responding upstream fake. It proves the selective business clock still lets the real SDK deadline fire as `APIConnectionTimeoutError`, while the fake mirrors the real abort protocol so teardown can settle. The exact mutation setting `preContentRecovery.enabled=false` makes all three ready-live SDK scenarios fail with the real SDK surfacing the stream `APIError`. Restoring the exact patch returns the suite to green.

## Verification

All numbers below are scoped to the `entry-preflight-fixes` worktree based on `14974488ef4a881a9fc2f15bb105f67e5f80e1bc`, commit `fc570601`, and the uncommitted six-file review-fix diff at measurement time:

- `bun test tests/infra/capture-entry-evidence.unit.test.ts`: 14 pass, 0 fail;
- `bun test tests/pipeline/client-sink.unit.test.ts`: 29 pass, 0 fail;
- `bun test tests/e2e-client/precontent-recovery.it.test.ts --rerun-each=10`: 70 pass, 0 fail;
- `bun test tests/infra/validate-entry-evidence.unit.test.ts`: 43 pass, 0 fail;
- `bun run typecheck`: exit 0;
- `bun run test:backend`: 16 shards, 6211 tests, 6208 pass, 3 fail, 7266 executed, 30 skipped;
- `git diff --check`: exit 0.

The `tests/pass` reporter count remains environment-sensitive and is not the population authority. T0.0f’s independent file identity, skipped multiset, and minimum executed floor remain the entry gate.

The three backend failures are not caused by this fix and are not real assertion failures. All three are `TimeoutError` from wall-clock budgets sized on an unloaded machine, and all three pass when their file is run alone:

| Test | Budget | Observed under 16 shards |
| --- | --- | --- |
| `tests/history/v3/store-performance.it.test.ts` — CAS live physical bytes | 15s explicit | 20.87s |
| `tests/infra/validate-entry-evidence.unit.test.ts` — rejects every missing or modified runtime dependency | 5s default | 5.37s |
| `tests/infra/validate-entry-evidence.unit.test.ts` — requires the bound SAX package graph | 5s default | 6.16s |

Their oracles are byte ratios and process exit codes, never elapsed time, so the budgets are incidental. They belong to the same false-red class as the precontent SDK timing fix and are handled after this branch merges current master.

## Failed evidence disposition and mandatory next step

The entire `/home/xp/.claude/jobs/bf526911/tmp/entry-evidence-A-14974488-run1` batch is permanently diagnostic-only. Its run-01 must not count toward any future 15-run batch; none of its JUnit, runtime identity, skipped multiset, or disk manifest may be copied into a successful manifest. The old entry `14974488ef4a881a9fc2f15bb105f67e5f80e1bc` and its cutover worktree do not remain the entry after this fix lands.

After `fc570601` and all follow-up review fixes are merged into master, the executor must read the resulting full master SHA as the new A, create a fresh execution worktree exactly at that A, and use a new empty tree-external OUT directory. The frozen producer must then generate a wholly new 15-run batch. Only that new manifest may be referenced by a new HANDOVER pointer commit P; only after A is proven an ancestor of P may the frozen validator produce the T0.0d receipt and T0.1 begin. The old run1, old A, and any partial artifacts are forbidden inputs to that chain.

## Review findings disposition

- Major 1 fixed: the summary selector is anchored to the complete `parallel-test.ts` grammar, including the sole optional crash clause and the terminal decimal-seconds field. Tests accept normal and crash summaries and reject pure artifacts, count-shaped forged suffixes, and truncated summaries.
- Major 2 fixed: `FakeClock` now supports selective delay interception with default all-timer behavior preserved for existing callers. The SDK e2e intercepts only 1ms proxy business timers; a real-time SDK timeout control proves the 5-second client deadline is no longer frozen.
- Major 3 fixed: the preceding disposition section permanently forbids run1, old A, and every partial artifact as inputs; it spells out merge→new A→fresh tree/OUT→new 15 runs→P→T0.0d→T0.1.

## Structural smell disposition

- `exp/inter-block-anchor-allocator/baseline-runs.sh:215`: text protocol parsing is a boundary smell, but the selected line is now a strict, fully anchored, tested producer grammar and the independent JUnit/runtime artifacts remain authoritative. Replacing the entire runner summary with another manifest would duplicate the existing artifact channel; no further mechanism is added in this fix.
- `tests/e2e-client/precontent-recovery.it.test.ts`: the prior real-time sleep leaked scheduler load into a client-behavior oracle; the first fix over-corrected by globally freezing the third-party SDK deadline. Selective interception now keeps the real client boundary while controlling only proxy business timers.
