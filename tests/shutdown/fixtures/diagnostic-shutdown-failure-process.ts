import { initDiagnosticLogger } from "~/lib/diagnostics"
import { attachStructuredFileSink } from "~/lib/diagnostics/file"
import { createBus } from "~/lib/observability"
import { initProcessIdentity } from "~/lib/process-identity"
import {
  //
  gracefulShutdown,
  setShutdownPublisher,
  setupShutdownHandlers,
  waitForShutdown,
} from "~/lib/shutdown"

const directory = process.argv[2]
if (!directory) throw new Error("diagnostic directory argument is required")

initProcessIdentity("diagnostic-shutdown-failure-fixture")
const bus = createBus()
const publisher = bus.scope("system")
initDiagnosticLogger(publisher)
setShutdownPublisher(publisher)
await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024, maxLengthBytes: 1024 })
publisher.publish({
  kind: "system.diagnostic",
  diagnostic: {
    schemaVersion: 1,
    timeUnixMs: Date.now(),
    severity: "info",
    scope: [],
    event: "fixture.forced-drop",
    message: "x".repeat(64 * 1024),
    process: { pid: process.pid, bootTime: Date.now(), version: "fixture" },
    fields: {},
    origin: "native",
  },
})

setupShutdownHandlers({
  gracefulShutdownFn: (signal) =>
    gracefulShutdown(signal, {
      tracker: { getActive: () => [] },
      server: { close: async () => {} },
      closeTokenRuntimeFn: async () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      shutdownHistoryFn: async () => {},
      shutdownRequestTelemetryFn: async () => {},
    }),
})

process.stdout.write("READY\n")
await waitForShutdown()
