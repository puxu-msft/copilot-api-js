import {
  //
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"

// Both cases spend their time spawning a fresh `bun` process (module resolution + transpile) and
// waiting out the child's 250ms uncaughtException window — roughly 0.6s isolated, and nothing here
// is timed. Bun's per-test budget is a wall-clock quantity, not one of this file's criteria: under
// the 16-shard runner (`scripts/parallel-test.ts`) CPU starvation stretched the guarded case past
// the 5s default and the shard log killed the still-running child ("killed 1 dangling process").
// Measured under deliberate contention it stays "slower but completes" (4.1s at 48 spinners, 3.9s
// at 64) — it does not wedge — so budget the file rather than weaken the exit-code/stderr oracles.
// 30s clears both 10x the isolated worst case and 3x the (censored) worst seen under sharding.
setDefaultTimeout(30_000)

/**
 * Subprocess crash-safety proof for the upstream-WS lifecycle callbacks.
 *
 * A throwing WHATWG `EventTarget` listener does NOT sync-throw out of
 * `dispatchEvent` — it escapes ASYNCHRONOUSLY as `uncaughtException`, which
 * main.ts turns into `process.exit(1)`. So an in-process `expect(...).not.toThrow()`
 * can never faithfully prove the guard prevents the crash: the async escape lands
 * after the assertion. The ONLY faithful proof spawns a child that installs
 * main.ts's crash policy and observes its exit code.
 *
 * The fixture (`fixtures/ws-crash-probe.ts`) picks distinct exit codes:
 *   - 42 = process crashed (uncaughtException policy fired)
 *   -  0 = clean survival (the absorbing layers held)
 *
 * "The guard" is really TWO layers of defence in depth on the onClose path — see the guarded
 * case below for which mutation turns which assertion red.
 *
 * The guarded leg additionally captures the child's stderr and asserts the
 * `onCallbackEscape` WARN ("callback threw; failing request ...") — exit 0 alone
 * is vacuity-prone (a refactor that leaves the callback unbound would also exit 0),
 * so the WARN proves the guard was actually EXERCISED, not silently skipped.
 *
 * `~/*` path aliases resolve in the spawned `bun <file>` via the worktree tsconfig
 * `paths` — verified by running the fixture directly during implementation.
 */
async function runProbe(mode: "guarded" | "raw-control"): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "tests/responses/fixtures/ws-crash-probe.ts", mode], {
    stdout: "pipe",
    stderr: "pipe",
  })
  // Capture stderr so the guarded leg can prove the guard was actually EXERCISED
  // (the onCallbackEscape WARN), not merely that the process happened to exit 0.
  // Read the stream to completion, then drain the exit code. The child binds no
  // network and self-exits, so there is no port/socket/process leak here.
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stderr }
}

describe("upstream-ws crash safety (subprocess)", () => {
  test("raw unguarded throwing EventTarget listener crashes (exit 42) — positive control", async () => {
    // Proves the harness can actually detect a crash: without guardCallback, the
    // async uncaughtException escape drives main.ts's exit policy.
    const { exitCode } = await runProbe("raw-control")
    expect(exitCode).toBe(42)
  })

  test("guarded upstream-ws lifecycle callback throw does NOT crash (exit 0) AND the guard is exercised", async () => {
    // A real createUpstreamWsConnection onClose callback throws. TWO layers absorb it, and it
    // matters which is which — the first alone keeps the process alive, and mutating only the
    // second leaves this case green (measured 2026-08-08):
    //   1. `notifyClosed`'s own try/catch (upstream-ws-connection.ts:164-173) catches the throw
    //      and emits the WARN this test matches on. Deleting just this catch keeps exit 0 but
    //      turns the stderr assertion below red, because layer 2's WARN reads differently
    //      ("callback threw; failing request + dropping connection").
    //   2. `guardCallback` around `handleClose`, whose onCallbackEscape absorbs whatever reaches
    //      it. Deleting BOTH is what finally turns the exit-code assertion red, with 42.
    // So: the exit code covers layer 2, the stderr match covers layer 1. Neither is redundant.
    const { exitCode, stderr } = await runProbe("guarded")
    expect(exitCode).toBe(0)
    // Exit 0 alone is vacuity-prone: assert the current onClose ownership-boundary WARN and
    // injected fault text so the callback guard is provably exercised rather than silently skipped.
    expect(stderr).toMatch(/\[upstream-ws\] onClose callback threw .*onClose-boom/)
  })
})
