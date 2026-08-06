import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createRequestContext } from "~/lib/context/request"
import {
  //
  createDownstreamDeliverySession,
  getDownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import {
  //
  BASE,
  makeCodec,
  makeEnv,
  makeTransport,
} from "./hooks/driver-test-helpers"

function streamOf(frames: ReadonlyArray<ClientFrame>) {
  async function* generate() {
    yield* frames
  }
  return { frames: generate(), headers: new Headers() }
}

test("the production live driver begins primary leg through the explicitly passed raw-sink owner", async () => {
  const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
  const env = makeEnv(ctx, { model: "claude-test", messages: [] })
  const frames: Array<ClientFrame> = [{ event: "message_stop", data: '{"type":"message_stop"}' }]
  const { codec } = makeCodec({ env, renderResponse: (frame) => frame })
  const driver = createPipelineDriver({
    ...BASE,
    codec,
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    transport: makeTransport(async () => streamOf(frames)),
  })
  const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/messages" })
  if (!request.ok) throw new Error("unexpected routing rejection")

  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const rawWrites: Array<ClientFrame> = []
  const rawSink: ClientSink = {
    async write(frame) {
      rawWrites.push(frame)
    },
    close() {},
  }
  const delivery = createDownstreamDeliverySession({ sink: rawSink, wireState })
  const wrappedSink: ClientSink = { ...delivery.clientSink }
  expect(getDownstreamDeliverySession(wrappedSink)).toBeUndefined()

  const outcome = await driver.runResponseSink(request.upstream, request.env, wrappedSink, { wireAllocationPort: delivery.allocationPort })

  expect(outcome.kind).toBe("complete")
  expect(rawWrites).toEqual(frames)
  expect(wireState.activeLeg?.kind).toBe("primary")
  expect(wireState.activeLeg?.source).toEqual({
    candidateId: String(request.env.ctx.modelOperationSnapshot.candidates[0].handle),
    dispatchId: String(request.env.ctx.modelOperationSnapshot.dispatches[0].handle),
  })
})
