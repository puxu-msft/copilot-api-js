import {
  //
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { getDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
} from "~/lib/history/v3/store"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { createFullTestApp } from "../../helpers/test-app"

useIsolatedRuntime()

const app = createFullTestApp()

test("GET /history/api/entries/:id exposes all persisted upstream attempt timing instants", async () => {
  const recorder = createModelOperationRecorder({ identity: { operationId: "attempt-timing-rest", kind: "generation", createdAt: 1_000 } })
  const payload = recorder.registerPayload({ model: "m", messages: [] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", request: { payload } })
  const dispatch = recorder.beginAttempt({ upstreamRequest: { payload } })
  recorder.setDispatchTiming(dispatch, "upstreamHeadersAt", 1_010, "once")
  recorder.setDispatchTiming(dispatch, "upstreamMessageStartAt", 1_020, "once")
  recorder.setDispatchTiming(dispatch, "upstreamFirstTokenAt", 1_030, "once")
  recorder.setDispatchTiming(dispatch, "upstreamLastTokenAt", 1_040, "latest")
  recorder.settleAttempt(dispatch, { verdict: "committed" })
  const record = recorder.commitTerminal({ outcome: "completed", committedAttempt: dispatch })
  commitPreparedOperation(getDatabase(), prepareModelOperation(record))

  const response = await app.request("/history/api/entries/attempt-timing-rest")
  const entry = (await response.json()) as HistoryEntry

  expect(response.status).toBe(200)
  expect(entry.attempts?.[0]?.timing).toEqual({
    source: "canonical",
    upstreamHeadersAt: 1_010,
    upstreamMessageStartAt: 1_020,
    upstreamFirstTokenAt: 1_030,
    upstreamLastTokenAt: 1_040,
  })
})
