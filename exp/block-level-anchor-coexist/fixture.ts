// Shared synthetic block sequence for the two-stage PoC gate (spec §4.5,
// 2026-07-11-block-level-buffered-retry). ONE fixture drives BOTH stages so the wire
// shape stage 1 proves the proxy PRODUCES is byte-identically the shape stage 2 asks a
// real client to ACCEPT.
//
// The shape under test = the block-level flush wire (spec §4.3 target):
//   message_start
//   → content_block_start@0  (empty-text ANCHOR — opens, stays open the WHOLE stream)
//   → content_block_delta@0  (anchor's own first empty text_delta — a keepalive)
//   → content_block_start@1 … delta@1 … content_block_stop@1   (real block #1, e.g. tool_use)
//   → «INTER-BLOCK IDLE»     (anchor@0 still open, block@1 closed → heartbeat rides anchor@0)
//   → content_block_start@2 … delta@2 … content_block_stop@2   (real block #2, e.g. text)
//   → content_block_stop@0   (close the anchor — ONLY at terminal)
//   → message_delta → message_stop
//
// The load-bearing property = "TWO blocks open at once" (anchor@0 open WHILE real block@1/@2
// open) + "inter-block gap carries content_block_delta@0 text_delta, NOT a bare ping".

import type { ClientFrame } from "~/lib/pipeline/types"

/** Build an Anthropic SSE ClientFrame (event line + JSON data) from a parsed event object. */
function frame(event: string, data: Record<string, unknown>): ClientFrame {
  return { event, data: JSON.stringify(data) }
}

/**
 * One scripted step. `role` tells stage 1 WHICH sink method to drive it through (the anchor
 * structural frames go through `writeAnchor` so `noteBlockState` pushes/pops the block stack;
 * the anchor's own empty delta is a `writeKeepalive`; real frames go through `write`). `gapAfter`
 * marks the inter-block idle window (stage 1 waits for a heartbeat tick there; stage 2 inserts a
 * silence + server-side keepalive there).
 */
export interface Step {
  role: "message_start" | "anchor_struct" | "anchor_keepalive" | "real" | "terminal"
  frame: ClientFrame
  /** True on the LAST real-block-stop before the second real block — the inter-block idle window. */
  gapAfter?: boolean
}

const MODEL = "claude-opus-4.8"
const MSG_ID = "msg_synthetic_poc_484"

/** The full scripted sequence (both real blocks + anchor coexistence + inter-block gap). */
export const STEPS: Array<Step> = [
  { role: "message_start", frame: frame("message_start", {
    type: "message_start",
    message: { id: MSG_ID, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  }) },

  // ── ANCHOR @0 (empty text) — opens and STAYS open for the whole stream ──────────────
  { role: "anchor_struct", frame: frame("content_block_start", {
    type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
  }) },
  { role: "anchor_keepalive", frame: frame("content_block_delta", {
    type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" },
  }) },

  // ── REAL BLOCK #1 @1 (tool_use — the req_484 Write call shape) ───────────────────────
  { role: "real", frame: frame("content_block_start", {
    type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "Write", input: {} },
  }) },
  { role: "real", frame: frame("content_block_delta", {
    type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" },
  }) },
  // gapAfter: block@1 just closed; anchor@0 is the ONLY open block → the idle tick must ride it.
  { role: "real", gapAfter: true, frame: frame("content_block_stop", { type: "content_block_stop", index: 1 }) },

  // ── REAL BLOCK #2 @2 (text) — arrives AFTER the inter-block idle ─────────────────────
  { role: "real", frame: frame("content_block_start", {
    type: "content_block_start", index: 2, content_block: { type: "text", text: "" },
  }) },
  { role: "real", frame: frame("content_block_delta", {
    type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" },
  }) },
  { role: "real", frame: frame("content_block_stop", { type: "content_block_stop", index: 2 }) },

  // ── TERMINAL: close the anchor@0, then message_delta/message_stop ────────────────────
  { role: "anchor_struct", frame: frame("content_block_stop", { type: "content_block_stop", index: 0 }) },
  { role: "terminal", frame: frame("message_delta", {
    type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 },
  }) },
  { role: "terminal", frame: frame("message_stop", { type: "message_stop" }) },
]

/** Serialize a ClientFrame to raw Anthropic SSE bytes (`event:` line + `data:` line + blank line). */
export function toSseBytes(f: ClientFrame): string {
  return `event: ${f.event}\ndata: ${f.data}\n\n`
}
