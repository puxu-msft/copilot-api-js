// STAGE 1 — proxy-producibility wire oracle (spec §4.5, first stage; runnable/CI-able, RUN BY THE AGENT).
//
// Proves the LANDED block-stack sink (client-sink.ts, commit 6a4ae0ea) actually PRODUCES the
// block-level flush wire shape: an empty-text anchor@0 that stays open the whole stream while
// real blocks flush at @+1, and — critically — an INTER-BLOCK idle that carries a
// `content_block_delta@0 text_delta` (real content that resets Claude Code's 300s deadline),
// NOT a bare `{"type":"ping"}` (which does NOT reset it — exp/cc-idle-280s/REPORT.md).
//
// This is the C1 regression oracle: before the block-stack fix, `noteBlockState` was a single
// slot that the real block@1 start OVERWROTE and its stop CLEARED → the inter-block tick saw
// `openBlock===undefined` → bare ping → 300s disconnect. With the stack, anchor@0 stays at the
// bottom → the inter-block tick rides it → text_delta@0.
//
// Independent oracle: we capture the WIRE via a fake SSEStreamingApi (the bytes the sink hands the
// transport) — separate from the sink's own forwarded sampler — and assert the frame shape.
//
// Run: bun run exp/block-level-anchor-coexist/oracle-wire.ts

import type { SSEStreamingApi } from "hono/streaming"

import { resolveAnthropicKeepalive } from "~/lib/anthropic/keepalive-frame"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import type { ClientFrame } from "~/lib/pipeline/types"

import { STEPS } from "./fixture"

// ── independent wire capture: everything the sink writes to the transport ──────────────
interface WireFrame { event?: string; data?: string }
const wire: Array<WireFrame> = []
const fakeStream = {
  writeSSE: (m: { event?: string; data?: string }): Promise<void> => {
    wire.push({ event: m.event, data: m.data })
    return Promise.resolve()
  },
} as unknown as SSEStreamingApi

const HEARTBEAT_SEC = 0.04 // 40ms — small so the inter-block idle tick fires within a short sleep
const GAP_SLEEP_MS = 200 // > interval; long enough for ≥1 tick to fire during the inter-block idle

const sink = makeSseSink(fakeStream, {
  heartbeat: {
    intervalSec: HEARTBEAT_SEC,
    // empty_text provider → block-aware empty delta chosen from the current open block (the STACK top).
    pingFrame: resolveAnthropicKeepalive("empty_text"),
    // NOTE: no injectAnchor — this oracle opens the anchor MANUALLY via writeAnchor, so the stack is
    // never empty during the gap and the tick goes straight to the block-aware provider (the exact
    // path the block-stack C1 fix exercises).
  },
})

// The SSE sink (heartbeat ON) always returns these optional ClientSink methods. Guard FIRST so the
// subsequent const assignments infer the NON-optional type (a nested closure doesn't inherit outer
// control-flow narrowing, so we capture the narrowed value into consts here).
if (!sink.writeAnchor || !sink.writeKeepalive || !sink.close) throw new Error("makeSseSink did not return anchor/keepalive/close methods")
const writeAnchor = sink.writeAnchor
const writeKeepalive = sink.writeKeepalive
const closeSink = sink.close

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Parse a captured wire frame's JSON data. */
function parse(f: WireFrame): { type?: string; index?: number; delta?: { type?: string } } {
  try {
    return JSON.parse(f.data ?? "{}") as { type?: string; index?: number; delta?: { type?: string } }
  } catch {
    return {}
  }
}

