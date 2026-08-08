/**
 * `shutdownHistory` surgery (History V2 removal Phase 3): the V2 async-finalize
 * drain (`drainPendingFinalizations`/`retryPendingFinalizations`) was removed
 * along with the V2 write chain — its sole caller (the deleted `HistorySink`)
 * had no production mount point. This test locks the post-surgery contract:
 *
 *   1. `shutdownHistory` does NOT reference any deleted V2 collection-drain
 *      function — asserted via source-text grep (typecheck already enforces
 *      this at the import level, but a behavioral test must not rely solely
 *      on "no compile error", per empirical-verification discipline).
 *   2. `shutdownHistory` still drains the V3 pipeline (terminal-bus
 *      subscribers + the V3 writer's own pending/in-flight commits) BEFORE
 *      closing the DB — a terminal record published just before shutdown must
 *      be durably persisted, not silently dropped by an early `closeDatabase`.
 *      Proven with a REAL on-disk db + reopen (`:memory:` cannot prove this —
 *      each open is a fresh empty db, so a would-be-dropped-record bug would
 *      be invisible there).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  closeDatabase,
  isDatabaseOpen,
} from "~/lib/history/sqlite/connection"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { getV3StoredOperation } from "~/lib/history/v3/store"
import { publishModelOperationTerminal } from "~/lib/history/v3/terminal-bus"
import { getHistoryAdmissionController } from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"

import { historyTerminalPublication } from "../helpers/history-terminal-publication"

function terminalRecord(id: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: Date.now() } })
  const payload = recorder.registerPayload({ prompt: "shutdown-drain-probe" }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload }, upstreamRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: {} })
  recorder.recordEgress({ upstream: {}, client: {} })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

describe("shutdownHistory (post-V2-removal surgery)", () => {
  test("source no longer references any deleted V2 collection-drain function", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, "../../src/lib/history/state.ts"), "utf8")
    // No import from the deleted `./entries` module (which housed these V2
    // functions) — the surgical removal target. Doc comments MAY still mention
    // the function names for historical context (as they do above), so this
    // checks the actual code reference (a call expression), not every substring.
    expect(source).not.toMatch(/from ["']\.\/entries["']/)
    expect(source).not.toMatch(/\bdrainPendingFinalizations\(\)/)
    expect(source).not.toMatch(/\bretryPendingFinalizations\(\)/)
    // The V3 drain chain must still be present and referenced in shutdownHistory.
    expect(source).toMatch(/drainModelOperationTerminalSubscribers\(\)/)
    expect(source).toMatch(/drainV3Writer\(\)/)
  })

  describe("behavioral: a record published just before shutdown is durably persisted", () => {
    let dir: string
    let dbPath: string

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-shutdown-"))
      dbPath = path.join(dir, "history-v3.db")
      setStateForTests({ historyDbPath: dbPath })
      await initHistory(true)
    })

    afterEach(() => {
      setStateForTests({ historyDbPath: "" })
      if (isDatabaseOpen()) closeDatabase()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("record published via the terminal-bus survives shutdownHistory + reopen", async () => {
      const record = terminalRecord("shutdown-drain-durable-probe")
      const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
      reservation.bindOperationId(record.identity.operationId)
      // Mirrors production: a request settling just before shutdown publishes its
      // terminal record via the terminal-bus subscriber `initHistory` wires
      // (`subscribeModelOperationTerminals(enqueueModelOperation)`), NOT a direct
      // `enqueueModelOperation` call — this exercises the actual subscriber →
      // writer → drain chain `shutdownHistory` is responsible for draining.
      publishModelOperationTerminal(historyTerminalPublication(record))

      await shutdownHistory()
      expect(isDatabaseOpen()).toBe(false)

      // Reopen the SAME on-disk db — the durability proof. If shutdownHistory had
      // closed the DB before draining the writer, this record would be missing.
      await initHistory(true)
      const stored = getV3StoredOperation("shutdown-drain-durable-probe")
      expect(stored).toBeDefined()
      expect(stored?.record.identity.operationId).toBe("shutdown-drain-durable-probe")
    })
  })
})
