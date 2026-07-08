// Controllable mock GHC (GitHub Copilot) UPSTREAM for the buffered `empty_text` anchor oracle
// (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.6, plan Task 6.1).
//
// UNLIKE exp/cc-idle-280s/mock.ts (which was Claude Code's DIRECT upstream), this mock sits
// BEHIND the copilot-api proxy: it is the proxy's GHC upstream, reached via the proxy's
// `ghc_api_base_url`. The wire is still native Anthropic Messages SSE, because Claude models on
// GHC advertise `supported_endpoints:["/v1/messages"]` and the proxy passes them through verbatim
// to `${ghc_api_base_url}/v1/messages` (src/lib/anthropic/client.ts:126).
//
//   Claude Code CLI ──Anthropic──▶ copilot-api proxy (4142) ──Anthropic──▶ THIS MOCK
//                                   (buffered + empty_text anchor injection lives here)
//
// The proxy applies `protect_streaming_generation` (buffered-retry) + `stream_keepalive_mode`
// (empty_text anchor). This mock only reproduces the UPSTREAM shape for each oracle chain; the
// anchor / keepalive / retry behaviour under test is entirely the proxy's. See README.md.
//
// ── TRANSPORT: node:http2 secure server (HTTPS/h2), NOT Bun.serve HTTP/1.1 ────────────────────
// This mock is an HTTP/2 (`h2` over TLS) upstream, served by `http2.createSecureServer` with a
// self-signed localhost cert (mock-cert.pem / mock-key.pem). WHY it MUST be h2 + run under Node:
//   - The proxy routes `https://` upstreams through node:http2 (`http2Fetch`, upstream-fetch.ts),
//     and `http://` upstreams through undici. undici's HTTP/1.1 parser HANGS FOREVER under Bun on
//     chunked/incremental responses — the exact reason all real GHC https upstreams already moved
//     to node:http2. A plaintext Bun.serve mock (HTTP/1.1) forces the proxy onto that broken Bun
//     undici path, so any frame-delayed stream (keepalive silence, retry truncation) hangs or is
//     aborted at +1s. Making the mock https/h2 lets the proxy use its production node:http2 client
//     — which works under Bun — so the whole chain runs on the PRODUCTION runtime (Bun), faithfully.
//   - The mock itself MUST run under NODE (not Bun): Bun's http2 SERVER `stream.close(code)` does
//     not emit a faithful RST_STREAM frame (skill bun-upstream-transport) — the Bun *client* sees a
//     clean `end`/rstCode=0. The retry chain relies on a real mid-stream RST to trigger the proxy's
//     buffered-retry, so the server must be Node to emit a truthful frame. Node runs this `.ts`
//     directly via type-stripping (Node 24+); see start-mock.sh.
//
// ── Endpoints ──────────────────────────────────────────────────────────────────────────────
//   GET  /models                     → catalogue advertising the MAIN + AUX anthropic models
//   POST /v1/messages                → Anthropic SSE stream shaped by the CURRENT chain mode
//                                       (MAIN model); AUX-model calls get a trivial 200, uncounted
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
//                 the tool, and sends a SECOND turn back. This mock VALIDATES every MAIN-model
//                 inbound request the way real Anthropic does: if an assistant message carries a
//                 thinking block that is NOT the first content block (e.g. a leading empty text
//                 anchor was NOT stripped), it replies 400.
//                 ATTRIBUTION CAVEAT: a clean end-to-end thinking run (no 400) proves only that
//                 the leading empty-text anchor did NOT reach upstream un-stripped — i.e. the
//                 chain is PRODUCTION-SAFE. It does NOT by itself prove the *proxy* stripped it,
//                 because CC may also drop a leading empty text block when it rebuilds turn-2.
//                 To strictly isolate the proxy's `filterEmptyAnthropicTextBlocks`, run the
//                 POSITIVE CONTROL (replay-turn2.sh): hand-craft a turn-2 body carrying
//                 [empty text, thinking, tool_use] straight to the proxy (bypassing CC) and
//                 assert the proxy strips it so this mock does NOT 400.
//   retry         Attempt 1: message_start + content_block_start(text) + a partial text_delta,
//                 then an ABRUPT RST_STREAM (no message_stop) → the proxy's buffered-retry
//                 must re-run the upstream exchange. Attempt 2+: a full clean text generation.
//                 Proves CC sees ONE complete generation, a single message_start, contiguous
//                 real block indices. The RST is a TRUE h2 frame (stream.close(INTERNAL_ERROR))
//                 — only faithful because this server runs under Node (see transport note above).
//
// The mock logs (monotonic ts) every phase transition, every inbound request's turn shape, and
// every abort/error so the operator can reconstruct exactly what happened.

