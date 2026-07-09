/**
 * Active-path integration: the EXACT sink + keepalive-provider pair the Anthropic streaming handler
 * wires up (handler-v4.ts:453/526 pass `resolveAnthropicKeepalive(state.streamKeepaliveMode)` as the
 * makeSseSink heartbeat `pingFrame`). This drives that real pair with real mid-stream Anthropic frame
 * sequences + a fake clock and asserts what the heartbeat injects during a stall — proving the wired
 * components (not a test double) produce a block-matched empty content delta, and that `ping` mode
 * + fallback still work. Complements the SDK oracle (client-side safety) in exp/tool-keepalive-safety.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { resolveAnthropicKeepalive } from "~/lib/anthropic/keepalive-frame"
import { makeSseSink } from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"

function stubStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

// Real upstream frame builders (bypass-direct: the client frame carries the full Anthropic JSON).
const messageStart = (): ClientFrame => ({
  event: "message_start",
  data: JSON.stringify({
    type: "message_start",
    message: {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }),
})
const blockStart = (index: number, cbType: string): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({
    type: "content_block_start",
    index,
    content_block:
      cbType === "tool_use" ?
        { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }
      : { type: cbType, ...(cbType === "thinking" ? { thinking: "", signature: "" } : { text: "" }) },
  }),
})
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })
const lastData = (written: Array<{ data: string }>) => JSON.parse(written.at(-1)?.data ?? "null") as unknown

describe("keepalive active-path (real makeSseSink + real resolveAnthropicKeepalive)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  // Exactly what handler-v4.ts:453/526 passes as the sink heartbeat pingFrame.
  const emptyText = resolveAnthropicKeepalive("empty_text")
  const pingMode = resolveAnthropicKeepalive("ping")

  test("mid-stream THINKING stall → injects an empty thinking_delta (NOT a ping)", async () => {
    const { stream, written } = stubStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 2, pingFrame: emptyText } })
    await sink.write(messageStart())
    await sink.write(blockStart(0, "thinking")) // thinking block opens → openBlock={0,thinking}
    await clock.advance(2_500) // cadence elapsed with no real frame → heartbeat tick
    expect(lastData(written)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } })
    sink.close?.()
  })

  test("mid-stream TOOL_USE stall → injects an empty input_json_delta (NOT a ping) — the tool scenario", async () => {
    const { stream, written } = stubStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 2, pingFrame: emptyText } })
    await sink.write(messageStart())
    await sink.write(blockStart(0, "tool_use")) // tool_use block opens
    await clock.advance(2_500)
    expect(lastData(written)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } })
    sink.close?.()
  })

  test("mid-stream TEXT stall → injects an empty text_delta", async () => {
    const { stream, written } = stubStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 2, pingFrame: emptyText } })
    await sink.write(messageStart())
    await sink.write(blockStart(0, "text"))
    await clock.advance(2_500)
    expect(lastData(written)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
    sink.close?.()
  })

  test("after content_block_stop (block closed) → openBlock cleared → fallback ping", async () => {
    const { stream, written } = stubStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 2, pingFrame: emptyText } })
    await sink.write(messageStart())
    await sink.write(blockStart(0, "thinking"))
    await sink.write(blockStop(0)) // block closed → no open block
    await clock.advance(2_500)
    expect(lastData(written)).toEqual({ type: "ping" }) // no open block → fallback ping (block-less gap)
    sink.close?.()
  })

  test("stream_keepalive_mode=ping → same thinking stall injects a ping (old behavior selectable)", async () => {
    const { stream, written } = stubStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 2, pingFrame: pingMode } })
    await sink.write(messageStart())
    await sink.write(blockStart(0, "thinking"))
    await clock.advance(2_500)
    expect(lastData(written)).toEqual({ type: "ping" })
    sink.close?.()
  })
})
