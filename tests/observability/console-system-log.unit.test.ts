import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import consola from "consola"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { createBus } from "~/lib/observability/bus"
import { installConsolaRepublish } from "~/lib/observability/republish"
import { TerminalUi } from "~/lib/tui"

function diagnostic(message: string) {
  return { kind: "system.diagnostic" as const, diagnostic: createDiagnosticEvent({ level: "info", event: "test.log", message, origin: "native" }) }
}

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

  test("system.diagnostic interleaves with request lifecycle lines in publish order", () => {
    const cap = makeCapture()
    const bus = createBus()
    const sink = new TerminalUi(bus, { stdout: cap.stdout, isTTY: false })
    const uninstall = installConsolaRepublish(bus.scope("system"))
    cleanups.push(() => {
      uninstall()
      sink.destroy()
    })

    const sys = bus.scope("system")
    sys.publish(diagnostic("before"))
    consola.level = 5
    consola.info("between")
    sys.publish(diagnostic("after"))

    const lines = cap.text().trimEnd().split("\n")
    expect(lines).toEqual(["[INFO] TT:TT:TT before", "[INFO] TT:TT:TT between", "[INFO] TT:TT:TT after"])
  })

  test("consola adapter derives human text only from the redacted snapshot", () => {
    const probe = "SYNTHETIC_SECRET_7f91"
    const captured: Array<string> = []
    const bus = createBus()
    const unsub = bus.subscribe((event) => {
      if (event.kind === "system.diagnostic") captured.push(JSON.stringify(event.diagnostic))
    })
    const uninstall = installConsolaRepublish(bus.scope("system"))
    cleanups.push(() => {
      unsub()
      uninstall()
    })

    consola.level = 5
    consola.error("auth failed", { access_token: probe }, Object.assign(new Error(`authorization=${probe}`), { authorization: probe }))

    expect(captured).toHaveLength(1)
    expect(captured[0]).not.toContain(probe)
    expect(captured[0]).toContain("[REDACTED]")
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
      if (e.kind === "system.diagnostic" && handledCount === 0) {
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
      if (e.kind === "system.diagnostic" && handledCount === 0) {
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
