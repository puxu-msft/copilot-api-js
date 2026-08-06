# Commit -1 integration regression — TerminalUi second Ctrl+C

## Root cause

The unrelated backend failure originated in `tests/shutdown/fixtures/two_signal_pty.py`, not the Commit -1 validator. After the first raw Ctrl+C, the fixture waited only for the synchronous emergency line “graceful shutdown started” and then sent a second Ctrl+C immediately. `handleShutdownSignal()` emits that line before its fire-and-forget shutdown-phase bus publication reaches `TerminalUi`; `TerminalUi` restores cooked input only when it consumes the later `system.shutdown_phase_changed` event. Under backend parallel contention, the second byte could therefore arrive while the PTY still had raw mode, causing the child/harness to exit with status 1.

## Fix and controls

The PTY harness now polls the terminal `lflag` for both `ICANON` and `ECHO` before emitting the second Ctrl+C. This is the same observable the test claims: first raw Ctrl+C must restore cooked mode before the second signal. The harness returns `cookedBeforeSecondSignal`, and the integration test requires it. A positive control setting that field to `false` made the TerminalUi test fail at that new assertion; it was restored before verification.

## Evidence

- Direct harness after the fix emitted `{"firstAlive": true, "cookedBeforeSecondSignal": true, "exitCode": 130, "canonical": true, "echo": true, ...}`.
- `bun test tests/shutdown/shutdown-signals.it.test.ts --rerun-each=20` passed: 80 pass, 0 fail.
- `bun run test:backend` must be rerun after this integration-only commit because the initial failure occurred only under backend parallel contention.

## Scope

No production `src/` shutdown behavior changed. The fix makes the existing PTY integration oracle wait for the already-required terminal state instead of treating earlier logging as a lifecycle-ready signal.
