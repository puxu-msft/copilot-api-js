// Independent oracle: feed proxy-forwarded SSE bytes through the REAL @anthropic-ai/sdk
// stream decoder and report which content blocks survive. Confirms event-less synthetic
// frames are dropped, and that adding event: lines fixes it.
import { _iterSSEMessages } from "@anthropic-ai/sdk/core/streaming"

// The SDK's accept-set (streaming.js:55-97) — only these sse.event values are yielded.
const ACCEPT = new Set(["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop", "message"])

function sseResponse(body: string): Response {
  return new Response(new TextEncoder().encode(body), { status: 200, headers: { "content-type": "text/event-stream" } })
}

async function survivingTypes(body: string): Promise<Array<string>> {
  const out: Array<string> = []
  const controller = new AbortController()
  for await (const sse of _iterSSEMessages(sseResponse(body), controller) as AsyncIterable<{ event: string | null; data: string }>) {
    if (sse.event !== null && ACCEPT.has(sse.event)) {
      const obj = JSON.parse(sse.data) as { type?: string }
      out.push(`${sse.event}|${obj.type}`)
    } else {
      out.push(`DROPPED(event=${JSON.stringify(sse.event)})|${(JSON.parse(sse.data) as { type?: string }).type}`)
    }
  }
  return out
}

const ev = (e: string, o: unknown) => `event: ${e}\ndata: ${JSON.stringify(o)}\n\n`
const dat = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

// CURRENT (buggy): synthetic text frames are data-only (no event line)
const CURRENT = [
  ev("message_start", { type: "message_start" }),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  dat({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  dat({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "RECOVERY TEXT" } }),
  dat({ type: "content_block_stop", index: 1 }),
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
  ev("message_stop", { type: "message_stop" }),
].join("")

// FIXED: synthetic text frames carry event: lines matching their type
const FIXED = CURRENT
  .replace(dat({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }), ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }))
  .replace(dat({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "RECOVERY TEXT" } }), ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "RECOVERY TEXT" } }))
  .replace(dat({ type: "content_block_stop", index: 1 }), ev("content_block_stop", { type: "content_block_stop", index: 1 }))

console.log("CURRENT (event-less synth):", await survivingTypes(CURRENT))
console.log("FIXED   (event-lined synth):", await survivingTypes(FIXED))