import { readFileSync } from "node:fs"
import http2 from "node:http2"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.MOCK_PORT ?? 8890)
const MODEL = process.env.MOCK_MODEL ?? "claude-opus-4-8"
/**
 * Auxiliary / small-fast model id (CC's title/topic/quota "haiku" traffic). CC issues these as
 * EXTRA `POST /v1/messages` calls that must NOT pollute the main-chain counters (retry attempt
 * dispatch) or turn detection. run-chain.sh points `ANTHROPIC_SMALL_FAST_MODEL` /
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` at THIS id so the mock can distinguish them by `body.model`
 * (content dispatch), on top of `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (env mitigation).
 */
const AUX_MODEL = process.env.MOCK_AUX_MODEL ?? "claude-mock-haiku"
/** keepalive chain: upstream silence (s) after the open block — set > CC's 300s deadline. */
const SILENCE_SEC = Number(process.env.MOCK_SILENCE_SEC ?? 320)
/** thinking chain: silence (s) before the real thinking block, to let the proxy inject an anchor. */
const ANCHOR_SILENCE_SEC = Number(process.env.MOCK_ANCHOR_SILENCE_SEC ?? 25)
/** TLS material (self-signed localhost). Generated by start-mock.sh if absent. */
const CERT_PATH = process.env.MOCK_CERT ?? path.join(HERE, "mock-cert.pem")
const KEY_PATH = process.env.MOCK_KEY ?? path.join(HERE, "mock-key.pem")

