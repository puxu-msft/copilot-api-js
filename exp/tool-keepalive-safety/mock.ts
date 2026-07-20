// tool-keepalive safety oracle: does injecting the proxy's keepalive EMPTY delta into a real
// tool_use / thinking block corrupt what the CLIENT accumulates? We answer with the REAL
// @anthropic-ai/sdk (the SAME accumulation logic Claude Code uses — message-stream-utils),
// NOT by reasoning about partial_json concatenation.
//
// The mock plays, per x-mock-mode, a tool_use / thinking stream with the proxy's keepalive frame
// (input_json_delta{partial_json:""} / thinking_delta{thinking:""}) injected at various positions.
// probe.ts consumes with the SDK and asserts the FINAL accumulated input / thinking / signature.

const PORT = Number(process.env.MOCK_PORT ?? 8801)
const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

const msgStart = () =>
  sse("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  })
const toolStart = (index: number, name: string) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } })
const inputDelta = (index: number, pj: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: pj } })
const thinkStart = (index: number) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
const thinkDelta = (index: number, t: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } })
const sigDelta = (index: number, s: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: s } })
const textStart = (index: number) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
const textDelta = (index: number, t: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } })
const blockStop = (index: number) => sse("content_block_stop", { type: "content_block_stop", index })
const msgDelta = (reason: string) => sse("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } })
const msgStop = () => sse("message_stop", { type: "message_stop" })

// The EXACT keepalive frames the proxy injects (makeAnthropicKeepaliveFrame).
const EMPTY_TOOL = (index: number) => inputDelta(index, "") // tool_use keepalive
const EMPTY_THINK = (index: number) => thinkDelta(index, "") // thinking keepalive
const EMPTY_TEXT = (index: number) => textDelta(index, "") // text keepalive

function framesFor(mode: string): Array<Uint8Array> {
  switch (mode) {
    case "normal-tool":
      return [msgStart(), toolStart(0, "Bash"), inputDelta(0, '{"command":"ls -la"}'), blockStop(0), msgDelta("tool_use"), msgStop()]
    case "keepalive-mid-tool": // keepalive BETWEEN two real partial_json fragments
      return [msgStart(), toolStart(0, "Bash"), inputDelta(0, '{"command":"l'), EMPTY_TOOL(0), inputDelta(0, 's -la"}'), blockStop(0), msgDelta("tool_use"), msgStop()]
    case "keepalive-pre-tool": // keepalive BEFORE the first real fragment
      return [msgStart(), toolStart(0, "Bash"), EMPTY_TOOL(0), inputDelta(0, '{"command":"ls -la"}'), blockStop(0), msgDelta("tool_use"), msgStop()]
    case "keepalive-multi-tool": // several keepalives in a row (long stall)
      return [msgStart(), toolStart(0, "Bash"), EMPTY_TOOL(0), EMPTY_TOOL(0), EMPTY_TOOL(0), inputDelta(0, '{"command":"ls -la"}'), blockStop(0), msgDelta("tool_use"), msgStop()]
    case "keepalive-zero-arg": // zero-arg tool — upstream sends no real delta, keepalive is the ONLY delta
      return [msgStart(), toolStart(0, "EnterPlanMode"), EMPTY_TOOL(0), EMPTY_TOOL(0), blockStop(0), msgDelta("tool_use"), msgStop()]
    case "keepalive-thinking": // thinking block with empty thinking_delta keepalive before signature
      return [msgStart(), thinkStart(0), thinkDelta(0, "Let me reason about this"), EMPTY_THINK(0), sigDelta(0, "c2lnMTIz"), blockStop(0), textStart(1), textDelta(1, "answer"), blockStop(1), msgDelta("end_turn"), msgStop()]
    case "keepalive-text": // text block with empty text_delta keepalive between fragments
      return [msgStart(), textStart(0), textDelta(0, "Hello "), EMPTY_TEXT(0), textDelta(0, "world"), blockStop(0), msgDelta("end_turn"), msgStop()]
    default:
      return [msgStart(), textStart(0), textDelta(0, "ok"), blockStop(0), msgDelta("end_turn"), msgStop()]
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/count_tokens")) return new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } })
    if (!url.pathname.endsWith("/messages")) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
    const mode = req.headers.get("x-mock-mode") ?? "default"
    const body = new ReadableStream({
      start(controller) {
        for (const f of framesFor(mode)) controller.enqueue(f)
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  },
})
console.error(`[mock] tool-keepalive oracle on :${PORT}`)
