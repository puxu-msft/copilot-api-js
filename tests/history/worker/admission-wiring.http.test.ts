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
import { setStateForTests } from "~/lib/state"

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
    await initHistory(true)
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
    await expect(response).rejects.toThrow("client disconnected before admission")
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 0 })

    held.releaseBeforeBinding("release fixture capacity")
  })
})
