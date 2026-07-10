// Spawned by ../upstream-ws-crash-safety.sub.test.ts.
//
// Why a subprocess: a throwing WHATWG `EventTarget` listener does NOT sync-throw
// out of `dispatchEvent`; it escapes ASYNC as `uncaughtException`. In-process that
// escape lands on Bun's default handler AFTER the test's `expect(...).not.toThrow()`
// has already passed — so an in-proc test can NEVER faithfully prove "no crash".
// The only faithful proof installs main.ts's crash policy in a child process and
// observes its exit code.
//
// This fixture reproduces main.ts's `uncaughtException`/`unhandledRejection` →
// `process.exit(EXIT_CRASH)` policy, then branches on argv[2]:
//   - "raw-control": an UNGUARDED throwing EventTarget listener → the throw escapes
//     as uncaughtException → child exits EXIT_CRASH (42). Proves the harness can
//     actually detect a crash (a positive control for the negative assertion).
//   - "guarded": drives a real `createUpstreamWsConnection` lifecycle callback
//     (`onClose`) that throws. `guardCallback` must absorb it → NO uncaughtException
//     → child self-exits EXIT_SURVIVE (0).

const EXIT_CRASH = 42
const EXIT_SURVIVE = 0

// Replicate main.ts's global crash policy (src/main.ts lines 24-32), but with a
// distinct crash code so the parent can distinguish "process crashed" (42) from
// "clean survival" (0).
process.on("uncaughtException", () => process.exit(EXIT_CRASH))
process.on("unhandledRejection", () => process.exit(EXIT_CRASH))

const mode = process.argv[2]

if (mode === "raw-control") {
  // No guardCallback: a throwing listener escapes dispatchEvent asynchronously as
  // uncaughtException → the policy above exits EXIT_CRASH before the setTimeout below.
  const target = new EventTarget()
  target.addEventListener("boom", () => {
    throw new Error("raw-control-boom")
  })
  target.dispatchEvent(new Event("boom"))
  // If (counterfactually) no uncaughtException fired, we would exit clean — that
  // would make the control FAIL loudly instead of masking a broken harness.
  setTimeout(() => process.exit(EXIT_SURVIVE), 250)
} else if (mode === "guarded") {
  // Path alias `~/*` resolves via the worktree tsconfig `paths` — Bun reads it when
  // running a script whose nearest tsconfig defines them. Verified by running this
  // fixture directly (see the sub test's header + task report).
  const { createUpstreamWsConnection } = await import("~/lib/openai/upstream-ws-connection")

  // Minimal WHATWG-EventTarget fake socket. `createSocket` is overridden so NOTHING
  // touches the network (no port/socket bound); the connection is pure in-process.
  class FakeSocket extends EventTarget {
    readyState = 0
    readonly OPEN = 1
    readonly CONNECTING = 0
    send(): void {}
    close(): void {
      this.readyState = this.OPEN
      this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "probe" }))
    }
    open(): void {
      this.readyState = this.OPEN
      this.dispatchEvent(new Event("open"))
    }
  }

  const socket = new FakeSocket()
  const conn = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.5",
    createSocket: () => socket as never,
    // A real lifecycle callback that throws: handleClose invokes opts.onClose()
    // inside guardCallback, so this throw must be absorbed (warn + mark unusable +
    // fail request), NOT escalated to uncaughtException.
    onClose: () => {
      throw new Error("onClose-boom")
    },
  })

  // connect() registers the "open" listener synchronously; open() then fires it and
  // binds the long-lived close listener; dispatching "close" drives handleClose →
  // guarded opts.onClose throw.
  void conn.connect().catch(() => {})
  socket.open()
  socket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "probe" }))

  // Give any async uncaughtException a generous window to fire before we declare
  // survival. If the guard works, none fires → clean exit.
  setTimeout(() => process.exit(EXIT_SURVIVE), 250)
} else {
  // Unknown mode — fail loudly so a typo in the harness can't masquerade as a pass.
  process.stderr.write(`ws-crash-probe: unknown mode ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
