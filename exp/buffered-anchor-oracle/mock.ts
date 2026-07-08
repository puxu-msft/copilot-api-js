// Controllable mock GHC (GitHub Copilot) UPSTREAM for the buffered `empty_text` anchor oracle
// (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.6, plan Task 6.1).
//
// UNLIKE exp/cc-idle-280s/mock.ts (which was Claude Code's DIRECT upstream), this mock sits
// BEHIND the copilot-api proxy: it is the proxy's GHC upstream, reached via the proxy's
// `ghc_api_base_url`. The wire is still native Anthropic Messages SSE, because Claude models on
// GHC advertise `supported_endpoints:["/v1/messages"]` and the proxy passes them through verbatim
// to `${ghc_api_base_url}/v1/messages` (src/lib/anthropic/client.ts:126).
//
//   Claude Code CLI ──Anthropic──▶ copilot-api proxy (4141) ──Anthropic──▶ THIS MOCK
//                                   (buffered + empty_text anchor injection lives here)
//
// The proxy applies `protect_streaming_generation` (buffered-retry) + `stream_keepalive_mode`
// (empty_text anchor). This mock only reproduces the UPSTREAM shape for each oracle chain; the
// anchor / keepalive / retry behaviour under test is entirely the proxy's. See README.md.
//
// ── Endpoints ──────────────────────────────────────────────────────────────────────────────
//   GET  /models                     → catalogue advertising one anthropic /v1/messages model
//   POST /v1/messages                → Anthropic SSE stream shaped by the CURRENT chain mode
//   POST /v1/messages/count_tokens   → {input_tokens} stub
//   POST /__mode  {chain}            → control: set active chain + RESET attempt/turn counters
//   GET  /__mode                     → control: inspect current chain + counters
//
// ── Chains (set via POST /__mode before each run; see run-chain.sh) ─────────────────────────
//   keepalive     message_start + content_block_start(thinking) @0, then SILENCE for
//                 MOCK_SILENCE_SEC (default 320, > CC's 300s deadline), then a clean thinking
//                 tail. The proxy must inject the empty-text anchor to keep CC alive past 300s.
//   thinking      message_start, then a SHORT silence (MOCK_ANCHOR_SILENCE_SEC, default 25s —
//                 long enough for the proxy to inject one anchor), then a REAL first block =
//                 thinking (+signature) followed by a tool_use block + stop_reason:tool_use.
//                 CC therefore receives [0]=empty-text anchor, [1]=thinking, [2]=tool_use, runs
//                 the tool, and sends a SECOND turn back. This mock VALIDATES every inbound
//                 request the way real Anthropic does: if an assistant message carries a thinking
//                 block that is NOT the first content block (e.g. a leading empty text anchor was
//                 NOT stripped), it replies 400 — so a passing run proves the proxy's
//                 `filterEmptyAnthropicTextBlocks` stripped the anchor and thinking is first again.
//   retry         Attempt 1: message_start + content_block_start(text) + a partial text_delta,
//                 then an ABRUPT transport error (no message_stop) → the proxy's buffered-retry
//                 must re-run the upstream exchange. Attempt 2+: a full clean text generation.
//                 Proves CC sees ONE complete generation, a single message_start, contiguous
//                 real block indices.
//
// The mock logs (monotonic ts) every phase transition, every inbound request's turn shape, and
// every abort/error so the operator can reconstruct exactly what happened.

const PORT = Number(process.env.MOCK_PORT ?? 8890)
const MODEL = process.env.MOCK_MODEL ?? "claude-opus-4-8"
/** keepalive chain: upstream silence (s) after the open block — set > CC's 300s deadline. */
const SILENCE_SEC = Number(process.env.MOCK_SILENCE_SEC ?? 320)
/** thinking chain: silence (s) before the real thinking block, to let the proxy inject an anchor. */
const ANCHOR_SILENCE_SEC = Number(process.env.MOCK_ANCHOR_SILENCE_SEC ?? 25)

