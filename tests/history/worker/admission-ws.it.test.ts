import type {
  //
  UpgradeWebSocket,
  WSEvents,
} from "hono/ws"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"
import { WSContext } from "hono/ws"

import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { HistoryAdmissionControllerImpl } from "~/lib/history/worker/admission"
import { setHistoryAdmissionControllerForTests } from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"
import { initResponsesWebSocket } from "~/routes/responses/ws"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

function captureWsEvents(): WSEvents {
  let factory: ((context: never) => WSEvents | Promise<WSEvents>) | undefined
  const upgradeWs = ((createEvents: (context: never) => WSEvents | Promise<WSEvents>) => {
    factory = createEvents
    return async (_context: unknown, next: () => Promise<void>) => await next()
  }) as unknown as UpgradeWebSocket
  initResponsesWebSocket(new Hono(), upgradeWs)
  if (!factory) throw new Error("Responses WebSocket route did not register an event factory")
  const result = factory({} as never)
  if (result instanceof Promise) throw new Error("Responses WebSocket event factory unexpectedly became async")
  return result
}

describe("Responses WebSocket History admission", () => {
  useIsolatedRuntime()

  let controller: HistoryAdmissionControllerImpl

  beforeEach(async () => {
    setStateForTests({ historyDbPath: ":memory:", clientWebsocketKeepOpen: true })
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

  test("acquires per response.create and aborts a pre-context waiter on socket close", async () => {
    const held = await controller.acquire({ signal: new AbortController().signal })
    const events = captureWsEvents()
    const sent: Array<string> = []
    const ws = new WSContext({
      raw: {},
      readyState: 1,
      send: (value) => sent.push(typeof value === "string" ? value : "<binary>"),
      close: () => {},
    })
    events.onOpen?.(new Event("open"), ws)

    const work = Promise.resolve(
      events.onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "response.create", response: { model: "unknown-model", input: "hello" } }),
        }),
        ws,
      ),
    )
    await Promise.resolve()
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 1 })

    events.onClose?.(new CloseEvent("close"), ws)
    await work
    expect(controller.snapshot()).toMatchObject({ reserved: 1, waiting: 0 })
    expect(sent.some((frame) => frame.includes("error"))).toBe(true)

    held.releaseBeforeBinding("release fixture capacity")
  })
})
