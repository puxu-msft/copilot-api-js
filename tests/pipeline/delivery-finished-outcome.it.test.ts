import {
  //
  expect,
  test,
} from "bun:test"

import type { ClientSink } from "~/lib/pipeline/types"

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
} from "./hooks/driver-test-helpers"

function emptyStream() {
  async function* frames() {}
  return { frames: frames(), headers: new Headers() }
}

async function runWithTerminatedDelivery() {
  const ctx = createRequestContext({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
  const env = makeEnv(ctx, { model: "claude-test", messages: [] })
  const { codec } = makeCodec({ env })
  const driver = createPipelineDriver({
    ...BASE,
    codec,
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    transport: makeTransport(async () => emptyStream()),
  })
  const request = await driver.runRequest({ body: env.body, headers: new Headers(), method: "POST", path: "/v1/messages" })
  if (!request.ok) throw new Error("unexpected routing rejection")
  const rawSink: ClientSink = { async write() {}, close() {} }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink: rawSink, wireState })
  await delivery.terminate({ kind: "complete" })
  return driver.runResponseSink(request.upstream, request.env, delivery.clientSink, { wireAllocationPort: delivery.allocationPort })
}

test("a prematurely terminated delivery is a loud stream error while the request context is pending", async () => {
  const outcome = await runWithTerminatedDelivery()
  expect(outcome.kind).toBe("stream-error")
  if (outcome.kind !== "stream-error") throw new Error("expected stream-error")
  expect(String(outcome.error)).toContain("before request context settled")
})
