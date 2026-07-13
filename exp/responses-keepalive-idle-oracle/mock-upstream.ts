// Mock GHC (Copilot) UPSTREAM for the Responses `response.ping` keepalive M-2 idle oracle
// (Task 5 / plan-2-responses-http.md §Task 5 / spec §7.2 & §11 M-2).
//
// TOPOLOGY:  real Codex CLI (`codex exec`)  ──▶  copilot-api PROXY (buffered ON)  ──ghc_api_base_url──▶  THIS mock.
//   Mirrors exp/cc-idle-280s/mock-upstream.ts (§7 LIVE topology): the mock sits UPSTREAM of the
//   proxy so what's under test is the PROXY's forced `responsesKeepaliveFrame()` heartbeat during
//   the pre-first-item buffered window, NOT whether the mock itself emits a friendly frame type.
//
// WHY THIS MATTERS EVEN THOUGH THE KEEPALIVE FRAME DIDN'T CHANGE (see task brief): block-level
// buffered retry (this feature) only changes WHEN real frames flush to the client (at each
// `output_item.done` boundary instead of only at the terminal). The window BEFORE the first
// output_item ever starts is still fully buffered — during that window the proxy's forced
// buffered-mode heartbeat (`resolveResponsesBufferedAndHeartbeat`, buffered-config.ts) is the ONLY
// thing keeping a real Codex/OpenAI-Responses consumer's 300s no-real-content idle deadline from
// firing. `keepalive.ts`'s docstring reasons from codex-rs source that `response.ping` resets it
// (every SSE event refreshes codex-rs's `timeout(idle_timeout, stream.next())`), but that is a
// documentation inference, not an empirical measurement (empirical-verification: measured >
// doc-inferred). This harness is the independent oracle.
//
// ── TRANSPORT: node:http2 secure server (HTTPS/h2), NOT Bun.serve HTTP/1.1 ────────────────────
// EMPIRICALLY CONFIRMED (this task, 2026-07-12): a plaintext `http://` Bun.serve mock makes the
// proxy's own upstream fetch (`transport/upstream-fetch.ts`) route through undici (real https
// GHC upstreams instead go through node:http2 — see upstream-fetch.ts:66-69 + docs/DESIGN.md
// "运行时兼容" table + skill `bun-node-runtime-gotchas`). Ran the real proxy (Bun) against an
// earlier http:// version of this mock with `silent:8`: the proxy's upstream fetch ABORTED ~5ms
// after receiving headers instead of surviving the silence window (see git history / task
// report for the raw log) — the exact Bun-undici defect the sibling harness
// `exp/buffered-anchor-oracle/README.md` "传输" section documents for the Anthropic path. This
// mock is therefore HTTPS/h2 (self-signed localhost cert, `node:http2.createSecureServer`), so
// the proxy's `ghc_api_base_url: https://...` routes through its PRODUCTION node:http2 client
// (which works fine under Bun) — the whole chain then runs on Bun, the real runtime, faithfully.
//
// The mock server itself runs under NODE (not Bun) for the same reason as the sibling harness:
// Node 22.6+/24 runs this `.ts` directly via type-stripping, no build step needed. (Unlike the
// sibling's `retry` chain, this harness never needs a real h2 RST — the keepalive oracle only
// needs a clean multi-frame SSE stream with a mid-stream silence window — so running the mock
// under Node is not load-bearing for RST-fidelity here; it is kept for consistency with the
// sibling harness's start script conventions and because Bun's http2 CLIENT session pooling in
// upstream-fetch.ts is what's under test, not the mock's server-side RST behavior.)
//
// MOCK_UPSTREAM_MODE=silent:<SILENCE_SEC>
//   SILENCE_SEC  seconds of PURE post-`response.created` silence (no `response.output_item.*`,
//                no `response.completed`) before the mock sends the clean two-output-item tail.
//                Must exceed the consumer's ~300s no-real-content watchdog to prove survival.
//                Default 330 (>300s wall + margin). The proxy's own `timeouts.response_header` /
//                `timeouts.stream_idle` MUST be raised ABOVE this (oracle-config.yaml sets 900) or
//                the PROXY aborts the upstream fetch first — that would be a proxy-config false
//                negative, not evidence against the keepalive mechanism; see REPORT.md §排障.
//
// Response shape: sends response headers (200, text/event-stream) and the FIRST frame
// (`response.created`) immediately — real GHC upstreams behave this way (headers + created are
// fast; the silence is in reasoning/generation before the first output item). Then holds for
// SILENCE_SEC before flushing the two-output-item tail (item0 -> item1 -> response.completed),
// reusing the twoItemFrames() semantics from tests/responses/responses-buffered.it.test.ts (Task
// 2's fixture) so a clean multi-block completion is unambiguous.
//
// Also serves `/models` (from refs/AVAILABLE_MODELS.json, same convention as
// exp/cc-idle-280s/mock-upstream.ts — the proxy builds its model index from it) and a best-effort
// `/count_tokens` (the Responses path does not actually call this pre-flight — Anthropic's
// `/v1/messages/count_tokens` is the only real consumer — but it's served defensively in case a
// future consumer probes it, matching the sibling harness's belt-and-suspenders convention).
//
// Logs (monotonic ts) every request, the silence start/end, and any proxy-initiated abort so a
// failed arm can be diagnosed (proxy timeouts too low vs SILENCE_SEC, vs a genuine consumer
// idle-out).

