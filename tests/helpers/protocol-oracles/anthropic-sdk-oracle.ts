import type { ServerSentEventMessage } from "fetch-event-stream"

import { expect } from "bun:test"

/** The Anthropic stream event names the @anthropic-ai/sdk SSEDecoder dispatches on. */
const SDK_STREAM_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
  "error",
])

/** N1 invariant: EVERY synthesized frame carries an `event:` line equal to its JSON `type`, SDK-recognized. */
export function assertAnthropicEventLineInvariant(frames: Array<ServerSentEventMessage>): void {
  for (const f of frames) {
    const type = (JSON.parse(f.data ?? "{}") as { type?: string }).type
    expect(f.event, `frame type=${type} must carry an event: line`).toBe(type)
    expect(SDK_STREAM_EVENTS.has(f.event ?? ""), `event ${f.event} must be SDK-recognized`).toBe(true)
  }
}

/** Serialize the translator's frames into the SSE wire bytes an Anthropic client would receive. */
export function anthropicFramesToWire(frames: Array<ServerSentEventMessage>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("")
}

/**
 * INDEPENDENT ORACLE: decode synthesized wire through the REAL Anthropic SDK `Stream.fromSSEResponse`
 * and reconstruct a Message only from events that survived the SDK decoder.
 */
export async function accumulateAnthropic(frames: Array<ServerSentEventMessage>): Promise<import("@anthropic-ai/sdk/resources/messages").Message> {
  const { Stream } = await import("@anthropic-ai/sdk/core/streaming")
  const response = new Response(anthropicFramesToWire(frames), { status: 200, headers: { "content-type": "text/event-stream" } })
  type RawEvent = import("@anthropic-ai/sdk/resources/messages").RawMessageStreamEvent
  const stream = Stream.fromSSEResponse<RawEvent>(response, new AbortController())

  let message: import("@anthropic-ai/sdk/resources/messages").Message | undefined
  const blocks: Array<Record<string, unknown>> = []
  for await (const ev of stream) {
    switch (ev.type) {
      case "message_start": {
        message = ev.message
        break
      }
      case "content_block_start": {
        blocks[ev.index] = { ...(ev.content_block as unknown as Record<string, unknown>) }
        if (blocks[ev.index].type === "tool_use") blocks[ev.index]._json = ""
        break
      }
      case "content_block_delta": {
        const d = ev.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
        const b = blocks[ev.index]
        if (d.type === "text_delta") b.text = ((b.text as string | undefined) ?? "") + (d.text ?? "")
        if (d.type === "input_json_delta") b._json = ((b._json as string | undefined) ?? "") + (d.partial_json ?? "")
        if (d.type === "thinking_delta") b.thinking = ((b.thinking as string | undefined) ?? "") + (d.thinking ?? "")
        if (d.type === "signature_delta") b.signature = ((b.signature as string | undefined) ?? "") + (d.signature ?? "")
        break
      }
      case "message_delta": {
        if (message) {
          message.stop_reason = ev.delta.stop_reason ?? message.stop_reason
          if (ev.usage) message.usage = { ...message.usage, ...ev.usage } as typeof message.usage
        }
        break
      }
      default: {
        break
      }
    }
  }
  if (!message) throw new Error("SDK oracle: no message_start survived the decoder (N1 event-line drop)")
  message.content = blocks.filter(Boolean).map((b) => {
    if (b.type === "tool_use")
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b._json ? JSON.parse(b._json as string) : {},
      } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
    if (b.type === "thinking")
      return {
        type: "thinking",
        thinking: b.thinking ?? "",
        signature: b.signature ?? "",
      } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
    return { type: "text", text: b.text ?? "", citations: null } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
  })
  return message
}
