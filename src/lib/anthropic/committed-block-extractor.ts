/**
 * Reconstruct the canonical (client-native) form of the content blocks carried by a set of committed
 * Anthropic SSE frames, for the continuation-retry ledger (spec 2026-07-22 §4.2). The driver hands the
 * buffered frames of ONE block-level commit boundary to this extractor; it replays them through the
 * Anthropic stream accumulator (the same one history uses) and projects each COMPLETED block down to the
 * {@link CanonicalBlock} union the continuation-request-builder consumes.
 *
 * Only `text` and `tool_use` blocks are projected (the CanonicalBlock union, spec §4.2 — "text 块文本、
 * tool_use 完整 name+input"). `thinking` / `redacted_thinking` / `server_tool_use` / server-tool-result /
 * unknown blocks are intentionally DROPPED: they are not valid content for the synthetic assistant turn a
 * continuation replays to the upstream (you cannot re-assert a model's thinking as a prior assistant turn),
 * matching the ledger's declared block union. This is the fidelity trade-off the spec accepts (N4).
 *
 * The driver only calls this at a COMMIT boundary (a fully-flushed block), so a partial block cut
 * mid-generation is never handed here — it stays in the driver's buffer and is discarded on the RST.
 */

import type { CanonicalBlock } from "~/lib/pipeline/committed-blocks-ledger"
import type { ClientFrame } from "~/lib/pipeline/types"
import type { StreamEvent } from "~/types/api/anthropic"

import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./stream-accumulator"

/**
 * Project the committed Anthropic frames of a block-level commit boundary into canonical blocks. Frames
 * that are not JSON stream events (keepalive/ping/`[DONE]`) are skipped. A `tool_use` block's accumulated
 * `input` is a JSON string (the concatenated `input_json_delta`s); a fully-committed block parses cleanly,
 * an empty input (no deltas) canonicalizes to `{}`.
 */
export function extractAnthropicCommittedBlocks(frames: ReadonlyArray<ClientFrame>): Array<CanonicalBlock> {
  const acc = createAnthropicStreamAccumulator()
  for (const frame of frames) {
    if (typeof frame.data !== "string") continue
    let event: StreamEvent
    try {
      event = JSON.parse(frame.data) as StreamEvent
    } catch {
      continue // non-JSON (keepalive line / [DONE]) — not a stream event
    }
    accumulateAnthropicStreamEvent(event, acc)
  }
  const out: Array<CanonicalBlock> = []
  for (const block of acc.contentBlocks) {
    // Sparse array: `contentBlocks` is indexed by the upstream `index`, so a hole is possible if a
    // boundary's frames start above index 0. Skip holes.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: sparse array from untrusted SSE indices
    if (!block) continue
    // Server-tool-result / unknown-generic blocks (branded `type: string`) are not replayable content →
    // dropped. Excluding them here also narrows `block` to the literal-typed variants for the switch below.
    if ("_brand" in block || "_generic" in block) continue
    if (block.type === "text") {
      out.push({ type: "text", text: block.text })
    } else if (block.type === "tool_use") {
      out.push({ type: "tool_use", id: block.id, name: block.name, input: parseToolInput(block.input) })
    }
    // thinking / redacted_thinking / server_tool_use → dropped (see docstring).
  }
  return out
}

/** Parse an accumulated tool_use input JSON string; empty → `{}`; malformed (should not happen for a
 *  committed block) → keep the raw string so nothing is silently lost (richest-data-flow). */
function parseToolInput(input: string): unknown {
  if (input === "") return {}
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}
