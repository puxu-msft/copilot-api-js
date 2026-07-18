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
import { BootstrapDiagnosticSpool } from "~/lib/diagnostics/file/bootstrap-spool"
import { createBus } from "~/lib/observability"
import { readProcStartTicks } from "~/lib/process-identity"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function digest(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url")
}

describe("BootstrapDiagnosticSpool", () => {
  test("cutover partitions pre/post events and replays pre-cutover records file-only exactly once", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-"))
    dirs.push(directory)
    const bus = createBus()
    const spool = BootstrapDiagnosticSpool.attach(bus, { directory })
    const system = bus.scope("system")
    system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "pre", message: "pre", origin: "native" }) })
    system.publish({ kind: "system.diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "pre-2", message: "pre-2", origin: "native" }) })
    system.publish({ kind: "system.model_catalog", models: [], tokenBasedBilling: true, timeUnixMs: 123 })
    const captured = fs
      .readFileSync(spool.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sequence: number })
    expect(captured.map((line) => line.sequence)).toEqual([captured[0].sequence, captured[0].sequence + 1, captured[0].sequence + 2])

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

    expect(replayed).toEqual(["pre", "pre-2", "model-catalog"])
    expect(post).toEqual(["post"])
    expect(fs.existsSync(spool.path)).toBe(false)
  })

  test("replays a dead-owner orphan spool before current boot records", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-orphan-"))
    dirs.push(directory)
    const orphan = path.join(directory, "bootstrap-99999999-1-00000000-0000-0000-0000-000000000000.spool.ndjson")
    const orphanRecord = {
      recordType: "diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "orphan", message: "orphan", origin: "native" }),
    }
    fs.writeFileSync(orphan, `${JSON.stringify(orphanRecord)}\n`, { mode: 0o600 })
    const bus = createBus()
    const spool = BootstrapDiagnosticSpool.attach(bus, { directory })
    bus.scope("system").publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "current", message: "current", origin: "native" }),
    })

    const events = spool
      .retireAndRead()
      .filter((record) => record.recordType === "diagnostic")
      .map((record) => record.diagnostic.event)
    expect(events).toEqual(["orphan", "current"])
    spool.removeDurably()
    expect(fs.existsSync(orphan)).toBe(false)
  })

  test("a no-progress short write becomes a sticky durability failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-short-write-"))
    dirs.push(directory)
    const bus = createBus()
    let writes = 0
    const spool = BootstrapDiagnosticSpool.attach(bus, {
      directory,
      write: (fd, buffer, offset, length) => {
        writes++
        if (writes > 1) return 0
        return fs.writeSync(fd, buffer, offset, Math.min(8, length))
      },
    })
    bus.scope("system").publish({
      kind: "system.diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "short-write", message: "short", origin: "native" }),
    })

    expect(() => spool.retireAndRead()).toThrow(/no progress/i)
    expect(fs.existsSync(spool.path)).toBe(true)
  })

  test("recovers valid lines from a corrupt orphan once and retains the damaged artifact", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-corrupt-"))
    dirs.push(directory)
    const orphan = path.join(directory, "bootstrap-v2-99999999-1-1-00000000-0000-0000-0000-000000000002.spool.ndjson")
    const record = { recordType: "diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "valid-prefix", message: "valid", origin: "native" }) }
    fs.writeFileSync(orphan, `${JSON.stringify({ spoolId: "orphan", sequence: 1, digest: digest(record), record })}\n{truncated`)
    const spool = BootstrapDiagnosticSpool.attach(createBus(), { directory })

    const records = spool.retireAndRead()

    expect(records.some((item) => item.recordType === "diagnostic" && item.diagnostic.event === "valid-prefix")).toBe(true)
    expect(fs.readdirSync(directory).some((name) => name.includes(".corrupt-"))).toBe(true)
  })

  test("isolates a JSON-valid but structurally invalid orphan record", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-semantic-corrupt-"))
    dirs.push(directory)
    const orphan = path.join(directory, "bootstrap-v2-99999999-1-1-00000000-0000-0000-0000-000000000004.spool.ndjson")
    fs.writeFileSync(orphan, `${JSON.stringify({ spoolId: "invalid", sequence: 1, digest: digest(null), record: null })}\n`)
    const spool = BootstrapDiagnosticSpool.attach(createBus(), { directory })

    expect(spool.retireAndRead()).toEqual([])
    expect(fs.readdirSync(directory).some((name) => name.includes(".corrupt-"))).toBe(true)
  })

  test("only one live spool instance can claim a dead-owner orphan", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-claim-"))
    dirs.push(directory)
    const orphan = path.join(directory, "bootstrap-v2-99999999-1-1-00000000-0000-0000-0000-000000000005.spool.ndjson")
    const record = { recordType: "diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "claim-once", message: "claim", origin: "native" }) }
    fs.writeFileSync(orphan, `${JSON.stringify({ spoolId: "claim", sequence: 1, digest: digest(record), record })}\n`)
    const first = BootstrapDiagnosticSpool.attach(createBus(), { directory })
    const second = BootstrapDiagnosticSpool.attach(createBus(), { directory })

    expect(first.retireAndRead().some((item) => item.recordType === "diagnostic" && item.diagnostic.event === "claim-once")).toBe(true)
    expect(second.retireAndRead().some((item) => item.recordType === "diagnostic" && item.diagnostic.event === "claim-once")).toBe(false)
  })

  test("reclaims an orphan after multiple claimant crashes without nesting claim syntax", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-reclaim-chain-"))
    dirs.push(directory)
    const base = "bootstrap-v2-99999999-1-1-00000000-0000-0000-0000-000000000006.spool.ndjson"
    const record = {
      recordType: "diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "reclaim-chain", message: "chain", origin: "native" }),
    }
    const doubleClaim = path.join(directory, `${base}.claim-v1-99999998-1-a.claim-v1-99999997-1-b`)
    fs.writeFileSync(doubleClaim, `${JSON.stringify({ spoolId: "chain", sequence: 1, digest: digest(record), record })}\n`)

    const spool = BootstrapDiagnosticSpool.attach(createBus(), { directory })
    expect(spool.recoveryArtifacts.some((artifact) => artifact.includes(".claim-v1-") && !artifact.includes(".claim-v1-99999998"))).toBe(true)
    expect(spool.retireAndRead().some((item) => item.recordType === "diagnostic" && item.diagnostic.event === "reclaim-chain")).toBe(true)
  })

  test("WAL ownership survives a provisional sink mirror failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-mirror-failure-"))
    dirs.push(directory)
    const bus = createBus()
    const spool = BootstrapDiagnosticSpool.attach(bus, { directory })
    spool.setMirror(() => {
      throw new Error("provisional sink failed")
    })
    const system = bus.scope("system")
    for (let index = 0; index < 25; index++) {
      system.publish({
        kind: "system.diagnostic",
        diagnostic: createDiagnosticEvent({ level: "info", event: `mirror-${index}`, message: String(index), origin: "native" }),
      })
    }

    const events = spool
      .snapshotAndContinue()
      .filter((record) => record.recordType === "diagnostic")
      .map((record) => record.diagnostic.event)
    expect(events).toEqual(Array.from({ length: 25 }, (_, index) => `mirror-${index}`))
  })

  test("treats a reused live PID with different proc start ticks as an orphan owner", () => {
    const actualTicks = readProcStartTicks(process.pid)
    if (actualTicks === undefined) return
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-spool-pid-reuse-"))
    dirs.push(directory)
    const orphan = path.join(directory, `bootstrap-v2-${process.pid}-${actualTicks + 1}-1-00000000-0000-0000-0000-000000000003.spool.ndjson`)
    const record = { recordType: "diagnostic", diagnostic: createDiagnosticEvent({ level: "info", event: "pid-reuse", message: "reuse", origin: "native" }) }
    fs.writeFileSync(orphan, `${JSON.stringify({ spoolId: "reuse", sequence: 1, digest: digest(record), record })}\n`)

    const recovered = BootstrapDiagnosticSpool.attach(createBus(), { directory }).retireAndRead()
    expect(recovered.some((item) => item.recordType === "diagnostic" && item.diagnostic.event === "pid-reuse")).toBe(true)
  })
})
