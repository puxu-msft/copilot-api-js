// Controllable mock Anthropic upstream for Q2 oracle measurement.
//
// Two control channels:
//   1. header `x-mock-mode` (used by the SDK probe, which we author) — precise per-request control.
//   2. env MOCK_MODE (used by the real `claude` CLI driver, which cannot send custom headers) —
//      whole-process default behavior; we spawn a fresh mock per CC scenario.
//
// Modes (mode[:arg]):
//   silent:N            — accept POST /v1/messages, send NOTHING for N seconds, then close. (pre-response silence)
//   ping:N:M            — 200 + SSE, emit ONLY `event: ping` every N seconds for M seconds, then a clean
//                         message_start..message_stop tail. (idle-reset probe: bytes but no message_start for a while)
//   http-error:CODE     — return real HTTP CODE with a canonical Anthropic error body. (real-Anthropic / current-proxy shape)
//   sse-error:CODE      — 200 + a single `event: error` frame as the FIRST semantic event (rich frame:
//                         type + retry_after), then close. (the ③ POST-COMMIT shape from mapHttpErrorToEnvelope)
//   commit-then-error:CODE:D — 200 + message_start + ping, then after D seconds an `event: error` frame. (post-commit error)
//   ok                  — 200 + a minimal complete streaming response. (baseline)
//
// Every request is logged to stderr with a monotonic + wall timestamp so the CC driver can correlate disconnects.

const PORT = Number(process.env.MOCK_PORT ?? 8788)
const t0 = performance.now()

