import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { StructuredFileSink } from "~/lib/diagnostics/file"
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test("a random secret-key probe is reachable in the raw source but absent from canonical, terminal, and structured file tracks", async () => {
  const probe = `RANDOM-CREDENTIAL-${crypto.randomUUID()}`
  const raw = { access_token: probe, nested: { authorization: probe } }
  expect(JSON.stringify(raw)).toContain(probe) // positive control: the oracle can see a leak

  const terminalChunks: Array<string> = []
  const stdout = { isTTY: false, write: (value: string) => (terminalChunks.push(value), true) } as unknown as NodeJS.WritableStream
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "credential-tracks-"))
  dirs.push(directory)
  const bus = createBus()
  const terminal = new TerminalUi(bus, { stdout, isTTY: false })
  const file = await StructuredFileSink.create(bus, { directory })
  const diagnostic = createDiagnosticEvent({
    level: "error",
    event: "credential-probe",
    message: `access_token=${probe}`,
    fields: raw,
    error: Object.assign(new Error(`authorization=${probe}`), { authorization: probe }),
    origin: "native",
  })
  bus.scope("system").publish({ kind: "system.diagnostic", diagnostic })
  await file.close()
  terminal.destroy()

  const fileText = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n")
  expect(JSON.stringify(diagnostic)).not.toContain(probe)
  expect(terminalChunks.join("")).not.toContain(probe)
  expect(fileText).not.toContain(probe)
})