const t0 = performance.now()
const rel = (): string => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const ts = (): string => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>): void => console.error(`[mock ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown): Uint8Array => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

type Chain = "keepalive" | "thinking" | "retry"

// ── Mutable per-run control state (reset via POST /__mode) ───────────────────────────────────
let chain: Chain = (process.env.MOCK_CHAIN as Chain) || "keepalive"
let messagesSeen = 0 // MAIN-model POST /v1/messages count since last reset (retry chain: attempt number)
let auxRequestsSeen = 0 // auxiliary/small-fast-model POST count (CC title/topic/quota) — excluded from chain dispatch
let validationRejections = 0 // thinking chain: count of 400s emitted (a passing run must stay 0)

// ── Anthropic SSE builders ───────────────────────────────────────────────────────────────────
const messageStart = (): Uint8Array =>
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

const thinkingOpen = (index = 0): Uint8Array =>
  sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })

const textOpen = (index = 0, text = ""): Uint8Array =>
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

const messageDelta = (stopReason: string): Uint8Array =>
  sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 6 } })
const messageStop = (): Uint8Array => sse("message_stop", { type: "message_stop" })

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
interface InboundBody { model?: string, stream?: boolean, messages?: Array<InboundMsg> }

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

// ── h2 stream helpers ─────────────────────────────────────────────────────────────────────────
const SSE_HEADERS = { ":status": 200, "content-type": "text/event-stream", "cache-control": "no-cache" }

/** True once the h2 stream can no longer accept writes (closed/destroyed/aborted). */
function streamDead(stream: http2.ServerHttp2Stream): boolean {
  return stream.destroyed || stream.closed || stream.aborted
}

/** Best-effort write of one SSE frame; returns false if the stream is already dead. */
function writeFrame(stream: http2.ServerHttp2Stream, frame: Uint8Array): boolean {
  if (streamDead(stream)) return false
  try {
    stream.write(Buffer.from(frame))
    return true
  } catch {
    return false
  }
}

/** Best-effort clean end of the stream (flushes a final DATA + END_STREAM). */
function endStream(stream: http2.ServerHttp2Stream): void {
  if (streamDead(stream)) return
  try {
    stream.end()
  } catch {
    /* already ended/closed */
  }
}

// ── Per-chain SSE stream bodies (write directly to the h2 stream) ──────────────────────────────

async function keepaliveBody(stream: http2.ServerHttp2Stream): Promise<void> {
  writeFrame(stream, messageStart())
  writeFrame(stream, thinkingOpen(0))
  log(`   keepalive: sent message_start + thinking content_block_start; now SILENT for ${SILENCE_SEC}s ${rel()}`)
  const deadline = performance.now() + SILENCE_SEC * 1000
  while (performance.now() < deadline) {
    if (streamDead(stream)) {
      log(`<- keepalive: client(proxy) ABORTED during silence ${rel()}`)
      return
    }
    await sleep(1000)
  }
  if (streamDead(stream)) {
    log(`<- keepalive: client(proxy) ABORTED at end of silence ${rel()}`)
    return
  }
  log(`-> keepalive: ${SILENCE_SEC}s silence elapsed WITHOUT abort — proxy kept CC alive; sending thinking tail ${rel()}`)
  for (const f of thinkingBlockTail(0)) writeFrame(stream, f)
  for (const f of textAnswer("ok", 1)) writeFrame(stream, f)
  endStream(stream)
  log(`-> keepalive: tail sent, stream closed ${rel()}`)
}

async function thinkingTurn1Body(stream: http2.ServerHttp2Stream): Promise<void> {
  writeFrame(stream, messageStart())
  log(`   thinking turn1: sent message_start; SILENT ${ANCHOR_SILENCE_SEC}s so proxy injects an anchor ${rel()}`)
  const deadline = performance.now() + ANCHOR_SILENCE_SEC * 1000
  while (performance.now() < deadline) {
    if (streamDead(stream)) {
      log(`<- thinking turn1: proxy ABORTED during pre-content silence ${rel()}`)
      return
    }
    await sleep(1000)
  }
  if (streamDead(stream)) return
  log(`-> thinking turn1: sending REAL thinking@0 + tool_use@1, stop_reason:tool_use ${rel()}`)
  writeFrame(stream, thinkingOpen(0))
  for (const f of thinkingBlockTail(0)) writeFrame(stream, f)
  for (const f of toolUseBlock(1)) writeFrame(stream, f)
  writeFrame(stream, messageDelta("tool_use"))
  writeFrame(stream, messageStop())
  endStream(stream)
  log(`-> thinking turn1: tool_use tail sent, stream closed ${rel()}`)
}

function thinkingTurn2Body(stream: http2.ServerHttp2Stream): void {
  writeFrame(stream, messageStart())
  for (const f of textAnswer("done", 0)) writeFrame(stream, f)
  endStream(stream)
  log(`-> thinking turn2: clean text answer sent (inbound passed thinking-first validation) ${rel()}`)
}

async function retryAttempt1Body(stream: http2.ServerHttp2Stream): Promise<void> {
  writeFrame(stream, messageStart())
  writeFrame(stream, textOpen(0))
  writeFrame(stream, sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial-before-" } }))
  log(`   retry attempt1: sent message_start + partial text, now RST_STREAM mid-stream (truncation) ${rel()}`)
  await sleep(200)
  if (streamDead(stream)) { log(`<- retry attempt1: proxy already gone before RST ${rel()}`); return }
  // TRUE mid-stream RST_STREAM, NO message_stop → proxy sees a truncated stream → buffered-retry.
  // Faithful only under Node (Bun's http2 server does not emit a real RST — see transport note).
  try {
    stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
  } catch {
    /* already closing */
  }
  log(`<- retry attempt1: stream RST (NGHTTP2_INTERNAL_ERROR) ${rel()}`)
}

function retryAttempt2Body(stream: http2.ServerHttp2Stream): void {
  writeFrame(stream, messageStart())
  for (const f of textAnswer("complete-generation", 0)) writeFrame(stream, f)
  endStream(stream)
  log(`-> retry attempt2: full clean generation sent, stream closed ${rel()}`)
}

// ── Auxiliary (small-fast) response ───────────────────────────────────────────────────────────
// CC's title/topic/quota calls target AUX_MODEL. Answer them trivially and NEVER touch the
// chain counters/validation, so they can't shift retry-attempt dispatch or thinking turn detection.
function auxResponse(stream: http2.ServerHttp2Stream, streaming: boolean): void {
  if (streaming) {
    stream.respond(SSE_HEADERS)
    writeFrame(stream, messageStart())
    for (const f of textAnswer("aux-ok", 0)) writeFrame(stream, f)
    endStream(stream)
    return
  }
  const payload = JSON.stringify({
    id: `msg_mock_aux_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: AUX_MODEL,
    content: [{ type: "text", text: "aux-ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 2 },
  })
  stream.respond({ ":status": 200, "content-type": "application/json" })
  stream.end(payload)
}

