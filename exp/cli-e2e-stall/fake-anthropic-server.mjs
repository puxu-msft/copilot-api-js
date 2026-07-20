// Minimal fake Anthropic server for CLI e2e PoC. Mode via env FAKE_MODE:
//   "marker"      → normal turn with a distinct text marker (mechanism check)
//   "thinking"    → thinking-only end_turn (what empty-string refusal recovery produces): the
//                   stall question — does claude's agent loop stall on a turn with a thinking
//                   block + NO text + stop_reason:end_turn?
//   "recovertext" → thinking + a recovery TEXT block + end_turn (non-empty refusal recovery)
// Non-4141 port only. Started/cleaned up by PID by the harness — never touches 4141.
const PORT = Number(process.env.PORT || 4199)
const MODE = process.env.FAKE_MODE || "marker"
const MODEL = "claude-sonnet-4.6"
const MARKER = "FAKESERVERMARKER_9x7q"
const RECOVERY_TEXT = "上游模型本轮以拒绝结束，未产出可用回复。请换一种表述后重试。"

function ev(event, obj) { return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n` }

function frames() {
  const start = ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })
  const stop = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }) + ev("message_stop", { type: "message_stop" })
  const thinking = [
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "considering the request" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-STALL" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ].join("")
  const textBlock = (idx, text) => ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text } }) + ev("content_block_stop", { type: "content_block_stop", index: idx })
  if (MODE === "thinking") return start + thinking + stop
  if (MODE === "recovertext") return start + thinking + textBlock(1, RECOVERY_TEXT) + stop
  return start + textBlock(0, MARKER) + stop // marker
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === "POST" ? await req.text().catch(() => "") : ""
    process.stderr.write(`[fake:${MODE}] ${req.method} ${url.pathname} stream=${body.includes('"stream":true')}\n`)
    if (url.pathname.endsWith("/v1/messages")) {
      const payload = body ? JSON.parse(body) : {}
      if (payload.stream) {
        const wire = frames()
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); c.close() } }), { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      const content = MODE === "thinking" ? [{ type: "thinking", thinking: "considering", signature: "SIG-STALL" }] : MODE === "recovertext" ? [{ type: "thinking", thinking: "considering", signature: "SIG-STALL" }, { type: "text", text: RECOVERY_TEXT }] : [{ type: "text", text: MARKER }]
      return Response.json({ id: "m", type: "message", role: "assistant", model: MODEL, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 8 } })
    }
    return new Response("ok", { status: 200 })
  },
})
process.stderr.write(`[fake:${MODE}] listening on ${server.port}\n`)
