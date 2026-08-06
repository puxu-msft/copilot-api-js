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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
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

async function runWithTornDelivery() {
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
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({
    wireState,
    sink: {
      async write() {},
      async writeAnchor() {
        throw new TypeError("tear for error identity")
      },
      close() {},
    },
  })
  await delivery.allocationPort
    .allocateAndWriteAnchor(({ wireIndex, envelope }) => [
      envelope.anchor({
        event: "content_block_start",
        data: JSON.stringify({ type: "content_block_start", index: wireIndex, content_block: { type: "text", text: "" } }),
      }),
    ])
    .catch(() => {})
  return driver.runResponseSink(request.upstream, request.env, delivery.clientSink, { wireAllocationPort: delivery.allocationPort })
}

test("each torn-wire outcome gets a fresh diagnostic Error instance", async () => {
  const first = await runWithTornDelivery()
  const second = await runWithTornDelivery()
  if (first.kind !== "stream-error" || second.kind !== "stream-error") throw new Error("expected stream-error outcomes")
  expect(first.error).toBeInstanceOf(Error)
  expect(second.error).toBeInstanceOf(Error)
  expect(first.error).not.toBe(second.error)
  expect((first.error as Error).stack).toContain("wire-torn")
  expect((second.error as Error).stack).toContain("wire-torn")
})

test("an in-flight pump returns delivery-finished only after another path settles the context", async () => {
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

  const entered = deferred()
  const release = deferred()
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({
    wireState,
    sink: {
      async writeAnchor() {
        entered.resolve()
        await release.promise
      },
      async write() {},
      close() {},
    },
  })
  const parked = delivery.allocationPort.allocateAndWriteAnchor(({ wireIndex, envelope }) => [
    envelope.anchor({
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: wireIndex, content_block: { type: "text", text: "" } }),
    }),
  ])
  await entered.promise
  const pump = driver.runResponseSink(request.upstream, request.env, delivery.clientSink, { wireAllocationPort: delivery.allocationPort })
  ctx.complete({ success: true, model: "claude-test", usage: { input_tokens: 0, output_tokens: 0 }, content: "" })
  const termination = delivery.terminate({ kind: "complete" })
  release.resolve()

  await parked
  expect((await pump).kind).toBe("delivery-finished")
  await termination
})

test("a prematurely terminated delivery is a loud stream error while the request context is pending", async () => {
  const outcome = await runWithTerminatedDelivery()
  expect(outcome.kind).toBe("stream-error")
  if (outcome.kind !== "stream-error") throw new Error("expected stream-error")
  expect(String(outcome.error)).toContain("before request context settled")
})
