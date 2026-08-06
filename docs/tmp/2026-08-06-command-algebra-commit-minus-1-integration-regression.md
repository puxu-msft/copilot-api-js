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

## Scope

No production `src/` shutdown behavior changed. The fix makes the existing PTY integration oracle wait for the already-required terminal state instead of treating earlier logging as a lifecycle-ready signal.
