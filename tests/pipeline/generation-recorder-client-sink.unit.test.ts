import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"

function stubSseStream() {
  const written: Array<Record<string, unknown>> = []
  return {
    written,
    stream: {
      async writeSSE(frame: Record<string, unknown>) {
        written.push(frame)
      },
    } as unknown as Parameters<typeof makeSseSink>[0],
  }
}

describe("generation recorder ClientSink frame arena integration", () => {
  test("shares unchanged upstream/client handles and positive mutation control creates derived rewrite/synthetic nodes", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [], stream: true } })
    ctx.beginAttempt({})

    const raw: ClientFrame = {
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "same" } }),
    }
    ctx.captureUpstreamGenerationFrame!(raw, { offsetMs: 1, type: "content_block_delta", raw: raw.data! })

    const forwarded: Array<unknown> = []
    const { stream } = stubSseStream()
    const sink = makeSseSink(stream, {
      onForwarded: (record) => forwarded.push(record),
      ...clientFirstRealSinkOpts({ clientFormat: "anthropic", ctx }),
    })
    await sink.write(raw)

    const rewritten: ClientFrame = { ...raw, data: raw.data!.replace("same", "changed") }
    ctx.captureGenerationFrameTransform!(raw, rewritten, { stage: "rewrite-out", transformId: "rewrite-out:positive-mutation", forceDerived: true })
    await sink.write(rewritten)
    await sink.writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { message: "synthetic" } }) })

    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "done", stop_reason: "end_turn" })
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    sink.finalize?.()
    await ctx.whenModelOperationFinalized()
    const record = ctx.modelOperationTerminalRecord!
    const upstreamHandles = record.attempts[0]?.upstreamResponse?.frames ?? []
    const clientHandles = record.egress?.client.frames ?? []

    expect(forwarded).toHaveLength(3)
    expect(upstreamHandles).toHaveLength(1)
    expect(clientHandles[0]).toBe(upstreamHandles[0])
    expect(clientHandles[1]).not.toBe(upstreamHandles[0])
    expect(record.arena.frames.find((node) => node.handle === clientHandles[1])).toMatchObject({
      provenance: "derived",
      derivedFrom: upstreamHandles[0],
      transformId: "rewrite-out:positive-mutation",
      origin: { stage: "rewrite-out", track: "client" },
    })
    const synthetic = record.arena.frames.find((node) => node.handle === clientHandles[2])
    expect(synthetic).toMatchObject({
      provenance: "derived",
      transformId: "client-sink:synthetic",
      origin: { stage: "client-sink", track: "proxy", detail: "synthetic" },
    })
    expect(record.attempts[0]?.upstreamResponse?.frameObservations).toEqual([
      { handle: upstreamHandles[0], offsetMs: 1, type: "content_block_delta", observedAt: expect.any(Number) },
    ])
    expect(record.egress?.client.frameObservations).toEqual([
      { handle: clientHandles[0], offsetMs: expect.any(Number), type: "content_block_delta", observedAt: expect.any(Number) },
      { handle: clientHandles[1], offsetMs: expect.any(Number), type: "content_block_delta", observedAt: expect.any(Number) },
      {
        handle: clientHandles[2],
        offsetMs: expect.any(Number),
        type: "error",
        synthetic: "synthetic",
        observedAt: expect.any(Number),
      },
    ])
    expect(record.arena.frames.find((node) => node.handle === upstreamHandles[0])?.value).toMatchObject({ data: raw.data })
    expect(record.arena.frames.find((node) => node.handle === clientHandles[1])?.value).toMatchObject({ data: rewritten.data })
    expect(synthetic?.value).toMatchObject({ data: expect.stringContaining("synthetic") })
    expect(synthetic!.sequence).toBeLessThan(record.terminal!.sequence)
  })
})
