import {
  //
  expect,
  test,
} from "bun:test"

import type { ClientFrame, ClientSink } from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

const anchorStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const anchorDelta = (index: number): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: "" } }),
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(sink: ClientSink = { write: async () => {}, close() {} }) {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  return { wireState, delivery, port: delivery.allocationPort }
}

test("build callback throwing before any wire write rolls back all allocation state", async () => {
  const { wireState, port } = setup()
  await expect(
    port.allocateAndWriteAnchor(() => {
      throw new Error("build failed")
    }),
  ).rejects.toThrow("build failed")

  expect(wireState.allocator.nextAnchorIndex()).toBe(0)
  expect(wireState.allocator.anchorsOpened()).toBe(0)
  expect(wireState.openAnchorIndex).toBeUndefined()
})

test("a closed session refuses an operation without allocating", async () => {
  const { wireState, delivery, port } = setup()
  await delivery.terminate({ kind: "client-aborted" })

  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])).toBeUndefined()
  expect(wireState.allocator.nextAnchorIndex()).toBe(0)
  expect(wireState.allocator.anchorsOpened()).toBe(0)
})

test("a failed first frame permanently consumes its index and terminates delivery", async () => {
  const attempts: Array<ClientFrame> = []
  const sink: ClientSink = {
    async write(frame) {
      attempts.push(frame)
      throw new Error("first write failed")
    },
    async writeAnchor(frame) {
      attempts.push(frame)
      throw new Error("first write failed")
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)

  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])).toBeUndefined()
  expect(attempts).toHaveLength(1)
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  expect(wireState.allocator.anchorsOpened()).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])).toBeUndefined()
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
})

test("a visible first frame is never rolled back when the second frame fails", async () => {
  const attempts: Array<ClientFrame> = []
  let count = 0
  const sink: ClientSink = {
    async write(frame) {
      attempts.push(frame)
      if (++count === 2) throw new Error("second write failed")
    },
    async writeAnchor(frame) {
      attempts.push(frame)
      if (++count === 2) throw new Error("second write failed")
    },
    async writeKeepalive(frame) {
      attempts.push(frame)
      if (++count === 2) throw new Error("second write failed")
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)

  expect(
    await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [
      envelope.anchor(anchorStart(wireIndex)),
      envelope.keepalive(anchorDelta(wireIndex)),
    ]),
  ).toBeUndefined()

  expect(attempts.map((frame) => JSON.parse(frame.data as string).type)).toEqual(["content_block_start", "content_block_delta"])
  expect(JSON.parse(attempts[0].data as string).index).toBe(0)
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
})

test("a queued operation reserves nothing and rechecks state when execution begins", async () => {
  const entered = deferred()
  const parked = deferred()
  const sink: ClientSink = {
    async write() {},
    async writeAnchor() {
      entered.resolve()
      await parked.promise
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)

  const running = port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])
  await entered.promise
  const queued = port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  const termination = delivery.terminate({ kind: "client-aborted" })
  parked.resolve()

  expect(await running).toBe(0)
  expect(await queued).toBeUndefined()
  await termination
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
})

test("an abort while the first write promise is pending is post-commit", async () => {
  const abort = new AbortController()
  const entered = deferred()
  const pending = deferred()
  abort.signal.addEventListener("abort", () => pending.reject(new Error("client aborted while write pending")), { once: true })
  const sink: ClientSink = {
    async write() {},
    async writeAnchor() {
      entered.resolve()
      await pending.promise
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)

  const operation = port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])
  await entered.promise
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  abort.abort()

  expect(await operation).toBeUndefined()
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
})
