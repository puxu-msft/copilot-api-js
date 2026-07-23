const port = Number.parseInt(process.env.Q1_PORT ?? "41921", 10)
const delayMs = Number.parseInt(process.env.Q1_PRE_HEADER_DELAY_MS ?? "0", 10)
const nonce = process.env.Q1_NONCE
if (!nonce) throw new Error("Q1_NONCE is required")
if (!Number.isFinite(port) || port === 4141 || !Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid Q1_PORT or Q1_PRE_HEADER_DELAY_MS")

const encoder = new TextEncoder()
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ status: "healthy", delayMs, nonce })
    if (url.pathname !== "/v1/messages" || request.method !== "POST") return new Response("not found", { status: 404 })
    await Bun.sleep(delayMs)
    const frames = [
      ["message_start", { type: "message_start", message: { id: "msg_q1", type: "message", role: "assistant", model: "claude-sonnet-4.6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Q1_PRE_HEADER_OK after ${delayMs}ms` } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const
    const stream = new ReadableStream({
      start(controller) {
        for (const [event, data] of frames) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
console.log(JSON.stringify({ port: server.port, delayMs, pid: process.pid }))
