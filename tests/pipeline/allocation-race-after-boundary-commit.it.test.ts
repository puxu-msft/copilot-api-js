import {
  //
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { FakeClock } from "../helpers/fake-clock"

const frame = (type: string, index?: number, blockType?: string): ClientFrame => ({
  event: type,
  data: JSON.stringify({
    type,
    ...(index === undefined ? {} : { index }),
    ...(blockType === undefined ? {} : { content_block: { type: blockType } }),
  }),
})

async function drain(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

test("after boundary resume, the pre-M6 gate emits ping without invoking the anchor injector", async () => {
  const clock = new FakeClock()
  clock.install()
  const written: Array<ClientFrame> = []
  const stream = {
    writeSSE: async (value: { data: string; event?: string }) => {
      written.push(value)
    },
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  let injectorCalls = 0
  const sink = makeDeliverySseSink(stream, {
    heartbeat: {
      intervalSec: 15,
      pingFrame: frame("ping"),
      injectAnchor: async () => {
        injectorCalls++
        return true
      },
    },
  })
  const delivery = getDownstreamDeliverySession(sink)!

  sink.suspendHeartbeat?.()
  sink.freezeHeartbeat?.()
  await sink.write(frame("message_start"))
  await sink.write(frame("content_block_start", 0, "text"))
  await sink.write(frame("content_block_stop", 0))
  sink.resumeHeartbeat?.()
  expect(delivery.snapshot.ledger.semanticBlockCount).toBe(1)
  const beforeTick = delivery.snapshot.writeCount

  await clock.advance(15_000)
  await drain()

  expect(delivery.snapshot.writeCount).toBe(beforeTick + 1)
  expect(JSON.parse(written.at(-1)!.data as string).type).toBe("ping")
  expect(injectorCalls).toBe(0)
  sink.close?.()
  clock.restore()
})
