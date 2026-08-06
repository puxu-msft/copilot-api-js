# Commit -1 integration regression — TerminalUi second Ctrl+C

## Root cause

The unrelated backend failure originated in `tests/shutdown/fixtures/two_signal_pty.py`, not the Commit -1 validator. After the first raw Ctrl+C, the fixture waited only for the synchronous emergency line “graceful shutdown started” and then sent a second Ctrl+C immediately. `handleShutdownSignal()` emits that line before its fire-and-forget shutdown-phase bus publication reaches `TerminalUi`; `TerminalUi` restores cooked input only when it consumes the later `system.shutdown_phase_changed` event. Under backend parallel contention, the second byte could therefore arrive while the PTY still had raw mode, causing the child/harness to exit with status 1.

## Fix and controls

The PTY harness now polls the terminal `lflag` for both `ICANON` and `ECHO` before emitting the second Ctrl+C. This is the same observable the test claims: first raw Ctrl+C must restore cooked mode before the second signal. The harness returns `cookedBeforeSecondSignal`, and the integration test requires it. The original marker-only control is superseded: the target control reverse-applied `wait_for_cooked_mode()`, forcibly cleared `ICANON|ECHO` through `termios.tcsetattr`, then derived `cooked_before_second_signal` from a fresh `termios.tcgetattr(fd)[3]` observation exactly as the production harness’s gate does. It sent the real second Ctrl+C through the existing PTY path without changing the TypeScript assertion. The TerminalUi test failed deterministically because the observed marker was false; reverse-apply restored the exact patch before verification.

## Evidence

- Direct harness after the fix emitted `{"firstAlive": true, "cookedBeforeSecondSignal": true, "exitCode": 130, "canonical": true, "echo": true, ...}`.
- Superseding target mutation JSON: `{"firstAlive": true, "cookedBeforeSecondSignal": false, "exitCode": 130, "canonical": true, "echo": true, ...}`. The focused IT failed in 789.33ms with `Expected: true`, `Received: false` for the marker observed from raw `lflag`; the exact patch reverse-apply check and reverse application succeeded with no residue.
- `bun test tests/shutdown/shutdown-signals.it.test.ts --rerun-each=20` passed: 80 pass, 0 fail after restoration.
- Restored `bun run test:backend` passed after the implementation commit: 16 shards, 6447 tests, 6447 pass, 0 fail, 6912 executed, 26 skipped, 42.85s. The code was unchanged after that restored run; no further backend-affecting edit followed.

## Startup-readiness regression

A distinct full-backend contention failure subsequently affected both `two_signal_pty.py` consumers: each stopped at the original two-second `read_until(b"READY")` deadline with empty PTY output. This is child startup readiness, not cooked-mode restoration. The harness now continues polling the required `READY` byte for a bounded six-second startup deadline, while explicitly reporting an exited child’s PID, exit status, and captured PTY output immediately instead of waiting to expire. The two ordinary two-signal process tests carry an explicit 14-second Bun timeout: Python can consume six seconds for `READY`, two seconds for the graceful-shutdown line, two seconds for cooked-mode restoration, and two seconds for forced exit, totaling 12 seconds. The outer two-second margin is only for Bun scheduling and post-subprocess assertions; internal condition deadlines remain named and unchanged, so `READY` is not weakened.

The harness accepts the test-only `TWO_SIGNAL_READY_DELAY_MS` before its child `exec`. A 2100ms delay proves that readiness beyond the old two-second threshold still reaches the real two-signal assertions. A missing child fixture proves early process exit reports `child closed PTY before b'READY'` with `exit=1` and captured PTY output immediately. `bun test tests/shutdown/shutdown-signals.it.test.ts --rerun-each=20` passed all 120 executions after the readiness change. A first full backend run after this change passed: 16 shards, 6276 tests, 6276 pass, 0 fail, 6914 executed, 26 skipped, in 43.47s. A later repeat failed only unrelated `tests/history/v3/canonical-performance.unit.test.ts` under parallel load (`sseRatio=10.3039`, threshold `<8`); its standalone run passed (`sseRatio=3.9669`), so this is a separate performance-flake investigation, not a PTY readiness regression.

## Deterministic in-flight summary memoization regression

`tests/history/in-flight-summary-memo.unit.test.ts` previously used an elapsed-time budget (`<50ms`) to infer that 1000 `toEntrySummary()` calls did not re-iterate a 200-message, 10-block-per-message request. That oracle was scheduling-sensitive and did not observe the claimed traversal. The shared preview extraction/cache base now exposes a test-only observer that counts actual message and block visits only while a preview is computed. The workload makes messages 199 through 1, plus blocks 0 through 8 of message 0, unsummarizable; only block 9 of message 0 contains the asserted final preview. This matches the production backward-message and forward-block scan order, requiring exactly `{ messages: 200, blocks: 2000 }` for the first summary, no additional visits for 999 same-instance summaries, and cumulative `{ messages: 400, blocks: 4000 }` after `updateInFlight()` creates a fresh instance.

The positive control applied the exact `/tmp/in-flight-summary-disable-weakmap-hit.patch`, changing only the `WeakMap` hit return. The focused test failed at the target cache assertion with expected `{ messages: 200, blocks: 2000 }` and received `{ messages: 200000, blocks: 2000000 }`; `git apply --reverse --check` followed by reverse application restored the hit guard with no mutation residue. `bun test tests/history/in-flight-summary-memo.unit.test.ts --rerun-each=20` passed 80 executions with 0 failures. The current restored `bun run test:backend` passed 16 shards, 4474 tests, 4474 pass, 0 fail, 6914 executed, and 26 skipped in 37.39s. `tests/history/v3/canonical-performance.unit.test.ts` is deliberately untouched: its wall-clock SSE-ratio flake remains a separate performance investigation.

## Scope

No production `src/` shutdown behavior changed. The fixes make the existing PTY integration oracle wait for the already-required terminal state and startup byte instead of treating earlier logging or an undersized process-start deadline as lifecycle readiness.

The in-flight change adds no production behavior: with no test observer installed, summary construction retains the existing WeakMap cache path and has no additional externally visible output.
