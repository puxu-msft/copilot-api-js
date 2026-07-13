// STAGE 2 — client-acceptance probe (spec §4.5, second stage; MUST BE RUN BY THE USER, no-auto-server).
//
// Stage 1 proved the PROXY produces the block-level wire shape. Stage 2 asks: does a REAL client
// ACCEPT it? Two unverified protocol assumptions ride on this:
//   ① TWO content blocks open at once — anchor@0 open the whole stream WHILE real block@1/@2 flush
//      at index+1 — is parsed WITHOUT a decoder error / dropped frame.
//   ② A long inter-block silence (simulating >300s) filled ONLY with content_block_delta@0 text_delta
//      keepalives does NOT trip Claude Code's 300s no-real-content idle deadline (a bare ping WOULD;
//      exp/cc-idle-280s/REPORT.md — the text_delta@0 must reset it).
//
// This script does TWO things depending on args:
//
//   (default)  Self-contained AUTOMATED check of ①: starts a local SSE server replaying the exact
//              fixture (anchor@0 open + real@1/@2 coexisting + inter-block text_delta@0 + terminal
//              close@0) and consumes it through the REAL @anthropic-ai/sdk — both the raw SSEDecoder
//              (Stream.fromSSEResponse) AND the MessageStream accumulator (client.messages.stream).
//              Asserts: no decoder throw, every frame decoded (count matches), two-block coexistence
//              accepted, final Message assembled. Prints PASS/FAIL. A SHORT idle (--long-idle default
//              2s) exercises the gap quickly.
//
//   --serve    Runs ONLY the server, long-lived, and prints instructions to point REAL Claude Code
//              at it (ANTHROPIC_BASE_URL). This is the ONLY way to verify ② — the SDK has NO 300s
//              clock (that deadline is Claude Code CLI behavior). Combine with --long-idle=310 to make
//              the inter-block silence exceed 300s (keepalive text_delta@0 every 15s throughout).
//
// Run (user):
//   bun run exp/block-level-anchor-coexist/probe.ts                 # automated ① check
//   bun run exp/block-level-anchor-coexist/probe.ts --long-idle=310 --serve   # ② real-CC deadline test
//
// Criteria: ① SDK decodes + accumulates with NO error and NO dropped frame. ② real Claude Code stays
// connected across the >300s inter-block silence (no "no-real-content" disconnect).

import Anthropic from "@anthropic-ai/sdk"
import { Stream } from "@anthropic-ai/sdk/core/streaming"

import { makeAnthropicKeepaliveFrame } from "~/lib/anthropic/keepalive-frame"

import { STEPS, toSseBytes } from "./fixture"

// ── args ────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const serveOnly = args.includes("--serve")
const longIdleArg = args.find((a) => a.startsWith("--long-idle="))
const idleSec = longIdleArg ? Number(longIdleArg.split("=")[1]) : 2
const idleMs = idleSec * 1000
const KEEPALIVE_MS = 15_000 // matches the production forced-heartbeat cadence
const PORT = Number(process.env.PROBE_PORT ?? 8791)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The inter-block-gap keepalive the server injects during the idle. DERIVED from the SAME production
// builder the sink uses (makeAnthropicKeepaliveFrame with the anchor's open block = text@0) and
// serialized with the SAME toSseBytes as every fixture frame — so if the empty_text keepalive shape
// ever changes, stage 2's replay changes with it and stage 1's wire oracle catches the drift. This
// is the SINGLE source of the gap frame: production emits it (stage 1 verifies), we replay it here.
const GAP_KEEPALIVE = toSseBytes(makeAnthropicKeepaliveFrame({ index: 0, type: "text" }))

