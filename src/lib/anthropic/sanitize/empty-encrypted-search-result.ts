/**
 * Fallback: downgrade synthesized web_search history that upstream will reject.
 *
 * ── The bug this closes ───────────────────────────────────────────────────
 * The web_search double-hop synthesizes a `web_search_tool_result` block whose
 * `web_search_result` items carry `encrypted_content: ""` — see
 * `web-search/synthesize.ts`, which cannot produce Anthropic's native encrypted
 * payload from a SearXNG / Copilot backend. That block is deliberately sent to
 * the client (so search results are visible), stored in history, and echoed back
 * next turn. Upstream GHC then rejects it with:
 *
 *   400 messages.N.content.0: Invalid `encrypted_content` in `search_result` block
 *
 * Empirically verified (exp/encrypted-content-400): upstream requires a REAL
 * valid encrypted_content — an empty string AND any non-empty placeholder are
 * both rejected. So there is no way to "repair" the field; the only sendable
 * shape is to downgrade the whole web_search turn to a plain tool_use +
 * tool_result (exactly what `rewriteServerToolBlocks("downgrade")` does).
 *
 * ── Why this runs unconditionally (not gated on a config flag) ─────────────
 * A `web_search_tool_result` on our wire can ONLY be one we synthesized (GHC
 * Copilot has no native Anthropic web_search server tool — that is the entire
 * reason the double-hop exists). A synthesized one always carries empty
 * encrypted_content, so it is 100% guaranteed to 400. There is no legitimate
 * reason to forward it, so this is a protocol-correctness floor like
 * `server-tool-filter` — always active, no opt-out.
 *
 * ── Why the trigger is narrow ──────────────────────────────────────────────
 * It fires ONLY for a `*_tool_result` block whose content array contains a
 * `web_search_result` item with empty/missing `encrypted_content`. Real (future)
 * results with a genuine encrypted_content, and unrelated server-tool results
 * (e.g. `tool_search_tool_result`, whose content is an object, not a result
 * array), are left untouched — no over-reach beyond the proven-broken shape.
 *
 * This is orthogonal to the `server_tool_rewrite` config: when that is
 * enabled it downgrades ALL server-tool history first, so this pass then finds
 * nothing to do (no-op); when it is disabled, this pass still catches the
 * poisoned web_search turns. Both reuse the same downgrade primitive.
 */

import type { MessageParam } from "~/types/api/anthropic"

import { isServerToolResultType } from "../server-tool-filter"
import { rewriteServerToolBlocks } from "./rewrite-server-tool-blocks"

export interface DowngradeEmptyEncryptedSearchResult {
  messages: Array<MessageParam>
  /** Number of messages whose web_search turn was downgraded. */
  downgradedCount: number
}

/**
 * Whether an `encrypted_content` value is unsendable — upstream requires a valid
 * NON-EMPTY string and rejects everything else (empirically verified,
 * exp/encrypted-content-400): `""`, `null`, missing, and non-string all 400 with
 * "Input should be a valid string" / "Invalid encrypted_content". A non-empty
 * string is passed through (we cannot distinguish a real cipher from a
 * placeholder, and our synthesized blocks only ever carry `""`, so a non-empty
 * value never originates here anyway).
 */
function isEmptyEncrypted(item: { encrypted_content?: unknown }): boolean {
  return typeof item.encrypted_content !== "string" || item.encrypted_content === ""
}

/**
 * Whether a `*_tool_result` block carries a `web_search_result` item with
 * unsendable `encrypted_content` (the upstream-rejected shape).
 *
 * Only the ARRAY (results) content form is targeted. The error-shaped form
 * (`content: { type: "web_search_tool_result_error", error_code }`, synthesized
 * on an empty/failed search) is deliberately NOT touched — empirically upstream
 * ACCEPTS it (HTTP 200, exp/encrypted-content-400 CASE 3), so downgrading it
 * would be a needless mutation of an already-sendable turn.
 */
function blockHasEmptyEncryptedSearchResult(block: { type: string; content?: unknown }): boolean {
  if (!isServerToolResultType(block.type)) return false
  if (!Array.isArray(block.content)) return false
  return block.content.some(
    (item) =>
      typeof item === "object"
      && item !== null
      && (item as { type?: unknown }).type === "web_search_result"
      && isEmptyEncrypted(item as { encrypted_content?: unknown }),
  )
}

/** Whether a message contains a poisoned (empty-encrypted) web_search result. */
function messageHasEmptyEncryptedSearchResult(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false
  return msg.content.some((block) => blockHasEmptyEncryptedSearchResult(block as { type: string; content?: unknown }))
}

/**
 * Downgrade any web_search history turn whose result `encrypted_content` is empty
 * (or missing) into a plain tool_use + tool_result, so upstream stops rejecting
 * it with `Invalid encrypted_content in search_result block`.
 *
 * Reuses `rewriteServerToolBlocks("downgrade")` per poisoned message so the
 * message-splitting / stringification logic stays single-sourced. Messages
 * without a poisoned web_search result are returned untouched; when nothing is
 * poisoned the input array reference is returned unchanged.
 */
export function downgradeEmptyEncryptedSearchResults(messages: Array<MessageParam>): DowngradeEmptyEncryptedSearchResult {
  let changed = false
  let downgradedCount = 0
  const result: Array<MessageParam> = []

  for (const msg of messages) {
    if (!messageHasEmptyEncryptedSearchResult(msg)) {
      result.push(msg)
      continue
    }
    changed = true
    downgradedCount++
    // A poisoned message always contains a *_tool_result, so downgrade always
    // rewrites it (assistant turns split into tool_use + a trailing user
    // tool_result; an orphan user-side result downgrades in place).
    const { messages: rewritten } = rewriteServerToolBlocks([msg], "downgrade")
    result.push(...rewritten)
  }

  return { messages: changed ? result : messages, downgradedCount }
}
