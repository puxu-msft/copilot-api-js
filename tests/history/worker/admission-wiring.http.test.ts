import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createLightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import { createRequestContextManager } from "~/lib/context/manager"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import {
  //
  HistoryAdmissionControllerImpl,
  type HistoryReservation,
} from "~/lib/history/worker/admission"
import { withHistoryAdmission } from "~/lib/history/worker/http-admission"
import { setHistoryAdmissionControllerForTests } from "~/lib/history/worker/registry"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { createFullTestApp } from "../../helpers/test-app"

const app = createFullTestApp()

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const pending = Symbol("pending")
  expect(
    await Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      Promise.resolve(pending),
    ]),
  ).toBe(pending)
}

describe("production History admission wiring", () => {
  useIsolatedRuntime()

  let controller: HistoryAdmissionControllerImpl

  beforeEach(async () => {
    setStateForTests({ historyDbPath: ":memory:" })
    controller = new HistoryAdmissionControllerImpl({
      capacity: 1,
      sink: {
        enqueue(_envelope, onOutcome) {
          onOutcome("failed")
          return 1
        },
      },
    })
    setHistoryAdmissionControllerForTests(controller)
    await initHistory(true)
  })

  afterEach(async () => {
    await shutdownHistory()
    setHistoryAdmissionControllerForTests(undefined)
  })

  test("binds reservations to RequestContext and lightweight operation IDs without reusing rate-limit wait", () => {
    const bound: Array<string> = []
    const reservation = {
      reservationId: "fixture-reservation",
      admittedAt: 100,
      historyAdmissionWaitMs: 37,
      bindOperationId: (operationId: string) => bound.push(operationId),
      releaseBeforeBinding: () => {},
    }

    const manager = createRequestContextManager({ armDeadlineTimers: false })
    const ctx = manager.create({ endpoint: "anthropic-messages", historyReservation: reservation })
    const lightweight = createLightweightModelOperation({
      kind: "count_tokens",
      request: new Request("http://localhost/v1/messages/count_tokens", { method: "POST" }),
      semanticRequest: { model: "m", messages: [] },
      historyReservation: reservation,
    })

    expect(bound).toEqual([ctx.id, lightweight.operationId])
    expect(ctx.historyAdmissionWaitMs).toBe(37)
    expect(ctx.queueWaitMs).toBe(0)
  })

  test("returns a no-op reservation when History is disabled", async () => {
    await shutdownHistory()
    await initHistory(false)
    const held = await controller.acquire({ signal: new AbortController().signal })

    const result = await withHistoryAdmission(
      new Request("http://localhost/v1/messages/count_tokens", { signal: new AbortController().signal }),
      "count_tokens",
      async (reservation: HistoryReservation) => {
        reservation.bindOperationId("disabled-op")
        return reservation.historyAdmissionWaitMs
      },
    )

    expect(result).toBe(0)
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 0 })
    held.releaseBeforeBinding("release fixture capacity")
  })

  test("releases an unbound reservation when the operation returns without binding", async () => {
    await expect(withHistoryAdmission(new AbortController().signal, "count_tokens", async () => "no operation")).resolves.toBe("no operation")
    expect(controller.snapshot()).toMatchObject({ reserved: 0, waiting: 0 })
  })

  test("releases an unbound reservation when operation setup throws", async () => {
    await expect(
      withHistoryAdmission(new AbortController().signal, "count_tokens", async () => {
        throw new Error("setup failed before operation ID")
      }),
    ).rejects.toThrow("setup failed before operation ID")
    expect(controller.snapshot()).toMatchObject({ reserved: 0, waiting: 0 })
  })

  test("leaves a bound reservation for the operation finalizer to adjudicate after a handler throw", async () => {
    await expect(
      withHistoryAdmission(new AbortController().signal, "count_tokens", async (reservation) => {
        reservation.bindOperationId("bound-handler-error")
        throw new Error("handler failed after binding")
      }),
    ).rejects.toThrow("handler failed after binding")
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 0 })

    controller.failBeforeTerminal("bound-handler-error", new Error("canonical finalizer rejected"))
    expect(controller.snapshot()).toMatchObject({ reserved: 0, waiting: 0, preTerminalFailuresTotal: 1 })
  })

  test("releases a reservation when codec parsing throws after context construction", async () => {
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })

    const response = await app.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [{}],
      }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    await controller.waitForQuiescence()
    expect(controller.snapshot()).toMatchObject({ reserved: 0, waiting: 0, unacked: 0 })
  })

  test("every HTTP operation route blocks at the production admission boundary", async () => {
    const requests = [
      ["/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }],
      ["/responses", { model: "gpt-4o", input: "hi" }],
      ["/v1/messages", { model: "claude-sonnet-4.6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }],
      ["/embeddings", { model: "text-embedding-3-small", input: "hi" }],
      ["/v1/messages/count_tokens", { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "hi" }] }],
      ["/v1beta/models/gpt-4o:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
      ["/v1beta/models/gpt-4o:countTokens", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
    ] as const
    const held = await controller.acquire({ signal: new AbortController().signal })

    for (const [path, body] of requests) {
      const clientAbort = new AbortController()
      const response = Promise.resolve(
        app.request(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: clientAbort.signal,
          }),
        ),
      )
      await expectPending(response)
      expect(controller.snapshot(), path).toMatchObject({ reserved: 1, waiting: 1 })
      clientAbort.abort(new Error(`cancel ${path}`))
      await response
      expect(controller.snapshot(), path).toMatchObject({ reserved: 1, waiting: 0 })
    }

    held.releaseBeforeBinding("release fixture capacity")
  })

  test("management, History, metrics, and dry-run surfaces bypass model admission", async () => {
    const held = await controller.acquire({ signal: new AbortController().signal })
    const requests: ReadonlyArray<{ request: Request; expectedStatus: number }> = [
      { request: new Request("http://localhost/health/liveness"), expectedStatus: 200 },
      { request: new Request("http://localhost/history/api/entries"), expectedStatus: 200 },
      { request: new Request("http://localhost/api/status"), expectedStatus: 200 },
      { request: new Request("http://localhost/metrics"), expectedStatus: 200 },
      {
        request: new Request("http://localhost/api/debug/dry-run-pipeline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        expectedStatus: 400,
      },
    ]

    for (const { request, expectedStatus } of requests) {
      const response = await app.request(request)
      const path = new URL(request.url).pathname
      expect(response.status, path).toBe(expectedStatus)
      if (path === "/history/api/entries") {
        const body = (await response.json()) as { entries: unknown; total: unknown }
        expect(Array.isArray(body.entries)).toBe(true)
        expect(typeof body.total).toBe("number")
      }
      expect(controller.snapshot(), path).toMatchObject({ reserved: 1, waiting: 0 })
    }

    held.releaseBeforeBinding("release fixture capacity")
  })

  test("blocks a model operation at capacity without blocking liveness", async () => {
    const held = await controller.acquire({ signal: new AbortController().signal })
    const modelRequest = Promise.resolve(
      app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "unknown-model", messages: [{ role: "user", content: "hello" }] }),
      }),
    )

    await expectPending(modelRequest)
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 1 })

    const liveness = await app.request("/health/liveness")
    expect(liveness.status).toBe(200)
    expect(await liveness.json()).toEqual({ status: "alive" })
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 1 })

    held.releaseBeforeBinding("release fixture capacity")
    const response = await modelRequest
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 1 })
    await controller.waitForQuiescence()
    expect(controller.snapshot()).toMatchObject({ reserved: 0, waiting: 0, unacked: 0 })
  })

  test("aborts a pre-context waiter when the client disconnects", async () => {
    const held = await controller.acquire({ signal: new AbortController().signal })
    const clientAbort = new AbortController()
    const request = new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "unknown-model", messages: [{ role: "user", content: "bye" }] }),
      signal: clientAbort.signal,
    })

    const response = Promise.resolve(app.request(request))
    await expectPending(response)
    expect(controller.snapshot().waiting).toBe(1)

    clientAbort.abort(new Error("client disconnected before admission"))
    const abortedResponse = await response
    expect(abortedResponse.status).toBeGreaterThanOrEqual(400)
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 0 })

    held.releaseBeforeBinding("release fixture capacity")
  })
})
