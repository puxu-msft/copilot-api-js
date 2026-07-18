import { createDiagnosticEvent } from "~/lib/diagnostics"
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const bus = createBus()
const system = bus.scope("system")
const ui = new TerminalUi(bus, {
  stdout: process.stdout,
  isTTY: true,
  stdin: process.stdin,
  onShutdownSignal: () => {
    ui.destroy()
    process.exit(0)
  },
})

function line(message: string): void {
  system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "test.job-control", message, origin: "native" }) })
}

process.on("SIGCONT", () => line("RESUMED"))
line("READY")
setInterval(() => {}, 1000)