async function run(): Promise<void> {
  let gapStartIndex = -1
  let gapEndIndex = -1

  for (const step of STEPS) {
    const f: ClientFrame = step.frame
    switch (step.role) {
      case "anchor_struct": {
        await writeAnchor(f) // structural anchor frame → noteBlockState pushes/pops the stack
        break
      }
      case "anchor_keepalive": {
        await writeKeepalive(f) // the anchor's own empty delta (a heartbeat, not structure)
        break
      }
      default: {
        await sink.write(f) // message_start / real blocks / terminal
      }
    }

    if (step.gapAfter) {
      // INTER-BLOCK IDLE: block@1 just closed, anchor@0 still open. Let the heartbeat tick fire.
      gapStartIndex = wire.length
      await sleep(GAP_SLEEP_MS)
      gapEndIndex = wire.length
    }
  }

  closeSink()

  // ── assertions ──────────────────────────────────────────────────────────────────────
  const problems: Array<string> = []

  // (A) TWO blocks coexist open: content_block_start@0 (anchor) precedes content_block_start@1
  //     with NO content_block_stop@0 between them.
  const startIdx0 = wire.findIndex((f) => { const p = parse(f); return p.type === "content_block_start" && p.index === 0 })
  const startIdx1 = wire.findIndex((f) => { const p = parse(f); return p.type === "content_block_start" && p.index === 1 })
  const stopIdx0First = wire.findIndex((f) => { const p = parse(f); return p.type === "content_block_stop" && p.index === 0 })
  if (startIdx0 < 0 || startIdx1 < 0) problems.push("missing content_block_start@0 or @1 on the wire")
  else if (!(startIdx0 < startIdx1)) problems.push("anchor@0 did not open before real block@1")
  else if (stopIdx0First >= 0 && stopIdx0First < startIdx1) problems.push("anchor@0 was closed BEFORE real block@1 opened (no coexistence)")

  // (B) INTER-BLOCK GAP carries content_block_delta@0 text_delta, and NO bare ping.
  const gapFrames = wire.slice(gapStartIndex, gapEndIndex)
  const gapDeltas = gapFrames.map(parse)
  const hasTextDelta0 = gapDeltas.some((p) => p.type === "content_block_delta" && p.index === 0 && p.delta?.type === "text_delta")
  const hasBarePing = gapDeltas.some((p) => p.type === "ping")
  if (gapFrames.length === 0) problems.push("no heartbeat frame emitted during the inter-block idle (tick never fired)")
  if (!hasTextDelta0) problems.push(`inter-block gap did NOT carry content_block_delta@0 text_delta (got: ${JSON.stringify(gapDeltas)})`)
  if (hasBarePing) problems.push("inter-block gap carried a BARE ping (C1 regression — block stack not riding anchor@0)")

  // (C) anchor@0 closes EXACTLY ONCE, and only AFTER real block@2 closes (terminal-only close).
  const stops0 = wire.map(parse).filter((p) => p.type === "content_block_stop" && p.index === 0).length
  const stopIdx2 = wire.findIndex((f) => { const p = parse(f); return p.type === "content_block_stop" && p.index === 2 })
  if (stops0 !== 1) problems.push(`anchor@0 closed ${stops0} times (expected exactly 1, terminal-only)`)
  if (stopIdx0First >= 0 && stopIdx2 >= 0 && !(stopIdx0First > stopIdx2)) problems.push("anchor@0 closed before real block@2 (not terminal-only)")

  // ── report ──────────────────────────────────────────────────────────────────────────
  console.log("── STAGE 1 wire oracle — captured frames ──")
  for (const [i, f] of wire.entries()) {
    const p = parse(f)
    const tag = i >= gapStartIndex && i < gapEndIndex ? "  «GAP»" : ""
    console.log(`  [${String(i).padStart(2)}] ${p.type}${p.index !== undefined ? `@${p.index}` : ""}${p.delta?.type ? ` (${p.delta.type})` : ""}${tag}`)
  }
  console.log("")
  console.log(`  inter-block gap frames: ${gapFrames.length}`)
  console.log(`  gap carries text_delta@0: ${hasTextDelta0}`)
  console.log(`  gap carries bare ping:    ${hasBarePing}`)
  console.log("")

  if (problems.length === 0) {
    console.log("STAGE 1: PASS — proxy PRODUCES anchor@0-open + real@+1 coexistence + inter-block text_delta@0 (no bare ping).")
    process.exit(0)
  } else {
    console.log("STAGE 1: FAIL")
    for (const p of problems) console.log(`  - ${p}`)
    console.log("\n  → block-stack change (Task 2, commit 6a4ae0ea) not effective — revisit before Task 6.")
    process.exit(1)
  }
}

void run()
