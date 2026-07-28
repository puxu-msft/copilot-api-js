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
  const stream = {
    writeSSE: async () => {},
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  const sink = makeDeliverySseSink(stream, {
    wireState,
    heartbeat: {
      intervalSec: 15,
      pingFrame: { event: "ping", data: '{"type":"ping"}' },
      injectAnchor: async () => {
        injectorCalls++
        return true
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
