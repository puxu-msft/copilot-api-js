import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  consumeTerminalModelOperation,
  createLightweightModelOperation,
  listInFlightLightweightModelOperations,
  listTerminalModelOperations,
  MODEL_OPERATION_TERMINAL_REGISTRY_CAPACITY,
  resetModelOperationTerminalRegistryForTests,
} from "~/lib/context/lightweight-model-operation"
import { HistoryAdmissionControllerImpl } from "~/lib/history/worker/admission"
import { setHistoryAdmissionControllerForTests } from "~/lib/history/worker/registry"

function payloadValue(record: ReturnType<typeof listTerminalModelOperations>[number], handle: string | undefined): unknown {
  return record.arena.payloads.find((node) => node.handle === handle)?.value
}

describe("lightweight ModelOperation lifecycle", () => {
  beforeEach(() => resetModelOperationTerminalRegistryForTests())
  afterEach(() => setHistoryAdmissionControllerForTests(undefined))

  test("captures ingress, local attempt, actual client response, and releases consumed terminals", async () => {
    const semanticRequest = { model: "alias", contents: [{ text: "full semantic input" }] }
    const operation = createLightweightModelOperation({
      kind: "count_tokens",
      request: new Request("http://proxy.test/v1beta/models/alias:countTokens", {
        method: "POST",
        headers: { "content-type": "application/json", "x-source": "unit" },
      }),
      semanticRequest,
      format: "gemini",
      requestedModel: "alias",
      metadata: { caller: "unit" },
    })
    expect(listInFlightLightweightModelOperations()).toEqual([
      expect.objectContaining({ operationId: operation.operationId, kind: "count_tokens", method: "POST", path: "/v1beta/models/alias:countTokens" }),
    ])

    operation.recordRouting({ resolvedModel: "resolved-model", source: "local" })
    const attempt = operation.beginAttempt({
      source: "local",
      effectiveRequest: semanticRequest,
      wireRequest: { tokenizerText: "full semantic input" },
    })
    attempt.commit({
      result: { rawCount: 3, calibratedCount: 3 },
      usage: { inputTokens: 3 },
      metadata: { rawCount: 3, calibratedCount: 3 },
    })
    const response = new Response(JSON.stringify({ totalTokens: 3 }), {
      status: 200,
      headers: { "content-type": "application/json", "x-result": "local" },
    })
    const terminal = await operation.complete(response, {
      usage: { inputTokens: 3 },
      metadata: { countTokens: { rawCount: 3, calibratedCount: 3, source: "local" } },
    })

    expect(listInFlightLightweightModelOperations()).toHaveLength(0)
    expect(listTerminalModelOperations()).toEqual([terminal])
    expect(terminal.identity.kind).toBe("count_tokens")
    expect(terminal.ingress).toMatchObject({ method: "POST", path: "/v1beta/models/alias:countTokens", format: "gemini" })
    expect(terminal.ingress?.request.headers).toContainEqual(["x-source", "unit"])
    expect(payloadValue(terminal, terminal.ingress?.request.payload as string)).toEqual(semanticRequest)
    expect(terminal.routing).toMatchObject({ requestedModel: "alias", resolvedModel: "resolved-model", transport: "local" })
    expect(terminal.attempts[0]).toMatchObject({ verdict: "committed", metadata: { source: "local" } })
    expect(payloadValue(terminal, terminal.egress?.client.payload as string)).toEqual({ totalTokens: 3 })
    expect(terminal.egress?.client).toMatchObject({ status: 200, headers: expect.arrayContaining([["x-result", "local"]]) })
    expect(terminal.terminal).toMatchObject({
      outcome: "completed",
      metadata: { countTokens: { rawCount: 3, calibratedCount: 3, source: "local" } },
    })

    expect(consumeTerminalModelOperation(terminal.identity.operationId)).toBe(terminal)
    expect(listTerminalModelOperations()).toHaveLength(0)
  })

  test("releases History admission when response capture fails before terminal publication", async () => {
    const controller = new HistoryAdmissionControllerImpl({
      capacity: 1,
      sink: { enqueue: () => 1 },
    })
    setHistoryAdmissionControllerForTests(controller)
    const reservation = await controller.acquire({ signal: new AbortController().signal })
    const operation = createLightweightModelOperation({
      kind: "embeddings",
      request: new Request("http://proxy.test/v1/embeddings", { method: "POST" }),
      semanticRequest: { model: "embed", input: "capture failure" },
      requestedModel: "embed",
      historyReservation: reservation,
    })
    operation.recordRouting({ resolvedModel: "embed", source: "upstream", upstreamEndpoint: "/embeddings" })
    const attempt = operation.beginAttempt({ source: "upstream", effectiveRequest: {}, wireRequest: {} })
    attempt.commit({ result: { data: [] } })
    const captureError = new Error("response body capture failed")
    const response = new Response("{}")
    Object.defineProperty(response, "clone", {
      value: () =>
        ({
          headers: new Headers({ "content-type": "application/json" }),
          text: () => Promise.reject(captureError),
        }) as Response,
    })

    await expect(operation.complete(response)).rejects.toBe(captureError)
    expect(listInFlightLightweightModelOperations()).toHaveLength(0)
    expect(controller.snapshot()).toMatchObject({ reserved: 0, preTerminalFailuresTotal: 1, lastPreTerminalError: captureError.message })
    await controller.waitForQuiescence()
  })

  test("keeps the terminal registry bounded by evicting the oldest record", async () => {
    let firstId = ""
    for (let index = 0; index <= MODEL_OPERATION_TERMINAL_REGISTRY_CAPACITY; index += 1) {
      const operation = createLightweightModelOperation({
        kind: "embeddings",
        request: new Request(`http://proxy.test/v1/embeddings?case=${index}`, { method: "POST" }),
        semanticRequest: { model: "embed", input: String(index) },
        requestedModel: "embed",
      })
      if (index === 0) firstId = operation.operationId
      operation.recordRouting({ resolvedModel: "embed", source: "upstream", upstreamEndpoint: "/embeddings" })
      const attempt = operation.beginAttempt({ source: "upstream", effectiveRequest: {}, wireRequest: {} })
      attempt.commit({ result: { index } })
      await operation.complete(new Response(JSON.stringify({ index }), { headers: { "content-type": "application/json" } }))
    }

    const records = listTerminalModelOperations()
    expect(records).toHaveLength(MODEL_OPERATION_TERMINAL_REGISTRY_CAPACITY)
    expect(records.some((record) => record.identity.operationId === firstId)).toBe(false)
  })
})
