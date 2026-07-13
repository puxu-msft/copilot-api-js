import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import consola from "consola"

import { createBus } from "~/lib/observability/bus"
import { installConsolaRepublish } from "~/lib/observability/republish"
import { TerminalUi } from "~/lib/tui"

/** Collect stdout bytes from a sink, normalizing the HH:MM:SS stamp. */
function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: false } as unknown as NodeJS.WritableStream
  return {
    stdout,
    text: () => chunks.join("").replaceAll(/\d\d:\d\d:\d\d/g, "TT:TT:TT"),
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  consola.level = 3
})

describe("ConsoleSink ← system.log (consola republish non-regression)", () => {
  test("consola.info/warn render byte-identical to the pre-refactor hijack path", () => {
    // Golden captured from the OLD ConsoleSink (which hijacked consola directly)
    // before the system.log refactor — see RFC §3 C4 invariant.
    const golden = '[INFO] TT:TT:TT hello world\n[WARN] TT:TT:TT danger {"code":42}\n'

    const cap = makeCapture()
    const bus = createBus()
    const sink = new TerminalUi(bus, { stdout: cap.stdout, isTTY: false })
    const uninstall = installConsolaRepublish(bus.scope("system"))
    cleanups.push(() => {
      uninstall()
      sink.destroy()
    })

    consola.level = 5
    consola.info("hello world")
    consola.warn("danger", { code: 42 })

    expect(cap.text()).toBe(golden)
  })

  test("system.log interleaves with request lifecycle lines in publish order", () => {
    const cap = makeCapture()
    const bus = createBus()
    const sink = new TerminalUi(bus, { stdout: cap.stdout, isTTY: false })
    const uninstall = installConsolaRepublish(bus.scope("system"))
    cleanups.push(() => {
      uninstall()
      sink.destroy()
    })

    const sys = bus.scope("system")
    sys.publish({ kind: "system.log", logType: "info", message: "before", time: Date.now() })
    consola.level = 5
    consola.info("between")
    sys.publish({ kind: "system.log", logType: "info", message: "after", time: Date.now() })

    const lines = cap.text().trimEnd().split("\n")
    expect(lines).toEqual(["[INFO] TT:TT:TT before", "[INFO] TT:TT:TT between", "[INFO] TT:TT:TT after"])
  })

  test("republish reporter does not recurse when a consola call fires during fan-out", () => {
    // A sink that logs via consola during its own handling would loop without
    // the reentrancy guard. Assert the guard routes the reentrant call through
    // `emergencyWrite` (P2.2) instead of re-publishing into an infinite fan-out.
    const cap = makeCapture()
    const bus = createBus()
    const sink = new TerminalUi(bus, { stdout: cap.stdout, isTTY: false })
    const uninstall = installConsolaRepublish(bus.scope("system"))
    // A second subscriber that calls consola.warn on every system.log — the
    // classic recursion trigger.
    let handledCount = 0
    const unsub = bus.subscribe((e) => {
      if (e.kind === "system.log" && handledCount === 0) {
        handledCount++
        consola.warn("reentrant warning")
      }
    })
    cleanups.push(() => {
      unsub()
      uninstall()
      sink.destroy()
    })

    consola.level = 5
    expect(() => consola.info("trigger")).not.toThrow()
    // The reentrant consola.warn must NOT have produced a second bus fan-out
    // (no second system.log event was published), but IS written out via
    // `emergencyWrite` — this instance is non-interactive with no footer
    // visible ("none" state), so it write-throughs straight to this sink's own
    // stdout (P2.2 registration; not a bare untracked `process.stderr.write`
    // anymore).
    expect(cap.text()).toBe("[INFO] TT:TT:TT trigger\n[LOG ] reentrant warning\n")
  })

  test("republish's reentrant fallback routes through emergencyWrite (falls back to stderr with no TerminalUi registered)", () => {
    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write

    const bus = createBus()
    const uninstall = installConsolaRepublish(bus.scope("system"))
    let handledCount = 0
    const unsub = bus.subscribe((e) => {
      if (e.kind === "system.log" && handledCount === 0) {
        handledCount++
        consola.warn("reentrant warning")
      }
    })

    try {
      consola.level = 5
      expect(() => consola.info("trigger")).not.toThrow()
    } finally {
      process.stderr.write = original
      unsub()
      uninstall()
    }

    // No TerminalUi is registered in this test — emergencyWrite's unregistered
    // fallback writes straight to stderr, matching the pre-P2.2 behavior.
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    expect(stderrWrite.mock.calls[0][0]).toBe("[LOG ] reentrant warning\n")
  })
})
