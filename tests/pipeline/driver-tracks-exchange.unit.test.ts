import { describe, test, expect } from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"
import { createPipelineDriver } from "~/lib/pipeline/driver"

import { BASE, makeCodec, makeEnv, makeTransport, okStream } from "./hooks/driver-test-helpers"

// C4a: driver.runRequest tracks the exchange (transport + RC3 retry/backoff) as an operation-body
// child on the ctx, so the shutdown drain (operationScopes) waits for it to unwind after a
// mid-flight settle — the orphan the user observed (settled at deadline while a backoff kept running).

describe("C4a: driver tracks the exchange as an operation body", () => {
  test("a slow exchange is tracked; the ctx does not quiesce until it resolves", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })

    let releaseTransport!: () => void
    const transport = makeTransport(async () => {
      await new Promise<void>((r) => (releaseTransport = r)) // hold the exchange open
      return okStream()
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const runPromise = driver.runRequest({ body: {}, headers: new Headers() })
    // Let runRequest reach the transport await.
    await new Promise((r) => setTimeout(r, 5))

    // The exchange is in flight → tracked as an operation body.
    expect(manager.trackedOperationCount).toBe(1)

    // Simulate a mid-flight settle (reaper/deadline) BEFORE the exchange unwinds.
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })
    await Promise.resolve()
    // Settled out of the visible registry…
    expect(manager.activeCount).toBe(0)
    // …but the operation is STILL tracked — drain would wait for the in-flight exchange.
    expect(manager.trackedOperationCount).toBe(1)

    // Let the exchange finish → operation quiesces → leaves the registry.
    releaseTransport()
    await runPromise
    await new Promise((r) => setTimeout(r, 5))
    expect(manager.trackedOperationCount).toBe(0)
  })
})
