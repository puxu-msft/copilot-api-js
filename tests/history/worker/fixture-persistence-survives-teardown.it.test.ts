/**
 * The unified test fixture must leave History able to persist — in EVERY test, not just the first.
 *
 * This exists because it did not. `afterEach` ran `resetTestRuntime()` (which brings History up and points the admission controller's sink at the fresh runtime) and THEN ran the `RESETTERS` loop, which released that very runtime. Every test after the first therefore started with an empty registry and an admission sink aimed at a runtime that had already been shut down — and `enqueue` on a stopped runtime settles `"failed"` immediately without writing, throwing, or logging. Across the 129 files that use this fixture, "make a request, then assert History recorded it" was structurally impossible to satisfy, and nothing said so.
 *
 * The shape of the bug is why the assertion lives in a SECOND test: the first one passes either way. Every new test file written during the cutover independently worked around this by calling `initHistory(false)` in its own `beforeEach` — three of them, each with a comment describing the same symptom from a different angle. Those are workarounds; this is the regression.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { getHistoryReadDatabase } from "~/lib/history/sqlite/read-connection"
import { drainModelOperationTerminalSubscribers } from "~/lib/history/v3/terminal-bus"
import { publishModelOperationTerminal } from "~/lib/history/v3/terminal-bus"
import { getHistoryAdmissionController } from "~/lib/history/worker/registry"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

function terminalRecord(id: string): ReturnType<typeof createModelOperationRecorder>["commitTerminal"] extends never ? never : ReturnType<ReturnType<typeof createModelOperationRecorder>["commitTerminal"]> {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 1 } })
  const payload = recorder.registerPayload({ model: "m", messages: [] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", request: { payload, metadata: { model: "m", messages: [] } } })
  const attempt = recorder.beginAttempt({ upstreamRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { metadata: { model: "m" } } })
  recorder.recordEgress({ upstream: {}, client: {} })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

/** Drive the real production chain: reserve, publish the terminal, let the sole subscriber hand it to whatever writer is installed, then look at the database directly. */
async function persistThroughProductionChain(operationId: string): Promise<number> {
  const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
  reservation.bindOperationId(operationId)
  publishModelOperationTerminal(historyTerminalPublication(terminalRecord(operationId)))
  await drainModelOperationTerminalSubscribers()
  const row = getHistoryReadDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id = ?").get(operationId) as { n: number }
  return row.n
}

describe("the isolated fixture leaves History able to persist", () => {
  useIsolatedRuntime()

  test("first test in the file persists through the production chain", async () => {
    expect(await persistThroughProductionChain("fixture-persist-1")).toBe(1)
  })

  test("SECOND test in the file persists too — the fixture's own teardown must not disarm the writer", async () => {
    // The one that used to fail. Same code as above; the only difference is that a full `afterEach` has run in between.
    expect(await persistThroughProductionChain("fixture-persist-2")).toBe(1)
  })

  test("and a third, so a fix that merely survives one teardown does not look complete", async () => {
    expect(await persistThroughProductionChain("fixture-persist-3")).toBe(1)
  })
})
