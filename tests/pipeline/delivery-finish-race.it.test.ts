import {
  //
  expect,
  test,
} from "bun:test"

import type { OwnerRawSink } from "~/lib/pipeline/delivery/types"
import type {
  //
  ClientFrame,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { StreamClientAbortError } from "~/lib/stream"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const start = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})

test("client-gone racing an in-flight terminate finalizes the raw sink exactly once", async () => {
  const writeEntered = deferred()
  const pendingWrite = deferred()
  let finalizeCount = 0
  const sink: OwnerRawSink = {
    async writeAnchor() {
      writeEntered.resolve()
      await pendingWrite.promise
    },
    async write() {},
    async finalize() {
      finalizeCount++
    },
    close() {},
  }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  const allocation = delivery.allocationPort.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))])
  await writeEntered.promise
  const termination = delivery.terminate({
    kind: "upstream-nonretryable",
    frames: [
      {
        frame: { event: "error", data: '{"type":"error"}' },
        sequence: 0,
        observedAtMonotonic: 0,
        provenance: { kind: "synthetic", syntheticKind: "synthetic" },
      },
    ],
  })
  pendingWrite.reject(new StreamClientAbortError())

  expect(await allocation).toEqual({ ok: false, reason: "client-gone", committed: true })
  await termination
  expect(finalizeCount).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
  expect(await delivery.allocationPort.beginLeg("recovery", { candidateId: "late", dispatchId: "late" })).toEqual({
    ok: false,
    reason: "session-terminating",
    committed: false,
  })
})
