import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  getDimensionBreakdown,
  persistRequestTelemetry,
  recordSettledRequest,
} from "~/lib/request-telemetry"
import { setTelemetryConfig, snapshotStateForTests, restoreStateForTests, type StateSnapshot } from "~/lib/state"

let stateSnapshot: StateSnapshot
let tempDirectory: string
let databasePath: string

beforeEach(() => {
  stateSnapshot = snapshotStateForTests()
  tempDirectory = mkdtempSync(join(tmpdir(), "max-tokens-telemetry-"))
  databasePath = join(tempDirectory, "telemetry.db")
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(join(tempDirectory, "legacy.json"))
  setTelemetryConfig({ telemetryEnabled: true, telemetryDbPath: databasePath, telemetryPersistInterval: 0 })
})

afterEach(async () => {
  await _resetRequestTelemetryForTests()
  restoreStateForTests(stateSnapshot)
  rmSync(tempDirectory, { recursive: true, force: true })
})

test("max_tokens_truncation thinking counter survives telemetry persistence and independent readback", async () => {
  recordSettledRequest(
    { model: "claude-sonnet-4.6", endpoint: "anthropic-messages", max_tokens_truncation: "thinking" },
    {
      startedAt: 10_000,
      endedAt: 10_200,
      success: true,
      usage: { input_tokens: 7, output_tokens: 4 },
      generation: { candidates: 1, dispatches: 1, hedgeCandidates: 0, hedgeWins: 0, recoveryCandidates: 0, cancelledDispatches: 0, unknownUsageDispatches: 0 },
    },
    new Set(),
  )

  await persistRequestTelemetry()

  const breakdown = getDimensionBreakdown("max_tokens_truncation", "sinceStart")
  expect(breakdown.keys).toContainEqual(expect.objectContaining({ key: "thinking", counters: expect.objectContaining({ requestCount: 1 }) }))
})
