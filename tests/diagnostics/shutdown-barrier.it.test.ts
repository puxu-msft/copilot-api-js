import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import {
  //
  attachBootstrapDiagnosticSpool,
  attachStructuredFileSink,
  resetStructuredFileSinkForTests,
  shutdownStructuredFileSink,
} from "~/lib/diagnostics/file"
import { createBus } from "~/lib/observability"

const dirs: Array<string> = []
afterEach(async () => {
  await shutdownStructuredFileSink().catch(() => {})
  resetStructuredFileSinkForTests()
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fresh(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-shutdown-barrier-"))
  dirs.push(directory)
  return directory
}

function digest(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url")
}

function diagnosticEventCounts(directory: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".ndjson"))) {
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as { record?: { diagnostic?: { event?: string } } }
      const event = parsed.record?.diagnostic?.event
      if (event) counts.set(event, (counts.get(event) ?? 0) + 1)
    }
  }
  return counts
}

describe("diagnostic production shutdown seam", () => {
  test("the globally attached sink is durably closed by shutdownStructuredFileSink", async () => {
    const directory = fresh()
    const bus = createBus()
    const sink = await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024 })
    bus.scope("system").publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "production-seam", message: "written through activeSink", origin: "native" }),
    })

    await shutdownStructuredFileSink()

    expect(sink.health.state).toBe("closed")
    expect(diagnosticEventCounts(directory)).toEqual(
      new Map([
        ["production-seam", 1],
        ["shutdown_diagnostic_sealing", 1],
      ]),
    )
  })

  test("bootstrap replay becomes active sink data and the spool is removed only after durability", async () => {
    const directory = fresh()
    const bus = createBus()
    const spool = attachBootstrapDiagnosticSpool(bus, directory)
    const system = bus.scope("system")
    system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "pre-cutover", message: "pre", origin: "native" }) })

    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024 })
    expect(fs.existsSync(spool.path)).toBe(true)
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "post-cutover", message: "post", origin: "native" }),
    })
    await shutdownStructuredFileSink()
    expect(fs.existsSync(spool.path)).toBe(false)

    expect(diagnosticEventCounts(directory)).toEqual(
      new Map([
        ["pre-cutover", 1],
        ["post-cutover", 1],
        ["shutdown_diagnostic_sealing", 1],
      ]),
    )
  })

  test("concurrent global shutdown callers share one terminal barrier", async () => {
    const directory = fresh()
    const bus = createBus()
    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024 })

    const first = shutdownStructuredFileSink()
    const second = shutdownStructuredFileSink()

    expect(second).toBe(first)
    await first
  })

  test("a failed spool cutover immediately restores a crash-retained fallback consumer", async () => {
    const directory = fresh()
    const bus = createBus()
    const system = bus.scope("system")
    const originalSpool = attachBootstrapDiagnosticSpool(bus, directory)
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "oversized-pre-cutover", message: "x".repeat(64 * 1024), origin: "native" }),
    })

    await expect(attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024, maxLengthBytes: 1024 })).rejects.toThrow(/dropped|durability/i)
    expect(fs.existsSync(originalSpool.path)).toBe(true)
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "post-failed-cutover", message: "fallback", origin: "native" }),
    })
    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024, maxLengthBytes: 1024 * 1024 })
    await shutdownStructuredFileSink()

    const counts = diagnosticEventCounts(directory)
    expect(counts.get("oversized-pre-cutover")).toBe(1)
    expect(counts.get("post-failed-cutover")).toBe(1)
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".spool.ndjson"))).toBe(false)
  })

  test("shutdown queued during a failing cutover waits for fallback ownership to settle", async () => {
    const directory = fresh()
    const bus = createBus()
    const system = bus.scope("system")
    attachBootstrapDiagnosticSpool(bus, directory)
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "cutover-race", message: "x".repeat(64 * 1024), origin: "native" }),
    })

    const attach = attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024, maxLengthBytes: 1024 })
    const firstShutdown = shutdownStructuredFileSink()
    const secondShutdown = shutdownStructuredFileSink()

    expect(secondShutdown).toBe(firstShutdown)
    await expect(attach).rejects.toThrow(/dropped|durability/i)
    await firstShutdown
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".spool.ndjson"))).toBe(true)
  })

  test("orphan WAL recovery skips a delivery already committed before the crash", async () => {
    const directory = fresh()
    const spoolId = "00000000-0000-0000-0000-000000000001"
    const payload = {
      recordType: "diagnostic" as const,
      diagnostic: createDiagnosticEvent({ level: "info", event: "crash-boundary", message: "once", origin: "native" }),
    }
    const delivery = { spoolId, sequence: 1, digest: digest(payload) }
    const record = {
      ...payload,
      delivery,
    }
    fs.writeFileSync(path.join(directory, "copilot-api-1-1.2026-07-18.1.ndjson"), `${JSON.stringify({ level: 30, record })}\n`)
    fs.writeFileSync(
      path.join(directory, `bootstrap-v2-99999999-1-1-${spoolId}.spool.ndjson`),
      `${JSON.stringify({ spoolId, sequence: 1, digest: delivery.digest, record: payload })}\n`,
    )
    const bus = createBus()
    attachBootstrapDiagnosticSpool(bus, directory)
    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024 })
    await shutdownStructuredFileSink()

    const occurrences = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".ndjson") && !name.endsWith(".spool.ndjson"))
      .flatMap((name) => fs.readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as { record?: { delivery?: typeof delivery } })
      .filter((line) => line.record?.delivery?.spoolId === spoolId && line.record.delivery.sequence === 1)
    expect(occurrences).toHaveLength(1)
  })

  test("a delivery-only or wrong-payload long-term line cannot suppress WAL recovery", async () => {
    const directory = fresh()
    const spoolId = "00000000-0000-0000-0000-000000000007"
    const payload = {
      recordType: "diagnostic" as const,
      diagnostic: createDiagnosticEvent({ level: "info", event: "must-replay", message: "correct", origin: "native" }),
    }
    const delivery = { spoolId, sequence: 7, digest: digest(payload) }
    fs.writeFileSync(
      path.join(directory, "copilot-api-1-1.2026-07-18.1.ndjson"),
      `${JSON.stringify({ record: { recordType: "diagnostic", diagnostic: { event: "wrong", message: "wrong" }, delivery } })}\n`,
    )
    fs.writeFileSync(
      path.join(directory, `bootstrap-v2-99999999-1-1-${spoolId}.spool.ndjson`),
      `${JSON.stringify({ spoolId, sequence: 7, digest: delivery.digest, record: payload })}\n`,
    )
    const bus = createBus()
    attachBootstrapDiagnosticSpool(bus, directory)
    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024 })
    await shutdownStructuredFileSink()

    expect(diagnosticEventCounts(directory).get("must-replay")).toBe(1)
  })

  test("an attach queued behind shutdown starts a new barrier generation", async () => {
    const firstDirectory = fresh()
    const secondDirectory = fresh()
    const firstBus = createBus()
    await attachStructuredFileSink(firstBus, { directory: firstDirectory, maxSizeBytes: 1024 * 1024 })

    const firstShutdown = shutdownStructuredFileSink()
    const secondSinkPromise = attachStructuredFileSink(createBus(), { directory: secondDirectory, maxSizeBytes: 1024 * 1024 })
    const secondShutdown = shutdownStructuredFileSink()

    expect(secondShutdown).not.toBe(firstShutdown)
    await firstShutdown
    const secondSink = await secondSinkPromise
    await secondShutdown
    expect(secondSink.health.state).toBe("closed")
  })

  test("the production WAL mirror honors the configured file threshold", async () => {
    const directory = fresh()
    const bus = createBus()
    attachBootstrapDiagnosticSpool(bus, directory)
    await attachStructuredFileSink(bus, { directory, maxSizeBytes: 1024 * 1024, level: "error" })
    const system = bus.scope("system")
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "filtered-info", message: "drop", origin: "native" }),
    })
    system.publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "error", event: "kept-error", message: "keep", origin: "native" }),
    })
    await shutdownStructuredFileSink()

    const counts = diagnosticEventCounts(directory)
    expect(counts.get("filtered-info")).toBeUndefined()
    expect(counts.get("kept-error")).toBe(1)
  })
})
