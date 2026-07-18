import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"

function complete(ctx: ReturnType<typeof createRequestContext>): void {
  ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "ok" })
}

describe("generation delivery and observability terminal", () => {
  test("delivery first waits for the later logical terminal before finalizing", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const clientPayload = { role: "assistant", content: "ok" }

    ctx.finalizeModelOperationDelivery({ clientPayload })
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    complete(ctx)
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    const record = await ctx.whenModelOperationFinalized()

    expect(ctx.modelOperationTerminalRecord).toBe(record)
    expect(record.arena.payloads.find((node) => node.handle === record.egress?.client.payload)?.value).toEqual(clientPayload)
  })

  test("logical terminal first leaves client delivery complete while canonical waits for operation quiescence", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((resolve) => (release = resolve)))

    complete(ctx)
    ctx.finalizeModelOperationDelivery({ clientPayload: { role: "assistant", content: "ok" } })

    let finalized = false
    void ctx.whenModelOperationFinalized().then(() => {
      finalized = true
    })
    await Promise.resolve()
    expect(finalized).toBe(false)
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    expect(ctx.modelOperationSnapshot.egress).toBeNull()

    release()
    const record = await ctx.whenModelOperationFinalized()
    expect(record.terminal?.outcome).toBe("completed")
    expect(finalized).toBe(true)
  })

  test("publishes canonical only after quiescence and ignores every late capture after immutable seal", async () => {
    resetModelOperationTerminalBusForTests()
    const published: Array<ModelOperationRecord> = []
    const unsubscribe = subscribeModelOperationTerminals((record) => {
      published.push(record)
    })
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.beginAttempt({})
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((resolve) => (release = resolve)))

    complete(ctx)
    ctx.finalizeModelOperationDelivery()
    const lateFrame = { event: "message", data: "late-before-quiesce" }
    ctx.captureForwardedGenerationFrame?.(lateFrame, { offsetMs: 1, type: "message", raw: lateFrame.data })
    expect(published).toHaveLength(0)
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    release()
    const record = await ctx.whenModelOperationFinalized()
    expect(published).toEqual([record])
    expect(record.egress?.client.frames).toHaveLength(1)

    const sequence = record.lastSequence
    ctx.captureForwardedGenerationFrame?.({ event: "message", data: "forbidden-after-seal" }, { offsetMs: 2, type: "message", raw: "forbidden-after-seal" })
    expect(ctx.modelOperationSnapshot.lastSequence).toBe(sequence)
    unsubscribe()
    resetModelOperationTerminalBusForTests()
  })

  test("exposes a finalizer rejection instead of reporting a successful canonical terminal", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.beginGenerationCandidate({ role: "recovery" })

    complete(ctx)
    ctx.finalizeModelOperationDelivery()

    await expect(ctx.whenModelOperationFinalized()).rejects.toThrow(/open candidate/i)
    expect(ctx.modelOperationTerminalRecord).toBeNull()
  })
})
