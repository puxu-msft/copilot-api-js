import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { BootstrapDiagnosticSpool } from "~/lib/diagnostics/file/bootstrap-spool"
import { createBus } from "~/lib/observability"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("BootstrapDiagnosticSpool", () => {
  test("cutover partitions pre/post events and replays pre-cutover records file-only exactly once", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-"))
    dirs.push(directory)
    const bus = createBus()
    const spool = BootstrapDiagnosticSpool.attach(bus, { directory })
    const system = bus.scope("system")
    system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "pre", message: "pre", origin: "native" }) })
    system.publish({ kind: "system.model_catalog", models: [], tokenBasedBilling: true, timeUnixMs: 123 })

    const replayed: Array<string> = []
    const records = spool.retireAndRead()
    const post: Array<string> = []
    const unsub = bus.subscribe(
      (event) => {
        if (event.kind === "system.diagnostic") post.push(event.diagnostic.event)
      },
      undefined,
      { name: "post-cutover" },
    )
    system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "post", message: "post", origin: "native" }) })
    for (const record of records) replayed.push(record.recordType === "diagnostic" ? record.diagnostic.event : record.recordType)
    spool.removeDurably()
    unsub()

    expect(replayed).toEqual(["pre", "model-catalog"])
    expect(post).toEqual(["post"])
    expect(fs.existsSync(spool.path)).toBe(false)
  })
})
