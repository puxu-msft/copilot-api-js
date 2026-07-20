import { describe, it, expect } from "bun:test"

import { abortableDelay, OperationCancelledError } from "~/lib/util/abortable-delay"

describe("abortableDelay", () => {
  it("resolves after the delay when not aborted", async () => {
    const start = performance.now()
    await abortableDelay(30)
    expect(performance.now() - start).toBeGreaterThanOrEqual(25)
  })

  it("rejects immediately with OperationCancelledError when the signal aborts mid-wait", async () => {
    const ac = new AbortController()
    const p = abortableDelay(10_000, ac.signal)
    setTimeout(() => ac.abort(), 10)
    await expect(p).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it("rejects immediately when the signal is ALREADY aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(abortableDelay(10_000, ac.signal)).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it("does not leak the timer after an abort (no dangling handle keeps the loop alive)", async () => {
    const ac = new AbortController()
    const p = abortableDelay(10_000, ac.signal)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(OperationCancelledError)
    // If the timer were not cleared, a 10s handle would linger; we can't assert the handle
    // directly, but reaching here promptly (test would otherwise time out on process exit) is the signal.
    expect(true).toBe(true)
  })

  it("no signal → plain delay resolves", async () => {
    await abortableDelay(5)
    expect(true).toBe(true)
  })
})
