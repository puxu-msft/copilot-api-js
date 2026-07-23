/**
 * PoC P-A (plan-2b §7): does the REAL @anthropic-ai/sdk accept a STITCHED continuation stream?
 *
 * The continuation executor will produce ONE client stream that splices two upstream exchanges:
 *   - attempt 1 delivered blocks (here: thinking@0 + text@1), committed to the client;
 *   - then WITHOUT a message_stop, the continuation exchange's blocks, RE-INDEXED by the count of
 *     already-delivered wire blocks (here +2), and its duplicate message_start dropped;
 *   - then the final message_delta + message_stop.
 *
 * Load-bearing question C3: the re-index offset must be the WIRE-DELIVERED block count (2 here:
 * thinking@0 + text@1), NOT the ledger length (1 here — the ledger excludes thinking). This PoC includes
 * a thinking block precisely so the two counts differ, and runs BOTH:
 *   - GOOD: continuation block at index 2 (wire count) → expect clean finalMessage of 3 blocks.
 *   - BROKEN: continuation block at index 1 (ledger length) → positive control; observe how the SDK reacts
 *     to a re-opened/colliding index (proves the bug is real, not hypothetical).
 *
 * Run: bun run exp/continuation-stitch/poc.ts
 */

import Anthropic from "@anthropic-ai/sdk"

type Frame = { event: string; data: Record<string, unknown> }

const messageStart: Frame = {
  event: "message_start",
  data: {
    type: "message_start",
    message: { id: "msg_poc", type: "message", role: "assistant", model: "claude-opus-4", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } },
  },
}

function block(index: number, kind: "thinking" | "text", text: string): Array<Frame> {
  if (kind === "thinking") {
    return [
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig_poc_abc" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    ]
  }
  return [
    { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ]
}

const tail: Array<Frame> = [
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]

/** Stitched stream: delivered [thinking@0, text@1] + continuation block at `contIndex` + tail. Single message_start, single message_stop. */
function stitched(contIndex: number): Array<Frame> {
  return [
    messageStart,
    ...block(0, "thinking", "Let me reason about this."),
    ...block(1, "text", "Partial answer before the cut. "),
    // continuation exchange's block 0, re-indexed to contIndex; its own message_start was dropped.
    ...block(contIndex, "text", "Continued answer after stitching."),
    ...tail,
  ]
}

function toSse(frames: Array<Frame>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("")
}

async function runCase(label: string, contIndex: number): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(toSse(stitched(contIndex)), {
        headers: { "content-type": "text/event-stream", "anthropic-version": "2023-06-01" },
      }),
  })
  const client = new Anthropic({ baseURL: `http://localhost:${server.port}`, apiKey: "poc", maxRetries: 0 })
  try {
    const stream = client.messages.stream({ model: "claude-opus-4", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    const final = await stream.finalMessage()
    const shape = final.content.map((b) => (b.type === "text" ? `text:${JSON.stringify(b.text)}` : b.type === "thinking" ? `thinking:${JSON.stringify(b.thinking)}(sig=${(b as { signature?: string }).signature ?? "none"})` : b.type))
    console.log(`\n[${label}] contIndex=${contIndex} → NO THROW`)
    console.log(`  blocks(${final.content.length}):`)
    for (const s of shape) console.log(`    - ${s}`)
    console.log(`  stop_reason=${final.stop_reason}`)
  } catch (error) {
    console.log(`\n[${label}] contIndex=${contIndex} → THREW: ${(error as Error).constructor.name}: ${(error as Error).message}`)
  } finally {
    server.stop(true)
  }
}

console.log("PoC P-A: @anthropic-ai/sdk stitched continuation stream (with thinking block → wire count 2 ≠ ledger 1)")
await runCase("GOOD (offset = wire delivered count = 2)", 2)
await runCase("BROKEN (offset = ledger length = 1 → collides text@1)", 1)
console.log("\n(done)")
