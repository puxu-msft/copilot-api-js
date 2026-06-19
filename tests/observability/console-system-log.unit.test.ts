import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import consola from "consola"

import { createBus } from "~/lib/observability/bus"
import { installConsolaRepublish } from "~/lib/observability/republish"
import { ConsoleSink } from "~/lib/observability/sinks/console"

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
    const sink = new ConsoleSink(bus, { stdout: cap.stdout, isTTY: false })
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
    const sink = new ConsoleSink(bus, { stdout: cap.stdout, isTTY: false })
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
    // the reentrancy guard. Assert the guard routes the reentrant call away
    // (to stderr) instead of re-publishing into an infinite fan-out.
    const cap = makeCapture()
    const bus = createBus()
    const sink = new ConsoleSink(bus, { stdout: cap.stdout, isTTY: false })
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
    // (it went to stderr), so only the original "trigger" line is on stdout.
    expect(cap.text()).toBe("[INFO] TT:TT:TT trigger\n")
  })
})
