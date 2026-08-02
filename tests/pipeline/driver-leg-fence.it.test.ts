import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  RunBufferedOpts,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createRequestContext } from "~/lib/context/request"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import {
  //
  BASE,
  makeCodec,
  makeEnv,
  makeTransport,
  okStream,
} from "./hooks/driver-test-helpers"

const frame = (type: string): UpstreamFrame => ({ event: type, data: JSON.stringify({ type }) })

function stopTracker() {
  let stopped = false
  return {
    onUpstreamFrame(value: UpstreamFrame) {
      if (JSON.parse(value.data ?? "{}").type === "message_stop") stopped = true
    },
    onAttemptReset() {
      stopped = false
    },
    sawMessageStop: () => stopped,
  }
}

test("production buffered recovery opens a recovery leg through the driver", async () => {
  const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
  const env = makeEnv(ctx, { model: "claude-test", messages: [] })
  const { codec } = makeCodec({ env, renderResponse: (value) => value })
  const first = okStream([frame("message_start")]) // clean EOF without message_stop => recovery
  const recovered = okStream([frame("message_start"), frame("message_stop")])
  let sends = 0
  const driver = createPipelineDriver({
    ...BASE,
    codec,
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    transport: makeTransport(async () => (sends++ === 0 ? first : recovered)),
  })
  const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/messages" })
  if (!request.ok) throw new Error("unexpected routing rejection")

  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const writes: Array<ClientFrame> = []
  const delivery = createDownstreamDeliverySession({
    wireState,
    sink: {
      async write(value) {
        writes.push(value)
      },
      close() {},
    },
  })
  const tracker = stopTracker()
  const outcome = await driver.runResponseBufferedSink(request.upstream, request.env, delivery.clientSink, {
    ...tracker,
    retryCap: 1,
    wireAllocationPort: delivery.allocationPort,
  } as RunBufferedOpts)

  expect(outcome.kind).toBe("complete")
  expect(writes.map((value) => JSON.parse(value.data ?? "{}").type)).toEqual(["message_start", "message_stop"])
  expect(wireState.activeLeg?.kind).toBe("recovery")
  const snapshot = request.env.ctx.modelOperationSnapshot
  expect(wireState.activeLeg?.source).toEqual({
    candidateId: String(snapshot.candidates.at(-1)?.handle),
    dispatchId: String(snapshot.dispatches.at(-1)?.handle),
  })
})
