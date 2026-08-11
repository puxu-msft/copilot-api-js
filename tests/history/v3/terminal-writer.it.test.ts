import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { getTerminalModelOperation } from "~/lib/context/lightweight-model-operation"
import { createLightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import { createRequestContext } from "~/lib/context/request"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  drainV3Writer,
  enqueueModelOperation,
  getV3Operation,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import {
  //
  drainModelOperationTerminalSubscribers,
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"

import { historyTestReservation } from "../../helpers/history-terminal-publication"

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
  subscribeModelOperationTerminals(async (publication) => await enqueueModelOperation(publication.record))
})

afterEach(async () => {
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
})

describe("canonical terminal → V3 writer", () => {
  test("persists a generation terminal without delaying delivery", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages", historyReservation: historyTestReservation() })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: "ok" })
    ctx.finalizeModelOperationDelivery({ clientPayload: { role: "assistant", content: "ok" } })
    await ctx.whenModelOperationFinalized()

    expect(ctx.modelOperationTerminalRecord).not.toBeNull()
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()
    expect(getV3Operation(ctx.id)?.terminal?.outcome).toBe("completed")
  })

  test("persists a lightweight count_tokens terminal", async () => {
    const request = new Request("http://localhost/v1/messages/count_tokens", { method: "POST", body: "{}" })
    const operation = createLightweightModelOperation({
      kind: "count_tokens",
      request,
      semanticRequest: {},
      requestedModel: "m",
      historyReservation: historyTestReservation(),
    })
    operation.recordRouting({ source: "local", resolvedModel: "m" })
    const attempt = operation.beginAttempt({ source: "local", effectiveRequest: {}, wireRequest: {} })
    attempt.commit({ result: { input_tokens: 3 }, usage: { inputTokens: 3 } })
    const response = new Response(JSON.stringify({ input_tokens: 3 }), { headers: { "content-type": "application/json" } })
    const record = await operation.complete(response, { usage: { inputTokens: 3 } })

    expect(getTerminalModelOperation(record.identity.operationId)).toBe(record)
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()
    expect(getV3Operation(record.identity.operationId)?.identity.kind).toBe("count_tokens")
  })
})
