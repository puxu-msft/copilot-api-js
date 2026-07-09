// Mock GHC (Copilot) UPSTREAM for the LIVE-path pre-response keepalive oracle (task 7.1 /
// spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.8 / ADR 2026-07-09).
//
// TOPOLOGY (differs from mock.ts!):  real `claude` (CC)  ─→  copilot-api PROXY :4141  ─→  THIS mock.
//   - mock.ts drives CC DIRECTLY (CC ← mock): it tests "does CC's watchdog accept frame type X".
//   - THIS mock sits UPSTREAM of the proxy (proxy ← mock): it tests whether the PROXY SYNTHESIZES the
//     empty_text prelude when the GHC upstream is silent. Point the proxy at it with
//     `--ghc-api-base-url http://localhost:<port>` (or `ghc_api_base_url` in config.yaml).
//
// It faithfully reproduces the LIVE-path incident `req_1783609043247_663` (ADR 2026-07-09): the GHC
// `/v1/messages` upstream returns NO response headers AT ALL for a long silence window — a PURE
// pre-response stall (not even a `message_start`). That is the window the handler-owned unique
// injector (makeSyntheticAnchorInjector) must cover while `await p` (runRequest) is still pending and
// the driver/pump have not yet run. The proxy's delayed-commit opens 200 to CC at
// stream_commit_after_sec (20s); with stream_keepalive_mode=empty_text + no captured message_start it
// synthesizes a message_start prelude + empty-text anchor + empty text_delta every heartbeat, which
// resets CC's 300s no-real-content watchdog. A bare `ping` (stream_keepalive_mode=ping) does NOT →
// CC disconnects at ~300-320s ("Stream idle timeout - no chunks received").
//
// MOCK_UPSTREAM_MODE=silent:<SILENCE_SEC>[:<tail>]
//   SILENCE_SEC  seconds to hold the response (NO headers sent) before replying. MUST exceed CC's
//                300s watchdog to prove survival; the proxy's responseHeaderTimeout / streamIdleTimeout
//                (default 300!) MUST be raised ABOVE SILENCE_SEC (set timeouts.response_header:900 +
//                timeouts.stream_idle:900) or the proxy aborts the upstream first. Default 330.
//   tail         "text" (default) | "none". After the silence, "text" returns a clean 200 SSE stream
//                (message_start + a tiny text block + message_stop) so the proxy pumps real content to
//                CC — proving CC was STILL CONNECTED past 300s (is_error=false). "none" closes the
//                socket with no body (CC would then end on the proxy's terminal error frame).
//
// Serves `/models` from refs/AVAILABLE_MODELS.json (the proxy builds its model index from it — needs
// vendor:"Anthropic" + supported_endpoints:["/v1/messages"]) and `/count_tokens` so the proxy's
// pre-flight succeeds. Logs (monotonic ts) the silence start, the proxy abort (if it gives up), and
// the tail send.

import { readFileSync } from "node:fs"

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8799)
const MODELS_PATH = new URL("../../refs/AVAILABLE_MODELS.json", import.meta.url).pathname

const t0 = performance.now()
const rel = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const ts = () => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>) => console.error(`[mock-upstream ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const MODELS_BODY = readFileSync(MODELS_PATH, "utf8")

// The clean tail after the silence: a REAL message_start (the proxy's live reconcile DROPS it — the
// synthetic one already opened the message) + a tiny text block (remapped to index+1 behind the
// synthetic anchor@0) + message_stop. Proves CC survived the silence and completes cleanly.
function tailFrames(): Array<Uint8Array> {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_mock_upstream_663",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
  ]
}

function resolveMode(req: Request): string {
  return req.headers.get("x-mock-mode") ?? process.env.MOCK_UPSTREAM_MODE ?? "silent:330:text"
}

Bun.serve({
  port: PORT,
  idleTimeout: 0, // never let Bun.serve time out the socket — we control all timing
  async fetch(req) {
    const url = new URL(req.url)
    log(`${req.method} ${url.pathname} ua=${req.headers.get("user-agent") ?? "-"}`)

    // Model catalog — the proxy builds its model index from this (needs Anthropic vendor + /v1/messages).
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      return new Response(MODELS_BODY, { status: 200, headers: { "content-type": "application/json", etag: `"mock-upstream-${PORT}"` } })
    }
    // Token counting pre-flight.
    if (url.pathname.endsWith("/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } })
    }
    if (!url.pathname.endsWith("/messages")) {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
    }

    const mode = resolveMode(req)
    const [kind, silenceStr = "330", tail = "text"] = mode.split(":")
    if (kind !== "silent") {
      log(`-> unknown mode ${mode}; replying with a clean baseline stream`)
      const body = new ReadableStream({
        start(controller) {
          for (const f of tailFrames()) controller.enqueue(f)
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }

    const silenceSec = Number(silenceStr)
    log(`-> PURE pre-response silence: holding the response (NO headers) for ${silenceSec}s, then tail=${tail} ${rel()}`)

    // Hold the RESPONSE — send NO headers — for the silence window. This is the crux: the proxy sees
    // `await p` (runRequest) pending with no upstream headers, force-commits 200 to CC at
    // stream_commit_after_sec, and the handler-owned injector must keep CC alive on the heartbeat.
    let aborted = false
    req.signal.addEventListener("abort", () => {
      aborted = true
      log(`<- proxy ABORTED the upstream request at ${rel()} (proxy responseHeaderTimeout/streamIdleTimeout fired, or CC gave up and the abort bridged through). Raise timeouts.response_header + timeouts.stream_idle ABOVE ${silenceSec}s.`)
    })

    // Poll so we can log the abort promptly (a single long sleep would swallow it).
    const deadline = performance.now() + silenceSec * 1000
    while (performance.now() < deadline) {
      if (aborted) return new Response(null, { status: 499 })
      await sleep(Math.min(1000, deadline - performance.now()))
    }

    if (tail === "none") {
      log(`-> silence window (${silenceSec}s) elapsed WITHOUT abort; closing with no body ${rel()}`)
      return new Response(null, { status: 204 })
    }

    log(`-> silence window (${silenceSec}s) elapsed WITHOUT abort; sending clean text tail (proxy pumps it → proves CC survived) ${rel()}`)
    const body = new ReadableStream({
      start(controller) {
        for (const f of tailFrames()) controller.enqueue(f)
        controller.close()
        log(`-> tail sent, upstream stream closed ${rel()}`)
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  },
})

log(`listening on http://localhost:${PORT}  (MOCK_UPSTREAM_MODE=${process.env.MOCK_UPSTREAM_MODE ?? "silent:330:text"})  models=${MODELS_PATH}`)
