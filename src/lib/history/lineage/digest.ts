/**
 * Lineage digest builder.
 *
 * Reads a finalized `HistoryEntry` and produces its `LineageDigest`
 * (or `null` if essential inputs are missing — caller treats null as
 * "no lineage row for this entry"). Pure function; no I/O.
 *
 * See `docs/rfc/request-lineage.md` §3 for the algorithm.
 */

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history/types"
import type { MessageParam } from "~/types/api/anthropic"

import { canonicalizeMessages } from "./canonicalize"
import {
  //
  computePostResponseHash,
  computeRootHash,
  computeTurnHashes,
} from "./hash"
import {
  //
  LINEAGE_SCHEMA_VERSION,
  type LineageDigest,
} from "./types"

/**
 * Convert a history-shape `MessageContent` to an Anthropic SDK `MessageParam`.
 *
 * `MessageContent.content` is `string | Array<any>` (the history layer
 * stores raw client payload; principle 7). The runtime shape matches
 * `MessageParam.content` for Anthropic traffic so we cast through `unknown`
 * to honor the SDK's strict union types.
 */
function toMessageParam(mc: MessageContent): MessageParam {
  return {
    role: mc.role,
    content: mc.content,
  } as unknown as MessageParam
}

/**
 * Extract every `tool_use.id` emitted in the assistant message. Recurses
 * one level into the top-level content array (Anthropic tool_use blocks
 * are never nested).
 */
function extractProducedToolUseIds(message: MessageContent | null | undefined): Array<string> {
  if (!message || typeof message.content === "string" || !Array.isArray(message.content)) return []
  const out: Array<string> = []
  for (const block of message.content as Array<{ type?: string; id?: unknown }>) {
    if (block.type === "tool_use" && typeof block.id === "string") {
      out.push(block.id)
    }
  }
  return out
}

/**
 * `backToolUseId` = first `tool_result.tool_use_id` in the LAST message of
 * the inbound request. The primary back-edge to the parent entry (covers
 * ~99% of Claude Code completed multi-msg traffic per RFC §2.3).
 */
function extractBackToolUseId(messages: ReadonlyArray<MessageContent>): string | null {
  const last = messages.at(-1)
  if (!last || typeof last.content === "string" || !Array.isArray(last.content)) return null
  for (const block of last.content as Array<{ type?: string; tool_use_id?: unknown }>) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      return block.tool_use_id
    }
  }
  return null
}

/**
 * Compute the lineage digest for a finalized entry.
 *
 * Returns `null` when essential inputs are missing (no messages, or
 * non-Anthropic endpoint in v1). Otherwise returns the full digest with
 * `postResponseHash` set when the entry produced an assistant response
 * and `null` when it did not (failed / interrupted / aborted entries
 * can be children but not parents).
 *
 * Throws nothing — caller need not wrap in try/catch unless feeding
 * adversarial input (we still defensively try/catch in the caller per
 * RFC §11 "compute outside the transaction, never throw into write").
 */
export function computeLineageDigest(entry: HistoryEntry): LineageDigest | null {
  // v1: Anthropic only. Other endpoints get no lineage row (see RFC §8.1).
  if (entry.endpoint !== "anthropic-messages") return null

  const messages = entry.inboundRequest.messages ?? []
  if (messages.length === 0) return null

  const canonicalParams = canonicalizeMessages(messages.map((m) => toMessageParam(m)))
  const turnHashes = computeTurnHashes(canonicalParams)
  const rootHash = computeRootHash(entry.inboundRequest.system, entry.inboundRequest.tools, canonicalParams[0])

  // Assistant response — present on completed entries via
  // outboundResponse.content (stream and non-stream paths both populate
  // this via buildAnthropicResponseData, see RFC §3.5).
  let postResponseHash: string | null = null
  let producedToolUseIds: Array<string> = []
  const assistantMessage = entry.outboundResponse?.content
  if (assistantMessage && assistantMessage.content) {
    const canonicalAssistant = canonicalizeMessages([toMessageParam(assistantMessage)])[0]
    postResponseHash = computePostResponseHash(turnHashes, canonicalAssistant)
    producedToolUseIds = extractProducedToolUseIds(assistantMessage)
  }

  const backToolUseId = extractBackToolUseId(messages)

  return {
    v: LINEAGE_SCHEMA_VERSION,
    rootHash,
    turnHashes,
    postResponseHash,
    producedToolUseIds,
    backToolUseId,
    computedAt: Date.now(),
  }
}

// Re-export low-level helpers in case downstream code needs them (e.g.
// the backfill script wants direct access to canonicalizeMessages for
// dry-run comparisons).
export { canonicalizeMessages, canonicalJson, sha256Hex } from "./canonicalize"
export { computePostResponseHash, computeRootHash, computeTurnHashes, packTurnHashes, unpackTurnHashes } from "./hash"

/** Re-export the public types for callers. */
export type { LineageDigest } from "./types"
export { LINEAGE_SCHEMA_VERSION } from "./types"
