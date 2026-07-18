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
import { StructuredFileSink } from "~/lib/diagnostics/file"
import { createBus } from "~/lib/observability"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("StructuredFileSink", () => {
  test("writes per-process parseable NDJSON with mutually-exclusive record payloads", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-file-"))
    dirs.push(directory)
    const bus = createBus()
    const sink = await StructuredFileSink.create(bus, { directory, maxSizeBytes: 1024 * 1024 })
    bus.scope("system").publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "warn", event: "test.record", message: "hello", fields: { count: 1n }, origin: "native" }),
    })
    bus.scope("system").publish({
      kind: "system.request_line",
      parts: { prefix: "[ OK ]", time: "12:00:00", method: "POST", path: "/v1/messages" },
    })
    await sink.close()

    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".ndjson"))
    expect(files.length).toBeGreaterThan(0)
    const records = files.flatMap((name) =>
      fs
        .readFileSync(path.join(directory, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    expect(records).toHaveLength(3)
    expect(records.every((record) => Object.keys(record).filter((key) => key === "record").length === 1)).toBe(true)
    expect(records.map((record) => (record.record as { recordType: string }).recordType).sort()).toEqual(["diagnostic", "diagnostic", "request-line"])
    expect(records.some((record) => (record.record as { diagnostic?: { event?: string } }).diagnostic?.event === "shutdown.diagnostic-sealing")).toBe(true)
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    for (const file of files) expect(fs.statSync(path.join(directory, file)).mode & 0o777).toBe(0o600)
  })

  test("queue drops make the durability barrier reject instead of reporting shutdown success", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-drop-"))
    dirs.push(directory)
    const bus = createBus()
    const sink = await StructuredFileSink.create(bus, { directory, maxSizeBytes: 0, maxLengthBytes: 16 * 1024 })
    const system = bus.scope("system")
    const payload = "x".repeat(1024)
    for (let index = 0; index < 500; index++) {
      system.publish({
        kind: "system.diagnostic",
        diagnostic: createDiagnosticEvent({ level: "info", event: "drop-probe", message: `${index}:${payload}`, origin: "native" }),
      })
    }
    await expect(sink.close()).rejects.toThrow(/dropped|durability/i)
    expect(sink.health.droppedBytes).toBeGreaterThan(0)
  })
})
