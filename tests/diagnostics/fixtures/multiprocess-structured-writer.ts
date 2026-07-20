import { createDiagnosticEvent } from "~/lib/diagnostics"
import { StructuredFileSink } from "~/lib/diagnostics/file"
import { createBus } from "~/lib/observability"
import { initProcessIdentity } from "~/lib/process-identity"

const [directory, prefix, countText] = process.argv.slice(2)
if (!directory || !prefix) throw new Error("usage: writer <directory> <prefix> <count>")
const count = Number(countText ?? 100)
initProcessIdentity("test")
const bus = createBus()
const sink = await StructuredFileSink.create(bus, { directory, maxSizeBytes: 4096, maxFilesPerProcess: 0, retentionDays: 0 })
const system = bus.scope("system")
for (let i = 0; i < count; i++) {
  system.publish({
    kind: "system.diagnostic",
    diagnostic: createDiagnosticEvent({ level: "info", event: "multiprocess", message: `${prefix}-${String(i).padStart(4, "0")}`, origin: "native" }),
  })
}
await sink.close()
