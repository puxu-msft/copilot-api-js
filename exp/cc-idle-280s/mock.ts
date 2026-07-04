// Controllable mock Anthropic upstream for the CC ~280s "no real content" idle probe.
//
// Faithfully reproduces the user's incident SHAPE: 200 + message_start + an OPEN content block
// (thinking / text / tool_use), then a long silence broken ONLY by a chosen keepalive frame every
// N seconds — up to M seconds — then (if the client is still connected) a clean tail that finishes
// the block + a tiny answer + message_stop.
//
// The whole point: does the CHOICE of keepalive frame change when CC's watchdog gives up?
//   MOCK_MODE=idle:TYPE:N:M
//     TYPE          open block   keepalive frame every N s
//     ----          ----------   -------------------------
//     ping          thinking     `event: ping` / {type:"ping"}                    (current proxy behavior)
//     comment       thinking     raw SSE comment line `: keepalive`
//     thinkdelta    thinking     content_block_delta + EMPTY thinking_delta (thinking:"")   [proven ✅]
//     textdelta     TEXT         content_block_delta + EMPTY text_delta (text:"")            [Phase 0]
//     inputjsondelta TOOL_USE    content_block_delta + EMPTY input_json_delta (partial_json:"")  [Phase 0]
//     N    = keepalive interval seconds (user saw 20)
//     M    = keepalive window seconds (set > expected ~300 cutoff, e.g. 340)
//
// mock logs (monotonic ts) every keepalive sent AND the exact +Ns at which CC aborts the request.

const PORT = Number(process.env.MOCK_PORT ?? 8790)
const t0 = performance.now()
const rel = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const ts = () => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>) => console.error(`[mock ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const rawComment = (text: string) => enc.encode(`: ${text}\n\n`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type BlockKind = "thinking" | "text" | "tool_use"

function blockKindFor(type: string): BlockKind {
  if (type === "textdelta") return "text"
  if (type === "inputjsondelta") return "tool_use"
  return "thinking" // ping, thinkdelta, comment
}

const messageStart = () =>
  sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock_idle_0001",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })

// The OPEN content block for this arm (mirrors the user's incident: a block is open, then silence).
function blockStart(kind: BlockKind, index = 0): Uint8Array {
  if (kind === "text") return sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
  if (kind === "tool_use")
    return sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: "toolu_mock_01", name: "mock_tool", input: {} },
    })
  return sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
}

// The keepalive frame for each arm (index matches the open block).
function keepaliveFrame(type: string, index = 0): Uint8Array {
  switch (type) {
    case "ping":
      return sse("ping", { type: "ping" })
    case "comment":
      return rawComment("keepalive")
    case "thinkdelta":
      return sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "" } })
    case "textdelta":
      return sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: "" } })
    case "inputjsondelta":
      return sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "" } })
    default:
      return sse("ping", { type: "ping" })
  }
}

// Clean tail after the keepalive window — finish the open block legally, then message_stop.
function tail(kind: BlockKind, index = 0): Array<Uint8Array> {
  if (kind === "text") {
    return [
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: "ok" } }),
      sse("content_block_stop", { type: "content_block_stop", index }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
      sse("message_stop", { type: "message_stop" }),
    ]
  }
  if (kind === "tool_use") {
    return [
      // Make the accumulated input legal JSON ({}) — empty partial_json keepalives contributed "".
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } }),
      sse("content_block_stop", { type: "content_block_stop", index }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }),
      sse("message_stop", { type: "message_stop" }),
    ]
  }
  // thinking: close with a signature_delta + stop, then a tiny text block, then stop.
  return [
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "bW9ja3NpZw==" } }),
    sse("content_block_stop", { type: "content_block_stop", index }),
    sse("content_block_start", { type: "content_block_start", index: index + 1, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: index + 1, delta: { type: "text_delta", text: "ok" } }),
    sse("content_block_stop", { type: "content_block_stop", index: index + 1 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
  ]
}

function resolveMode(req: Request): string {
  return req.headers.get("x-mock-mode") ?? process.env.MOCK_MODE ?? "idle:ping:20:340"
}

Bun.serve({
  port: PORT,
  idleTimeout: 0, // never let Bun.serve time out the socket — we control all timing
  async fetch(req) {
    const url = new URL(req.url)
    const mode = resolveMode(req)
    log(`${req.method} ${url.pathname} mode=${mode} ua=${req.headers.get("user-agent") ?? "-"}`)

    if (url.pathname.endsWith("/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } })
    }
    if (req.method === "GET" && url.pathname.includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-4-8", type: "model" }] }), {
        headers: { "content-type": "application/json" },
      })
    }
    if (!url.pathname.endsWith("/messages")) {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
    }

    const [kind, type = "ping", nStr = "20", mStr = "340"] = mode.split(":")
    const blockKind = blockKindFor(type)
    if (kind !== "idle") {
      log(`-> unknown mode ${mode}; falling back to ok baseline`)
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(messageStart())
          for (const f of tail("text")) controller.enqueue(f)
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    const interval = Number(nStr)
    const total = Number(mStr)
    log(`-> idle probe: message_start + ${blockKind} block start, then '${type}' every ${interval}s for ${total}s, then tail`)

    const body = new ReadableStream({
      async start(controller) {
        const start = performance.now()
        let sent = 0
        try {
          controller.enqueue(messageStart())
          controller.enqueue(blockStart(blockKind))
          log(`   sent message_start + ${blockKind} content_block_start ${rel()}`)
          while ((performance.now() - start) / 1000 < total) {
            if (req.signal.aborted) {
              log(`<- client ABORTED after ${sent} '${type}' keepalives at ${rel()} (elapsed ${((performance.now() - start) / 1000).toFixed(2)}s)`)
              try { controller.close() } catch {}
              return
            }
            await sleep(interval * 1000)
            if (req.signal.aborted) {
              log(`<- client ABORTED (during sleep) after ${sent} '${type}' keepalives at ${rel()}`)
              try { controller.close() } catch {}
              return
            }
            controller.enqueue(keepaliveFrame(type))
            sent++
            log(`   '${type}' keepalive #${sent} sent ${rel()}`)
          }
          log(`-> keepalive window elapsed (${total}s) WITHOUT abort; sending ${blockKind} tail (CC survived)`)
          for (const f of tail(blockKind)) controller.enqueue(f)
          controller.close()
          log(`-> tail sent, stream closed ${rel()}`)
        } catch (e) {
          log(`-> stream error: ${String(e)}`)
          try { controller.close() } catch {}
        }
      },
    })
    req.signal.addEventListener("abort", () => log(`<- req.signal abort event ${rel()}`))
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  },
})

log(`listening on http://localhost:${PORT}  (MOCK_MODE=${process.env.MOCK_MODE ?? "idle:ping:20:340"})`)
