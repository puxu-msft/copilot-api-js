import { describe, it, expect } from "bun:test"

import { createOperationScope } from "~/lib/context/operation-scope"

// Structural-concurrency primitive for tracking a request's settle-BEFORE operation body
// (fetch/stream/retry-loop/backoff/token-refresh-wait/hooks/heartbeat). Reviews (RFC round 3/4)
// pinned two failure modes this must prevent:
//  - premature quiesce: childCount transiently hits 0 (exchange done) BEFORE a later child
//    (response pump / buffered retry) registers → whenOperationQuiesced must NOT resolve until sealed.
//  - root self-join: the root owner must NOT count itself, else `await whenOperationQuiesced()`
//    from the root deadlocks (waiting on a count that includes itself).

describe("operation-scope", () => {
  it("resolves whenOperationQuiesced only after seal() AND all children settle", async () => {
    const scope = createOperationScope()
    let resolved = false
    const gate = scope.whenOperationQuiesced().then(() => {
      resolved = true
    })

    let releaseA!: () => void
    scope.trackOperationBody(new Promise<void>((r) => (releaseA = r)))
    expect(scope.childCount).toBe(1)

    // Not sealed yet → must not resolve even if the child settles.
    releaseA()
    await Promise.resolve()
    expect(resolved).toBe(false)

    scope.seal()
    await gate
    expect(resolved).toBe(true)
    expect(scope.sealed).toBe(true)
  })

  it("does NOT prematurely resolve when childCount transiently hits 0 before seal (buffered-retry re-registration)", async () => {
    const scope = createOperationScope()
    let resolved = false
    void scope.whenOperationQuiesced().then(() => {
      resolved = true
    })

    // First child (exchange) settles, dropping childCount to 0 while still unsealed…
    let releaseExchange!: () => void
    scope.trackOperationBody(new Promise<void>((r) => (releaseExchange = r)))
    releaseExchange()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false) // unsealed → not quiesced despite childCount===0

    // …then a later child (response pump / buffered retry) registers.
    let releasePump!: () => void
    scope.trackOperationBody(new Promise<void>((r) => (releasePump = r)))
    scope.seal() // root finally seals after starting the pump
    await Promise.resolve()
    expect(resolved).toBe(false) // sealed but pump still in flight
    releasePump()
    await scope.whenOperationQuiesced()
    expect(resolved).toBe(true)
  })

  it("root owner does not self-join: whenOperationQuiesced does not count the awaiter", async () => {
    const scope = createOperationScope()
    // The root awaits quiescence in its own finally. If the root were counted as a child,
    // this would deadlock. With a sealed empty scope it must resolve immediately.
    scope.seal()
    await scope.whenOperationQuiesced() // must not hang
    expect(scope.childCount).toBe(0)
  })

  it("tolerates a rejected child (settle-before work that throws) without hanging quiesce", async () => {
    const scope = createOperationScope()
    scope.trackOperationBody(Promise.reject(new Error("boom")))
    scope.seal()
    // A rejected child still counts as settled for quiescence (we don't want a throw to wedge drain).
    await scope.whenOperationQuiesced()
    expect(scope.childCount).toBe(0)
  })
})
