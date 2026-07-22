/**
 * Anthropic continuation-request builder (spec 2026-07-22 §4.1/§4.3, ADR D3). On a mid-stream cut
 * AFTER the first block committed, the driver reconstructs the upstream request so the model continues
 * from the already-delivered prefix rather than restarting. The upstream rejects assistant PREFILL
 * ("must end with a user message"), so the committed prefix is carried as a full assistant turn and the
 * synthetic continuation instruction as a trailing user turn (PoC-verified, haiku + opus-4.8):
 *
 *   [original request body, unchanged (cache-friendly)]
 *   + { role: assistant, content: [committed blocks] }
 *   + { role: user, content: <configured continuation message> }
 *
 * The committed blocks come from the ledger snapshot, which the extractor already narrowed to the
 * replayable {@link CanonicalBlock} union (text / tool_use) — `thinking` is excluded (upstream rejects
 * it as a prefix + signature poisoning risk, ADR D3), as are `server_tool_use` / server-tool-result.
 *
 * ADR D3 gate: continuation must NOT fire when the committed prefix already contains a COMPLETE,
 * client-interactive `tool_use` block — that is a legitimate turn boundary (the client runs the tool
 * and drives the next turn). {@link hasCompleteInteractiveToolUse} is that predicate; the driver checks
 * it before invoking the builder.
 */

import type { CanonicalBlock } from "~/lib/pipeline/committed-blocks-ledger"
import type {
  //
  ContentBlockParam,
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { registerContinuationBuilder } from "~/lib/pipeline/continuation-request-builder"

/** Project a committed canonical block to an Anthropic request content block (assistant-turn carrier). */
function toContentBlockParam(block: CanonicalBlock): ContentBlockParam {
  if (block.type === "text") return { type: "text", text: block.text }
  return { type: "tool_use", id: block.id, name: block.name, input: block.input }
}

/**
 * ADR D3: does the committed prefix contain a COMPLETE, client-interactive tool_use block? The ledger
 * only holds `text` / `tool_use` (the extractor drops `server_tool_use` and other non-interactive /
 * non-replayable blocks), so any `tool_use` here is one the client must execute → a turn boundary.
 */
export function hasCompleteInteractiveToolUse(committed: ReadonlyArray<CanonicalBlock>): boolean {
  return committed.some((b) => b.type === "tool_use")
}

/**
 * Build the Anthropic continuation upstream request. `original` is the original client MessagesPayload
 * (unchanged — cache-friendly); `committed` is the ledger snapshot; `message` is the synthetic user-turn
 * text. Streaming stays on (the continuation is streamed back onto the same client connection).
 */
export function buildAnthropicContinuationRequest(original: unknown, committed: ReadonlyArray<CanonicalBlock>, message: string): MessagesPayload {
  const base = original as MessagesPayload
  const assistantTurn: MessageParam = { role: "assistant", content: committed.map((b) => toContentBlockParam(b)) }
  const userTurn: MessageParam = { role: "user", content: message }
  return { ...base, messages: [...base.messages, assistantTurn, userTurn], stream: true }
}

/** Register the Anthropic builder into the per-format continuation registry (idempotent module side-effect). */
export function registerAnthropicContinuationBuilder(): void {
  registerContinuationBuilder("anthropic", (original, committed, message) => buildAnthropicContinuationRequest(original, committed, message))
}