const ts = () => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>) => console.error(`[mock ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const errorBody = (code: number) => {
  // canonical Anthropic error envelope shape per status (mirrors forwardError / mapHttpErrorToEnvelope)
  const type =
    code === 429 ? "rate_limit_error"
    : code === 401 ? "authentication_error"
    : code === 400 ? "invalid_request_error"
    : code === 403 ? "permission_error"
    : "api_error"
  const message =
    code === 429 ? "Number of requests has exceeded your rate limit"
    : code === 401 ? "invalid x-api-key"
    : code === 400 ? "messages: at least one message is required"
    : "upstream error"
  return { type: "error", error: { type, message } }
}

const messageStart = () =>
  sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock_0001",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })

const helloTail = (text: string) => [
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
  sse("message_stop", { type: "message_stop" }),
]

function resolveMode(req: Request): string {
  const hdr = req.headers.get("x-mock-mode")
  if (hdr) return hdr
  return process.env.MOCK_MODE ?? "ok"
}

Bun.serve({
  port: PORT,
  idleTimeout: 0, // never let Bun.serve itself time out the socket — we control timing entirely
  async fetch(req) {
    const url = new URL(req.url)
    const mode = resolveMode(req)
    log(`${req.method} ${url.pathname} mode=${mode} ua=${req.headers.get("user-agent") ?? "-"}`)

    // Non-message endpoints CC may hit during startup — answer fast so it reaches the message request.
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

    const [kind, a, b] = mode.split(":")

    // --- noheaders: withhold the 200 status line itself for N seconds (TRUE pre-response silence,
    //     models the incident: GHC never sent even response headers). Measures CC's time-to-first-byte
    //     tolerance => the grace UPPER bound (proxy must commit 200 before CC gives up waiting). ---
    if (kind === "noheaders") {
      const secs = Number(a ?? 600)
      log(`-> WITHHOLDING headers for ${secs}s (true pre-response silence)`)
      const start = performance.now()
      req.signal.addEventListener("abort", () =>
        log(`<- client ABORTED while waiting for headers at +${((performance.now() - start) / 1000).toFixed(2)}s`),
      )
      // poll the abort signal while withholding the Response entirely
      while (performance.now() - start < secs * 1000) {
        if (req.signal.aborted) {
          log(`<- detected abort (no headers ever sent) at +${((performance.now() - start) / 1000).toFixed(2)}s`)
          return new Response(null, { status: 499 })
        }
        await sleep(250)
      }
      log(`-> header-withhold window elapsed (${secs}s) without abort; now sending 200 + tail`)
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(messageStart())
          for (const f of helloTail("late")) controller.enqueue(f)
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }


    // --- HTTP error (real-Anthropic shape): pre-response status code ---
    // http-error:CODE[:RETRYAFTER]  (RETRYAFTER seconds; "0" or omitted-for-non-429 = no header)
    if (kind === "http-error") {
      const code = Number(a ?? 429)
      const headers: Record<string, string> = { "content-type": "application/json", "request-id": "req_mock" }
      const ra = b !== undefined ? Number(b) : code === 429 ? 30 : 0
      if (ra > 0) headers["retry-after"] = String(ra)
      log(`-> HTTP ${code} (real-anthropic shape; retry-after=${ra || "none"})`)
      return new Response(JSON.stringify(errorBody(code)), { status: code, headers })
    }

    // --- silent: hold the response open, send nothing ---
    if (kind === "silent") {
      const secs = Number(a ?? 600)
      log(`-> silent hold for ${secs}s (pre-response silence; client governs disconnect)`)
      const body = new ReadableStream({
        async start(controller) {
          const start = performance.now()
          // poll so we can observe & log when the client aborts (req.signal)
          while (performance.now() - start < secs * 1000) {
            if (req.signal.aborted) {
              log(`<- client ABORTED during silence at +${((performance.now() - start) / 1000).toFixed(2)}s`)
              try { controller.close() } catch {}
              return
            }
            await sleep(250)
          }
          log(`-> silence window elapsed (${secs}s) without client abort; closing`)
          try { controller.close() } catch {}
        },
      })
      req.signal.addEventListener("abort", () => log(`<- req.signal abort event`))
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    // --- ping: 200 + only ping frames every N s for M s, then a clean tail ---
    if (kind === "ping") {
      const interval = Number(a ?? 15)
      const total = Number(b ?? 600)
      log(`-> ping every ${interval}s for ${total}s, then clean tail`)
      const body = new ReadableStream({
        async start(controller) {
          const start = performance.now()
          let pings = 0
          try {
            while ((performance.now() - start) / 1000 < total) {
              if (req.signal.aborted) {
                log(`<- client ABORTED after ${pings} pings at +${((performance.now() - start) / 1000).toFixed(2)}s`)
                try { controller.close() } catch {}
                return
              }
              controller.enqueue(sse("ping", { type: "ping" }))
              pings++
              log(`   ping #${pings} sent at +${((performance.now() - start) / 1000).toFixed(2)}s`)
              await sleep(interval * 1000)
            }
            log(`-> ping window elapsed; emitting message_start..stop tail`)
            controller.enqueue(messageStart())
            for (const f of helloTail("done")) controller.enqueue(f)
            controller.close()
          } catch (e) {
            log(`-> ping stream error: ${String(e)}`)
            try { controller.close() } catch {}
          }
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    // --- sse-error: 200, FIRST semantic event is a rich error frame ---
    if (kind === "sse-error") {
      const code = Number(a ?? 429)
      const eb = errorBody(code)
      // rich frame: attach retry_after for 429 (what mapHttpErrorToEnvelope preserves)
      const data: Record<string, unknown> = { ...eb }
      if (code === 429) (data.error as Record<string, unknown>).retry_after = 30
      log(`-> 200 + SSE error frame FIRST (rich; type=${(eb.error as { type: string }).type})`)
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(sse("error", data))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    // --- commit-then-error: 200 + message_start + ping, then error frame after D s ---
    if (kind === "commit-then-error") {
      const code = Number(a ?? 429)
      const delay = Number(b ?? 3)
      const eb = errorBody(code)
      const data: Record<string, unknown> = { ...eb }
      if (code === 429) (data.error as Record<string, unknown>).retry_after = 30
      log(`-> 200 + message_start + ping, then error(${code}) after ${delay}s`)
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(messageStart())
          controller.enqueue(sse("ping", { type: "ping" }))
          await sleep(delay * 1000)
          controller.enqueue(sse("error", data))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    // --- ok baseline ---
    log(`-> 200 ok baseline`)
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(messageStart())
        for (const f of helloTail("hi")) controller.enqueue(f)
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  },
})

log(`listening on http://localhost:${PORT}  (MOCK_MODE=${process.env.MOCK_MODE ?? "ok"})`)