/** Stream the fixture as SSE bytes, inserting the idle + keepalives at the marked inter-block gap. */
function fixtureStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const step of STEPS) {
          controller.enqueue(enc.encode(toSseBytes(step.frame)))
          if (step.gapAfter) {
            // INTER-BLOCK IDLE: block@1 closed, anchor@0 still open. Fill the silence with
            // text_delta@0 keepalives every KEEPALIVE_MS, exactly as the production sink would.
            const deadline = Date.now() + idleMs
            while (Date.now() < deadline) {
              await sleep(Math.min(KEEPALIVE_MS, deadline - Date.now()))
              if (Date.now() < deadline || idleMs >= KEEPALIVE_MS) controller.enqueue(enc.encode(GAP_KEEPALIVE))
            }
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

function startServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: PORT,
    idleTimeout: 0, // never time out the socket — we deliberately hold long inter-block silences
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/v1/messages") && req.method === "POST") {
        return new Response(fixtureStream(), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
}

// ── --serve mode: long-lived server for the REAL Claude Code 300s deadline test (②) ────
if (serveOnly) {
  const server = startServer()
  const base = `http://127.0.0.1:${server.port}`
  console.log("── STAGE 2 probe — SERVE mode (for the REAL Claude Code 300s deadline test, criterion ②) ──")
  console.log(`  Server up: ${base}   (inter-block idle = ${idleSec}s, text_delta@0 keepalive every ${KEEPALIVE_MS / 1000}s)`)
  console.log("")
  console.log("  Point a REAL Claude Code CLI at this server and send ANY message:")
  console.log(`    ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=x claude   # then send a prompt`)
  console.log("")
  console.log(`  PASS ② iff Claude Code stays connected across the ${idleSec}s inter-block silence`)
  console.log("  (no 'no-real-content'/idle disconnect) AND renders both real blocks. Use --long-idle=310")
  console.log("  to push the silence past the 300s deadline. Ctrl-C to stop.")
  // hold open
} else {
  // ── default mode: AUTOMATED SDK decode + accumulate check (criterion ①) ──────────────
  const server = startServer()
  const base = `http://127.0.0.1:${server.port}`
  const problems: Array<string> = []
  let rawEventCount = 0
  let sawCoexistence = false

  try {
    // ── Path A: RAW SSEDecoder (Stream.fromSSEResponse) — the literal "@anthropic-ai/sdk SSEDecoder". ──
    // NOTE: `sawCoexistence` below is PROBE-COMPUTED (we track openIndices ourselves), NOT judged by the
    // SDK — Stream.fromSSEResponse only JSON-decodes each frame and has NO content-block state machine, so
    // it PASSES any well-formed JSON SSE and CANNOT structurally FAIL on coexistence. Path A proves only
    // "the fixture is well-formed SSE"; the load-bearing acceptance check is Path B (the accumulator).
    const resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const raw = Stream.fromSSEResponse<{ type?: string; index?: number }>(resp, new AbortController())
    const openIndices = new Set<number>()
    for await (const ev of raw) {
      rawEventCount++
      if (ev.type === "content_block_start" && typeof ev.index === "number") {
        openIndices.add(ev.index)
        if (openIndices.has(0) && openIndices.size >= 2) sawCoexistence = true // anchor@0 + a real block open together
      } else if (ev.type === "content_block_stop" && typeof ev.index === "number") {
        openIndices.delete(ev.index)
      }
    }
    // Expected decoded events = every fixture frame + keepalives injected during the idle.
    if (rawEventCount < STEPS.length) problems.push(`raw SSEDecoder decoded ${rawEventCount} events, expected ≥ ${STEPS.length} (dropped frames?)`)
    if (!sawCoexistence) problems.push("raw SSEDecoder never observed anchor@0 open together with a real block (coexistence not parsed)")

    // ── Path B: MessageStream accumulator (client.messages.stream) — Claude Code's own consumption path. ──
    const client = new Anthropic({ apiKey: "x", baseURL: base })
    const ms = client.messages.stream({ model: "claude-opus-4.8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    let accumEvents = 0
    for await (const _ev of ms) accumEvents++
    const final = await ms.finalMessage()
    if (accumEvents < STEPS.length) problems.push(`MessageStream accumulator saw ${accumEvents} events, expected ≥ ${STEPS.length}`)
    if (!final.content || final.content.length === 0) problems.push("MessageStream produced an EMPTY final message (accumulator rejected the shape)")
    console.log("── STAGE 2 probe — AUTOMATED SDK check (criterion ①) ──")
    console.log(`  raw SSEDecoder events:        ${rawEventCount}`)
    console.log(`  two-block coexistence (probe-computed, not SDK-judged): ${sawCoexistence}`)
    console.log(`  accumulator events:           ${accumEvents}`)
    console.log(`  final message content blocks: ${final.content?.length ?? 0} (${(final.content ?? []).map((b) => b.type).join(", ")})`)
    console.log("")
  } catch (err) {
    problems.push(`SDK threw while consuming the stream: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
  } finally {
    server.stop(true)
  }

  if (problems.length === 0) {
    console.log("STAGE 2 (①): PASS — @anthropic-ai/sdk decoded + accumulated the two-block-coexist shape with no error/drop.")
    console.log("  SCOPE: this proves the SDK ACCUMULATOR tolerates the shape — it does NOT prove the Claude Code")
    console.log("  CLI renderer accepts it (CC is an independent consumer with a possibly stricter SSE state machine),")
    console.log("  and the accumulator is index-indifferent. ① is NECESSARY-NOT-SUFFICIENT: it cannot replace ②.")
    console.log("  NOTE: criterion ② (300s deadline) is NOT covered here — the SDK has no 300s clock. Run with")
    console.log("  `--serve --long-idle=310` and a REAL Claude Code CLI to verify ② (see README).")
    process.exit(0)
  } else {
    console.log("STAGE 2 (①): FAIL")
    for (const p of problems) console.log(`  - ${p}`)
    console.log("\n  → client REJECTS two-block coexistence → Task 6 takes the FALLBACK (close@0 before each flush,")
    console.log("    reopen anchor@0 after). See README '三分支后续'.")
    process.exit(1)
  }
}