import { readFileSync } from "node:fs"
import http2 from "node:http2"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8799)
const MODELS_PATH = new URL("../../refs/AVAILABLE_MODELS.json", import.meta.url).pathname
/** TLS material (self-signed localhost). Generated by run-proxy-arm.sh if absent. */
const CERT_PATH = process.env.MOCK_CERT ?? path.join(HERE, "mock-cert.pem")
const KEY_PATH = process.env.MOCK_KEY ?? path.join(HERE, "mock-key.pem")

const t0 = performance.now()
const rel = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`
const ts = () => `${((performance.now() - t0) / 1000).toFixed(3)}s ${new Date().toISOString()}`
const log = (...a: Array<unknown>) => console.error(`[mock-upstream ${ts()}]`, ...a)

const enc = new TextEncoder()
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const MODELS_BODY = readFileSync(MODELS_PATH, "utf8")

const RESPONSE_ID = "resp_keepalive_oracle"
const MODEL_ID = process.env.MOCK_MODEL_ID ?? "gpt-5.5"

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
    // already ended/closed — nothing to clean up.
  }
}

/** The immediate `response.created` frame — sent BEFORE the silence window. */
function createdFrame(): Uint8Array {
  return sse("response.created", {
    type: "response.created",
    sequence_number: 0,
    response: { id: RESPONSE_ID, object: "response", status: "in_progress", model: MODEL_ID, output: [] },
  })
}

/**
 * The clean two-output-item tail sent AFTER the silence window (mirrors `twoItemFrames()` in
 * tests/responses/responses-buffered.it.test.ts — Task 2's block-level fixture — minus the
 * `response.created` frame, which was already sent before the silence).
 */
function tailFrames(): Array<Uint8Array> {
  return [
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "msg_0", type: "message", role: "assistant", content: [] },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      delta: "BLOCK_ZERO",
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ZERO" }] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 1,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 5,
      output_index: 1,
      content_index: 0,
      delta: "BLOCK_ONE",
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 1,
      item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ONE" }] },
    }),
    sse("response.completed", {
      type: "response.completed",
      sequence_number: 7,
      // total_tokens is REQUIRED by the real Codex CLI's ResponseCompleted parser (empirically
      // discovered via this harness's own smoke test — omitting it makes codex-rs fail with
      // "missing field `total_tokens`" and reconnect, a false negative unrelated to keepalive).
      response: { id: RESPONSE_ID, object: "response", status: "completed", model: MODEL_ID, output: [], usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 } },
    }),
  ]
}

function resolveMode(headers: http2.IncomingHttpHeaders): string {
  const headerMode = headers["x-mock-mode"]
  return (typeof headerMode === "string" ? headerMode : undefined) ?? process.env.MOCK_UPSTREAM_MODE ?? "silent:330"
}

/** Read a full request body from an h2 stream (drained so the stream can respond cleanly). */
function readBody(stream: http2.ServerHttp2Stream): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = []
    stream.on("data", (c: Buffer) => chunks.push(c))
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    stream.once("error", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

async function silentThenTailBody(stream: http2.ServerHttp2Stream, silenceSec: number): Promise<void> {
  writeFrame(stream, createdFrame())
  log(`-> sending response.created, then PURE post-created silence for ${silenceSec}s ${rel()}`)

  const deadline = performance.now() + silenceSec * 1000
  while (performance.now() < deadline) {
    if (streamDead(stream)) {
      log(
        `<- proxy/upstream-fetch ABORTED at ${rel()} — the proxy's timeouts.response_header/stream_idle fired below ${silenceSec}s, or the consumer disconnected and the abort bridged through. Raise timeouts.response_header + timeouts.stream_idle ABOVE ${silenceSec}s in oracle-config.yaml.`,
      )
      return
    }
    await sleep(Math.min(1000, deadline - performance.now()))
  }
  if (streamDead(stream)) {
    log(`<- proxy/upstream-fetch ABORTED at end of silence window ${rel()}`)
    return
  }

  log(`-> silence window (${silenceSec}s) elapsed WITHOUT abort; sending two-output-item tail ${rel()}`)
  for (const f of tailFrames()) writeFrame(stream, f)
  endStream(stream)
  log(`-> tail sent, upstream stream closed ${rel()}`)
}

