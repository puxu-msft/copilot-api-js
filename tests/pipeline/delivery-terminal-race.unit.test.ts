import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"
import type { ClientSink } from "~/lib/pipeline/types"

import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

function envelope(data: string, syntheticKind?: string): ClientFrameEnvelope {
  return Object.freeze({
    frame: { event: "event", data },
    sequence: 1,
    observedAtMonotonic: 1,
    provenance:
      syntheticKind ?
        Object.freeze({ kind: "synthetic" as const, syntheticKind })
      : Object.freeze({ kind: "candidate" as const, candidateId: "primary", dispatchId: "dispatch" }),
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe("P3-T2 downstream terminal fence", () => {
  test("waits for the in-flight write, emits one terminal, and rejects late queued frames", async () => {
    const writes: Array<string> = []
    const gate = deferred()
    let firstWrite = true
    let closeCalls = 0
    let finalizeCalls = 0
    const sink: ClientSink = {
      async write(frame) {
        writes.push(frame.data ?? "")
        if (firstWrite) {
          firstWrite = false
          await gate.promise
        }
      },
      async writeSynthetic(frame) {
        writes.push(frame.data ?? "")
      },
      close() {
        closeCalls++
      },
      finalize() {
        finalizeCalls++
      },
    }
    const delivery = createDownstreamDeliverySession({ sink })
    const active = delivery.clientSink.write({ data: "active" })
    await Promise.resolve()

    const terminal = JSON.stringify({ type: "error", error: { type: "api_error", message: "terminal" } })
    const terminating = delivery.terminate({ kind: "upstream-exhausted", frames: [envelope(terminal, "synthetic")] })
    const late = delivery.clientSink.write({ data: "late" })
    expect(delivery.snapshot.state).toBe("terminating")
    expect(writes).toEqual(["active"])

    gate.resolve()
    await Promise.all([active, terminating, late])

    expect(writes).toEqual(["active", terminal])
    expect(delivery.snapshot.state).toBe("closed")
    expect(delivery.snapshot.ledger.terminalWritten).toBe(true)
    expect(closeCalls).toBe(1)
    expect(finalizeCalls).toBe(1)

    await delivery.terminate({ kind: "upstream-nonretryable", frames: [envelope("second-terminal", "synthetic")] })
    expect(writes).toEqual(["active", terminal])
  })

  test("client-aborted stops heartbeat and closes without terminal bytes", async () => {
    const writes: Array<string> = []
    let closeCalls = 0
    const delivery = createDownstreamDeliverySession({
      sink: {
        async write(frame) {
          writes.push(frame.data ?? "")
        },
        close() {
          closeCalls++
        },
      },
    })

    await delivery.terminate({ kind: "client-aborted" })
    expect(writes).toEqual([])
    expect(delivery.snapshot.state).toBe("closed")
    expect(closeCalls).toBe(1)
    await delivery.clientSink.write({ data: "late" })
    expect(writes).toEqual([])
  })
})
