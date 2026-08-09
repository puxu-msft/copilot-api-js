import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { getV3StoredOperation } from "~/lib/history/v3/store"

const tempRoots: Array<string> = []

afterEach(() => {
  closeDatabase()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("History V3 projection recovery script", () => {
  test("streams an idempotent import and applies an explicitly sourced timing override", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "history-v3-recovery-"))
    tempRoots.push(root)
    const input = path.join(root, "recovery.ndjson.gz")
    const dbPath = path.join(root, "history-v3.db")
    const overrides = path.join(root, "timing.json")
    const entry: HistoryEntry = {
      id: "recovered-script-entry",
      operationKind: "generation",
      startedAt: 1_000,
      endpoint: "anthropic-messages",
      state: "failed",
      clientRequest: { body: { model: "m", messages: [] }, model: "m", messages: [] },
      attempts: [{ index: 0, durationMs: 0, error: "timeout", upstreamResponse: { success: false, status: 0 } }],
      clientResponse: { status: 200, sseEvents: [{ offsetMs: 0, type: "error", raw: '{"type":"error"}' }] },
      _index: { derived: { responseSuccess: false, failureReason: "timeout", attemptCount: 1 } },
    }
    const ndjson = [JSON.stringify({ type: "header", capturedAt: 5_000 }), JSON.stringify({ type: "entry", entry })].join("\n") + "\n"
    writeFileSync(input, gzipSync(ndjson), { mode: 0o600 })
    writeFileSync(overrides, JSON.stringify({ [entry.id]: { durationMs: 900_100, source: "terminal-log-rounded" } }), { mode: 0o600 })

    const dryRunDb = path.join(root, "must-not-exist.db")
    const dryRun = Bun.spawn([process.execPath, "scripts/recover-history-v3-projections.ts", `--input=${input}`, `--db=${dryRunDb}`, "--dry-run"], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await dryRun.exited).toBe(0)
    expect(existsSync(dryRunDb)).toBe(false)

    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        [process.execPath, "scripts/recover-history-v3-projections.ts", `--input=${input}`, `--db=${dbPath}`, `--timing-overrides=${overrides}`],
        { cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
      )
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(exitCode, stderr).toBe(0)
    }

    // Explicit handle: db-param reads default to this thread's READONLY registry since the Batch 2b cutover, and this test owns a write handle on its own artifact rather than publishing one.
    const stored = getV3StoredOperation(entry.id, openDatabase(dbPath))!
    expect(stored).toMatchObject({ endedAt: 901_100, timingSource: "terminal-log-rounded" })
    expect(stored.record.extensions["history-v3.recovery"]).toMatchObject({ source: "projected-history-entry", capturedAt: 5_000 })
  })
})