const SSE_HEADERS = { ":status": 200, "content-type": "text/event-stream" }

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
  stream.on("error", (err) => log(`(stream error absorbed) ${String(err)}`))

  const method = String(headers[":method"] ?? "GET")
  const rawPath = String(headers[":path"] ?? "/")
  const pathname = rawPath.split("?")[0]

  void (async (): Promise<void> => {
    // Model catalog — the proxy builds its model index from this (needs the model used by the
    // arm script, default gpt-5.5, with `/responses` support).
    if (method === "GET" && pathname.endsWith("/models")) {
      log(`GET ${pathname} → models catalogue`)
      stream.respond({ ":status": 200, "content-type": "application/json", etag: `"mock-upstream-${PORT}"` })
      stream.end(MODELS_BODY)
      return
    }
    // Best-effort — the Responses path does not actually call this (see file header), served
    // defensively only.
    if (pathname.endsWith("/count_tokens")) {
      await readBody(stream)
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ input_tokens: 12 }))
      return
    }
    if (!pathname.endsWith("/responses")) {
      await readBody(stream)
      stream.respond({ ":status": 200, "content-type": "application/json" })
      stream.end(JSON.stringify({ ok: true, note: "mock GHC upstream" }))
      return
    }

    // ── POST /responses ─────────────────────────────────────────────────────────────────
    const raw = await readBody(stream)
    const mode = resolveMode(headers)
    const [kind, silenceStr = "330"] = mode.split(":")
    log(`${method} ${pathname} mode=${mode} bodyBytes=${raw.length}`)

    if (kind !== "silent") {
      log(`-> unknown mode ${mode}; replying with a clean baseline stream (no silence)`)
      stream.respond(SSE_HEADERS)
      writeFrame(stream, createdFrame())
      for (const f of tailFrames()) writeFrame(stream, f)
      endStream(stream)
      return
    }

    stream.respond(SSE_HEADERS)
    await silentThenTailBody(stream, Number(silenceStr))
  })().catch((e: unknown) => {
    log(`-> handler error ${String(e)} ${rel()}`)
    if (!streamDead(stream)) {
      try {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
      } catch {
        // already closing — best effort only.
      }
    }
  })
})

server.on("error", (err) => log(`(server error) ${String(err)}`))

server.listen(PORT, () => {
  log(`listening on https://localhost:${PORT} (h2, node:http2 secure server)  (MOCK_UPSTREAM_MODE=${process.env.MOCK_UPSTREAM_MODE ?? "silent:330"})  model=${MODEL_ID}  models=${MODELS_PATH}`)
})