// ── Model catalogue ───────────────────────────────────────────────────────────────────────────
function modelEntry(id: string, category: string): Record<string, unknown> {
  return {
    id,
    name: id,
    object: "model",
    // Real GHC advertises Anthropic models with a capital-A vendor; the proxy's
    // supportsDirectAnthropicApi() gates /v1/messages on exactly `vendor === "Anthropic"`
    // (src/lib/anthropic/features.ts:40). Lowercase here makes the proxy reject with 400.
    vendor: "Anthropic",
    version: id,
    preview: false,
    model_picker_enabled: true,
    is_chat_default: id === MODEL,
    is_chat_fallback: false,
    model_picker_category: category,
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
}

function modelsResponse(stream: http2.ServerHttp2Stream): void {
  // Advertise BOTH the main model AND the auxiliary/small-fast model so CC's haiku traffic
  // resolves to a real catalogue entry (and the proxy passes its id through to `body.model`).
  const data = [modelEntry(MODEL, "versatile"), modelEntry(AUX_MODEL, "lightweight")]
  stream.respond({ ":status": 200, "content-type": "application/json", etag: `"mock-oracle-${MODEL}"` })
  stream.end(JSON.stringify({ object: "list", data }))
}

// ── Read a full request body from an h2 stream ────────────────────────────────────────────────
function readBody(stream: http2.ServerHttp2Stream): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = []
    stream.on("data", (c: Buffer) => chunks.push(c))
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    stream.once("error", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

// ── HTTP/2 secure server ──────────────────────────────────────────────────────────────────────
const server = http2.createSecureServer({
  key: readFileSync(KEY_PATH),
  cert: readFileSync(CERT_PATH),
  ALPNProtocols: ["h2"],
})

// A stray socket/stream 'error' (e.g. proxy RSTs its side, or a TLS reset) must never crash the
// long-lived mock. Absorb them; per-stream handlers log the meaningful ones.
server.on("sessionError", (err) => log(`(sessionError absorbed) ${String(err)}`))
server.on("clientError", (err) => log(`(clientError absorbed) ${String(err)}`))

server.on("stream", (stream, headers) => {
  // Absorb per-stream transport errors (proxy cancel / RST) so they don't bubble to uncaught.
  stream.on("error", (err) => log(`(stream error absorbed) ${String(err)}`))

  const method = String(headers[":method"] ?? "GET")
  const rawPath = String(headers[":path"] ?? "/")
  const pathname = rawPath.split("?")[0]

  void (async (): Promise<void> => {
    // ── Control endpoint ──────────────────────────────────────────────────────────────────
    if (pathname === "/__mode") {
      if (method === "POST") {
        const raw = await readBody(stream)
        let b: { chain?: string } = {}
        try { b = JSON.parse(raw) as { chain?: string } } catch { /* empty/invalid → just report */ }
        if (b.chain === "keepalive" || b.chain === "thinking" || b.chain === "retry") chain = b.chain
        messagesSeen = 0
        auxRequestsSeen = 0
        validationRejections = 0
        log(`== control: chain set to '${chain}', counters reset ==`)
      }
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ chain, messagesSeen, auxRequestsSeen, validationRejections }))
      return
    }

    if (pathname.endsWith("/count_tokens")) {
      // Drain body so the stream can close cleanly, then reply.
      await readBody(stream)
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ input_tokens: 12 }))
      return
    }

    if (method === "GET" && pathname.includes("/models")) {
      log(`GET ${pathname} → models catalogue`)
      modelsResponse(stream)
      return
    }

    if (!pathname.endsWith("/messages")) {
      await readBody(stream)
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ ok: true, note: "mock GHC upstream" }))
      return
    }

    // ── POST /v1/messages ─────────────────────────────────────────────────────────────────
    const raw = await readBody(stream)
    let body: InboundBody = {}
    try { body = JSON.parse(raw) as InboundBody } catch { /* treat as empty */ }
    const targetModel = typeof body.model === "string" ? body.model : "(none)"

    // Auxiliary/small-fast-model traffic (CC title/topic/quota "haiku") must NOT touch the
    // chain counters/validation — otherwise it shifts retry-attempt dispatch (messagesSeen) or
    // thinking turn detection. Distinguish by `body.model`: only the MAIN model is under test.
    if (targetModel !== MODEL) {
      auxRequestsSeen++
      log(`POST ${pathname} AUX model=${targetModel} (ignored for chain counters; auxRequestsSeen=${auxRequestsSeen})`)
      auxResponse(stream, Boolean(body.stream))
      return
    }

    messagesSeen++
    const nMsgs = body.messages?.length ?? 0
    const hasAssistantThinking = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "thinking"),
    )
    log(`POST ${pathname} chain=${chain} model=${targetModel} req#${messagesSeen} messages=${nMsgs} assistantThinking=${hasAssistantThinking}`)

    // Validate the thinking-first invariant on EVERY inbound (real Anthropic would 400 otherwise).
    const violation = thinkingFirstViolation(body)
    if (violation) {
      validationRejections++
      log(`<- 400 thinking-first VIOLATION: ${violation}  (proxy did NOT strip the empty-text anchor)`)
      stream.respond({ ":status": 400, "content-type": "application/json" })
      stream.end(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `messages: ${violation}. Expected 'thinking' or 'redacted_thinking', but found leading block.` } }),
      )
      return
    }

    // All chains stream Anthropic SSE.
    stream.respond(SSE_HEADERS)
    if (chain === "keepalive") { await keepaliveBody(stream); return }
    if (chain === "thinking") {
      // Turn 1 = the request WITHOUT any assistant thinking; later turns are clean answers.
      const isFirstTurn = !hasAssistantThinking
      if (isFirstTurn) await thinkingTurn1Body(stream)
      else thinkingTurn2Body(stream)
      return
    }
    // retry chain
    if (messagesSeen === 1) await retryAttempt1Body(stream)
    else retryAttempt2Body(stream)
  })().catch((e: unknown) => {
    log(`-> handler error ${String(e)} ${rel()}`)
    if (!streamDead(stream)) {
      try { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR) } catch { /* best effort */ }
    }
  })
})

server.on("error", (err) => log(`(server error) ${String(err)}`))

server.listen(PORT, () => {
  log(`listening on https://localhost:${PORT} (h2, node:http2 secure server)  (chain=${chain} model=${MODEL} aux=${AUX_MODEL} silence=${SILENCE_SEC}s anchorSilence=${ANCHOR_SILENCE_SEC}s)`)
  log(`point the proxy's ghc_api_base_url at https://localhost:${PORT} (proxy needs to trust mock-cert.pem — see start-proxy.sh); select a chain via POST /__mode {"chain":"keepalive|thinking|retry"}`)
})
