import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { FakeClock } from "../helpers/fake-clock"

async function drain(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

test("a suspended heartbeat allocates no further anchors", async () => {
  const clock = new FakeClock()
  clock.install()
  const allocator = createGenerationWireIndexAllocator()
  const wireState = createGenerationWireState(allocator)
  let injectorCalls = 0
  let sink: ReturnType<typeof makeDeliverySseSink>
  const stream = {
    writeSSE: async () => {},
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  sink = makeDeliverySseSink(stream, {
    wireState,
    heartbeat: {
      intervalSec: 15,
      pingFrame: { event: "ping", data: '{"type":"ping"}' },
      injectAnchor: async () => {
        injectorCalls++
        const port = getDownstreamDeliverySession(sink)?.allocationPort
        if (!port) throw new Error("delivery owner unavailable")
        const result = await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [
          envelope.anchor({
            event: "content_block_start",
            data: JSON.stringify({ type: "content_block_start", index: wireIndex, content_block: { type: "text", text: "" } }),
          }),
        ])
        return result.ok
      },
    },
  })

  sink.suspendHeartbeat?.()
  await clock.advance(60_000)
  await drain()

  expect(injectorCalls).toBe(0)
  expect(allocator.anchorsOpened()).toBe(0)
  expect(allocator.nextAnchorIndex()).toBe(0)
  sink.close?.()
  clock.restore()
})
