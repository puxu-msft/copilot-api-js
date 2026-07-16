import { createBus } from "~/lib/observability"
import {
  //
  handleShutdownSignal,
  setShutdownPublisher,
  setupShutdownHandlers,
} from "~/lib/shutdown"
import { attachTerminalUi } from "~/lib/tui/terminal-ui"

const bus = createBus()
setShutdownPublisher(bus.scope("system"))
const shutdownOptions = {
  // Hold after the first signal. This fixture exercises the real TerminalUi raw
  // input path for Ctrl+C #1, then the restored cooked terminal's SIGINT path
  // for Ctrl+C #2.
  gracefulShutdownFn: () => new Promise<void>(() => {}),
}
attachTerminalUi(bus, { stdin: process.stdin, onShutdownSignal: (signal) => void handleShutdownSignal(signal, shutdownOptions) })
setupShutdownHandlers(shutdownOptions)

setInterval(() => {}, 60_000)
process.stdout.write("READY\n")
