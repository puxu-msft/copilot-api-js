# Commit -1 integration regression — TerminalUi second Ctrl+C

## Root cause

The unrelated backend failure originated in `tests/shutdown/fixtures/two_signal_pty.py`, not the Commit -1 validator. After the first raw Ctrl+C, the fixture waited only for the synchronous emergency line “graceful shutdown started” and then sent a second Ctrl+C immediately. `handleShutdownSignal()` emits that line before its fire-and-forget shutdown-phase bus publication reaches `TerminalUi`; `TerminalUi` restores cooked input only when it consumes the later `system.shutdown_phase_changed` event. Under backend parallel contention, the second byte could therefore arrive while the PTY still had raw mode, causing the child/harness to exit with status 1.

## Fix and controls

The PTY harness now polls the terminal `lflag` for both `ICANON` and `ECHO` before emitting the second Ctrl+C. This is the same observable the test claims: first raw Ctrl+C must restore cooked mode before the second signal. The harness returns `cookedBeforeSecondSignal`, and the integration test requires it. A target positive control reverse-applied `wait_for_cooked_mode()`, forcibly cleared `ICANON|ECHO` through `termios.tcsetattr`, and then sent the real second Ctrl+C through the existing PTY path. The TerminalUi test failed deterministically at `cookedBeforeSecondSignal === true`; reverse-apply restored the exact patch before verification.

## Evidence

- Direct harness after the fix emitted `{"firstAlive": true, "cookedBeforeSecondSignal": true, "exitCode": 130, "canonical": true, "echo": true, ...}`.
- Target mutation failure: `bun test ... --test-name-pattern "TerminalUi raw Ctrl.C restores cooked mode before the second signal"` failed in 616.85ms with `Expected: true`, `Received: false` for `cookedBeforeSecondSignal`; the exact patch reverse-apply check and reverse application succeeded.
- `bun test tests/shutdown/shutdown-signals.it.test.ts --rerun-each=20` passed: 80 pass, 0 fail.
- Restored `bun run test:backend` passed: 16 shards, 6447 tests, 6447 pass, 0 fail, 6912 executed, 26 skipped, 42.85s.

## Scope

No production `src/` shutdown behavior changed. The fix makes the existing PTY integration oracle wait for the already-required terminal state instead of treating earlier logging as a lifecycle-ready signal.
