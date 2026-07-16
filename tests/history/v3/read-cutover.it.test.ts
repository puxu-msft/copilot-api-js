import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { getEntry, getHistorySummaries } from "~/lib/history/queries"
import { closeDatabase, getDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { commitPreparedOperation, prepareModelOperation, resetV3WriterForTests } from "~/lib/history/v3/store"

function record(id: string, kind: "generation" | "count_tokens") {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind, createdAt: kind === "generation" ? 2 : 1 } })
  const request = recorder.registerPayload({ model: "m", messages: [{ role: "user", content: id }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", method: "POST", path: "/v1/messages", request: { payload: request, metadata: { model: "m", messages: [{ role: "user", content: id }] } } })
  recorder.recordRouting({ requestedModel: "m", resolvedModel: "m", clientFormat: "anthropic" })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { payload: request } })
  recorder.recordEgress({ upstream: { payload: request }, client: { payload: request, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  for (const item of [record("generation-1", "generation"), record("tokens-1", "count_tokens")]) {
    commitPreparedOperation(getDatabase(), prepareModelOperation(item))
  }
})

afterEach(() => {
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 read cutover", () => {
  test("defaults list to generation and exposes explicit operationKind filters", () => {
    expect(getHistorySummaries().entries.map((entry) => entry.id)).toEqual(["generation-1"])
    expect(getHistorySummaries({ operationKind: "count_tokens" }).entries.map((entry) => entry.id)).toEqual(["tokens-1"])
    expect(getHistorySummaries({ operationKind: "all" }).entries.map((entry) => entry.id)).toEqual(["generation-1", "tokens-1"])
  })

  test("projects canonical detail without reading V2 rows", () => {
    expect(getEntry("generation-1")).toMatchObject({
      id: "generation-1",
      operationKind: "generation",
      state: "completed",
      clientRequest: { model: "m" },
      clientResponse: { status: 200 },
    })
  })
})