const t0 = performance.now()
const rel = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const ts = () => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>) => console.error(`[mock ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Chain = "keepalive" | "thinking" | "retry"

// ── Mutable per-run control state (reset via POST /__mode) ───────────────────────────────────
let chain: Chain = (process.env.MOCK_CHAIN as Chain) || "keepalive"
let messagesSeen = 0 // POST /v1/messages count since last reset (retry chain: attempt number)
let validationRejections = 0 // thinking chain: count of 400s emitted (a passing run must stay 0)

// ── Anthropic SSE builders ───────────────────────────────────────────────────────────────────
const messageStart = () =>
  sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_mock_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })

const thinkingOpen = (index = 0) =>
  sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })

const textOpen = (index = 0, text = "") =>
  sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text } })

// A REAL thinking block that finishes legally: some thinking text + a signature + stop.
function thinkingBlockTail(index = 0): Array<Uint8Array> {
  return [
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "Let me think about this briefly." } }),
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "bW9ja3NpZ25hdHVyZQ==" } }),
    sse("content_block_stop", { type: "content_block_stop", index }),
  ]
}

// A tool_use block (Bash echo) that CC will execute → forces a second turn.
function toolUseBlock(index: number): Array<Uint8Array> {
  return [
    sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: "toolu_mock_oracle_01", name: "Bash", input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo oracle-tool-ran", description: "oracle round-trip trigger" }) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index }),
  ]
}

const messageDelta = (stopReason: string) =>
  sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 6 } })
const messageStop = () => sse("message_stop", { type: "message_stop" })

// A whole simple text answer (used for tail of keepalive/thinking-turn2/retry-attempt2).
function textAnswer(text: string, index = 0): Array<Uint8Array> {
  return [
    textOpen(index),
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index }),
    messageDelta("end_turn"),
    messageStop(),
  ]
}

// ── Inbound validation (thinking chain): real-Anthropic "thinking must be first block" rule ───
interface InboundBlock { type?: string, text?: string, thinking?: string }
interface InboundMsg { role?: string, content?: string | Array<InboundBlock> }
interface InboundBody { messages?: Array<InboundMsg> }

/**
 * Returns a human-readable reason string if the request VIOLATES the thinking-first invariant
 * (an assistant message whose thinking block is not the first content block — i.e. a leading
 * text/other block precedes thinking). Returns undefined when the request is clean.
 * Mirrors the real Anthropic 400 that the proxy's filterEmptyAnthropicTextBlocks must prevent.
 */
function thinkingFirstViolation(body: InboundBody): string | undefined {
  for (const [i, msg] of (body.messages ?? []).entries()) {
    if (msg.role !== "assistant" || typeof msg.content === "string" || !Array.isArray(msg.content)) continue
    const blocks = msg.content
    const thinkingIdx = blocks.findIndex((b) => b.type === "thinking" || b.type === "redacted_thinking")
    if (thinkingIdx > 0) {
      const leading = blocks.slice(0, thinkingIdx).map((b) => b.type).join(",")
      return `messages[${i}]: thinking block at position ${thinkingIdx}, not first (leading blocks: ${leading})`
    }
  }
  return undefined
}

// ── Per-chain SSE stream bodies ───────────────────────────────────────────────────────────────

function keepaliveBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(messageStart())
        controller.enqueue(thinkingOpen(0))
        log(`   keepalive: sent message_start + thinking content_block_start; now SILENT for ${SILENCE_SEC}s ${rel()}`)
        const deadline = performance.now() + SILENCE_SEC * 1000
        while (performance.now() < deadline) {
          if (signal.aborted) {
            log(`<- keepalive: client(proxy) ABORTED during silence ${rel()}`)
            try { controller.close() } catch { /* already closed */ }
            return
          }
          await sleep(1000)
        }
        log(`-> keepalive: ${SILENCE_SEC}s silence elapsed WITHOUT abort — proxy kept CC alive; sending thinking tail ${rel()}`)
        for (const f of thinkingBlockTail(0)) controller.enqueue(f)
        for (const f of textAnswer("ok", 1)) controller.enqueue(f)
        controller.close()
        log(`-> keepalive: tail sent, stream closed ${rel()}`)
      } catch (e) {
        log(`-> keepalive: stream error ${String(e)} ${rel()}`)
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
}

function thinkingTurn1Body(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(messageStart())
        log(`   thinking turn1: sent message_start; SILENT ${ANCHOR_SILENCE_SEC}s so proxy injects an anchor ${rel()}`)
        const deadline = performance.now() + ANCHOR_SILENCE_SEC * 1000
        while (performance.now() < deadline) {
          if (signal.aborted) {
            log(`<- thinking turn1: proxy ABORTED during pre-content silence ${rel()}`)
            try { controller.close() } catch { /* already closed */ }
            return
          }
          await sleep(1000)
        }
        log(`-> thinking turn1: sending REAL thinking@0 + tool_use@1, stop_reason:tool_use ${rel()}`)
        controller.enqueue(thinkingOpen(0))
        for (const f of thinkingBlockTail(0)) controller.enqueue(f)
        for (const f of toolUseBlock(1)) controller.enqueue(f)
        controller.enqueue(messageDelta("tool_use"))
        controller.enqueue(messageStop())
        controller.close()
        log(`-> thinking turn1: tool_use tail sent, stream closed ${rel()}`)
      } catch (e) {
        log(`-> thinking turn1: stream error ${String(e)} ${rel()}`)
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
}

function thinkingTurn2Body(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(messageStart())
      for (const f of textAnswer("done", 0)) controller.enqueue(f)
      controller.close()
      log(`-> thinking turn2: clean text answer sent (inbound passed thinking-first validation) ${rel()}`)
    },
  })
}

function retryAttempt1Body(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(messageStart())
        controller.enqueue(textOpen(0))
        controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial-before-" } }))
        log(`   retry attempt1: sent message_start + partial text, now ABORTING mid-stream (truncation) ${rel()}`)
        await sleep(200)
        if (signal.aborted) { try { controller.close() } catch { /* closed */ } ; return }
        // Abrupt transport error, NO message_stop → proxy sees a truncated stream → buffered-retry.
        controller.error(new Error("mock upstream RST (simulated NGHTTP2_CANCEL / truncation)"))
        log(`<- retry attempt1: stream errored (RST) ${rel()}`)
      } catch (e) {
        log(`-> retry attempt1: unexpected error ${String(e)} ${rel()}`)
      }
    },
  })
}

function retryAttempt2Body(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(messageStart())
      for (const f of textAnswer("complete-generation", 0)) controller.enqueue(f)
      controller.close()
      log(`-> retry attempt2: full clean generation sent, stream closed ${rel()}`)
    },
  })
}

// ── Model catalogue ───────────────────────────────────────────────────────────────────────────
function modelsResponse(): Response {
  const model = {
    id: MODEL,
    name: MODEL,
    object: "model",
    vendor: "anthropic",
    version: MODEL,
    preview: false,
    model_picker_enabled: true,
    is_chat_default: true,
    is_chat_fallback: false,
    model_picker_category: "versatile",
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: "claude-opus",
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      supports: { streaming: true, tool_calls: true, parallel_tool_calls: true, vision: true },
      limits: { max_context_window_tokens: 200000, max_output_tokens: 16000, max_prompt_tokens: 180000 },
    },
  }
  return new Response(JSON.stringify({ object: "list", data: [model] }), {
    headers: { "content-type": "application/json", etag: `"mock-oracle-${MODEL}"` },
  })
}

const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }

Bun.serve({
  port: PORT,
  idleTimeout: 0, // never let Bun.serve time out the socket — the chains control all timing
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // ── Control endpoint ──────────────────────────────────────────────────────────────────
    if (path === "/__mode") {
      if (req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { chain?: string }
        if (b.chain === "keepalive" || b.chain === "thinking" || b.chain === "retry") chain = b.chain
        messagesSeen = 0
        validationRejections = 0
        log(`== control: chain set to '${chain}', counters reset ==`)
      }
      return new Response(JSON.stringify({ chain, messagesSeen, validationRejections }), {
        headers: { "content-type": "application/json" },
      })
    }

    if (path.endsWith("/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } })
    }
    if (req.method === "GET" && path.includes("/models")) {
      log(`GET ${path} → models catalogue`)
      return modelsResponse()
    }
    if (!path.endsWith("/messages")) {
      return new Response(JSON.stringify({ ok: true, note: "mock GHC upstream" }), { headers: { "content-type": "application/json" } })
    }

    // ── POST /v1/messages ─────────────────────────────────────────────────────────────────
    messagesSeen++
    const body = (await req.json().catch(() => ({}))) as InboundBody
    const nMsgs = body.messages?.length ?? 0
    const hasAssistantThinking = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"),
    )
    log(`POST ${path} chain=${chain} req#${messagesSeen} messages=${nMsgs} assistantThinking=${hasAssistantThinking}`)

    // Validate the thinking-first invariant on EVERY inbound (real Anthropic would 400 otherwise).
    const violation = thinkingFirstViolation(body)
    if (violation) {
      validationRejections++
      log(`<- 400 thinking-first VIOLATION: ${violation}  (proxy did NOT strip the empty-text anchor)`)
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `messages: ${violation}. Expected 'thinking' or 'redacted_thinking', but found leading block.` } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }

    const signal = req.signal
    if (chain === "keepalive") return new Response(keepaliveBody(signal), { status: 200, headers: sseHeaders })
    if (chain === "thinking") {
      // Turn 1 = the request WITHOUT any assistant message (or messagesSeen===1); later turns are clean answers.
      const isFirstTurn = !hasAssistantThinking
      return new Response(isFirstTurn ? thinkingTurn1Body(signal) : thinkingTurn2Body(), { status: 200, headers: sseHeaders })
    }
    // retry chain
    const body_ = messagesSeen === 1 ? retryAttempt1Body(signal) : retryAttempt2Body()
    return new Response(body_, { status: 200, headers: sseHeaders })
  },
})

log(`listening on http://localhost:${PORT}  (chain=${chain} model=${MODEL} silence=${SILENCE_SEC}s anchorSilence=${ANCHOR_SILENCE_SEC}s)`)
log(`point the proxy's ghc_api_base_url at http://localhost:${PORT}; select a chain via POST /__mode {"chain":"keepalive|thinking|retry"}`)
