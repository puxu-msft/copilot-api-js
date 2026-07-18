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
    const payloads = records.map((record) => record.record as { recordType: string; diagnostic?: { event?: string }; parts?: unknown })
    expect(payloads.map((record) => record.recordType).sort()).toEqual(["diagnostic", "diagnostic", "request-line"])
    expect(payloads.filter((record) => record.diagnostic?.event === "test.record")).toHaveLength(1)
    expect(payloads.filter((record) => record.diagnostic?.event === "shutdown_diagnostic_sealing")).toHaveLength(1)
    expect(payloads.filter((record) => record.recordType === "request-line")).toHaveLength(1)
    for (const payload of payloads) {
      if (payload.recordType === "diagnostic") {
        expect(payload.diagnostic).toBeDefined()
        expect(payload.parts).toBeUndefined()
      } else {
        expect(payload.parts).toBeDefined()
        expect(payload.diagnostic).toBeUndefined()
      }
    }
    bus.scope("system").publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "after-close", message: "must not reach Pino", origin: "native" }),
    })
    expect(sink.health.droppedAfterClose).toBe(1)
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

  test("uses the configured threshold as the only file-level filter", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-levels-"))
    dirs.push(directory)
    const bus = createBus()
    const sink = await StructuredFileSink.create(bus, { directory, maxSizeBytes: 1024 * 1024, level: "trace" })
    const system = bus.scope("system")
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      system.publish({
        kind: "system.diagnostic",
        diagnostic: createDiagnosticEvent({ level, event: `level.${level}`, message: level, origin: "native" }),
      })
    }
    await sink.close()

    const events = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".ndjson"))
      .flatMap((name) => fs.readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean))
      .map((line) => (JSON.parse(line) as { record: { diagnostic?: { event?: string } } }).record.diagnostic?.event)
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) expect(events).toContain(`level.${level}`)
  })
})
