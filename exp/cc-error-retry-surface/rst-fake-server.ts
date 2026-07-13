// raw-TCP fake server：发真实 HTTP/1.1 chunked SSE 响应若干帧后，用 socket.terminate() 发**真 TCP RST**
// （区别于 controller.error() 的 FIN/干净 EOF）。测 CC 在不同块完成状态下是否把真 RST 当可重试连接错误重发。
// RSTVARIANT 选前缀；PORT 选端口。oracle：连接次数（>1 = CC 重发）。
const RSTVARIANT = process.env.RSTVARIANT ?? "reset-nothing"
const PORT = Number(process.env.PORT ?? "4199")
const RST_MODE = process.env.RST_MODE ?? "terminate" // terminate=RST, end=FIN

let connCount = 0

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
const MSG_ID = "msg_fake_rst"
function messageStart(): string {
  return sse("message_start", { type: "message_start", message: { id: MSG_ID, type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
}
function textBlock(text: string, index = 0): string {
  return sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) + sse("content_block_stop", { type: "content_block_stop", index })
}
function thinkingBlock(text: string, index = 0): string {
  return sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }) + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }) + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "fakesig" } }) + sse("content_block_stop", { type: "content_block_stop", index })
}
function prefix(v: string): string {
  switch (v) {
    case "reset-nothing": return messageStart()
    case "reset-after-thinking": return messageStart() + thinkingBlock("thinking done")
    case "reset-after-anchor-closed": return messageStart() + textBlock("", 0)      // 完成的空 text 块（= anchor 关闭后）
    case "reset-after-anchor-open":
      // 打开的空 text 块（无 stop，= anchor 未关）
      return messageStart() + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
    case "reset-after-text": return messageStart() + textBlock("Real partial.", 0)  // 完成的真实 text 块
    default: return messageStart()
  }
}

// chunked-encode 一个字符串体
function chunk(s: string): string {
  const bytes = Buffer.byteLength(s, "utf8")
  return `${bytes.toString(16)}\r\n${s}\r\n`
}

Bun.listen({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open(socket) {
      // per-socket 缓冲：排空完整请求（CC 请求 165KB 多包到达），静默 60ms 视为收全再响应
      ;(socket as unknown as { data: { buf: string; timer: ReturnType<typeof setTimeout> | null; responded: boolean } }).data = { buf: "", timer: null, responded: false }
    },
    data(socket, data) {
      const st = (socket as unknown as { data: { buf: string; timer: ReturnType<typeof setTimeout> | null; responded: boolean } }).data
      st.buf += data.toString("utf8")
      if (st.responded) return
      if (st.timer) clearTimeout(st.timer)
      st.timer = setTimeout(() => {
        if (st.responded) return
        const req = st.buf
        if (req.includes("/hits")) {
          const bodyStr = JSON.stringify({ connCount })
          socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(bodyStr)}\r\nconnection: close\r\n\r\n${bodyStr}`)
          socket.end()
          st.responded = true
          return
        }
        if (!req.includes("POST")) {
          socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
          socket.end()
          st.responded = true
          return
        }
        st.responded = true
        connCount++
        const n = connCount
        const head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ntransfer-encoding: chunked\r\n\r\n"
        socket.write(head + chunk(prefix(RSTVARIANT)))
        process.stderr.write(`[rst-fake ${new Date().toISOString()}] CONN #${n} sent prefix (${RSTVARIANT}), will ${RST_MODE} in 150ms\n`)
        setTimeout(() => {
          try {
            if (RST_MODE === "terminate") socket.terminate()
            else socket.end()
          } catch {}
        }, 150)
      }, 60)
    },
  },
})
process.stderr.write(`[rst-fake] listening :${PORT} variant=${RSTVARIANT} mode=${RST_MODE}\n`)
