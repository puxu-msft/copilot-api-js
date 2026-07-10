import { describe, expect, test } from "bun:test"

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
 *   -  0 = clean survival (guard absorbed the throw)
 *
 * `~/*` path aliases resolve in the spawned `bun <file>` via the worktree tsconfig
 * `paths` — verified by running the fixture directly during implementation.
 */
async function runProbe(mode: "guarded" | "raw-control"): Promise<number> {
  const proc = Bun.spawn(["bun", "tests/responses/fixtures/ws-crash-probe.ts", mode], {
    stdout: "pipe",
    stderr: "pipe",
  })
  // Drain the child's exit code. The child binds no network and self-exits, so
  // there is no port/socket/process leak to clean up here.
  return await proc.exited
}

describe("upstream-ws crash safety (subprocess)", () => {
  test("raw unguarded throwing EventTarget listener crashes (exit 42) — positive control", async () => {
    // Proves the harness can actually detect a crash: without guardCallback, the
    // async uncaughtException escape drives main.ts's exit policy.
    expect(await runProbe("raw-control")).toBe(42)
  })

  test("guarded upstream-ws lifecycle callback throw does NOT crash (exit 0)", async () => {
    // A real createUpstreamWsConnection onClose callback throws; guardCallback must
    // absorb it (warn + mark unusable + fail request) so no uncaughtException fires.
    expect(await runProbe("guarded")).toBe(0)
  })
})
