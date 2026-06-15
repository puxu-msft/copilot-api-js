/**
 * Lineage digest types.
 *
 * See `docs/rfc/request-lineage.md` for design rationale. The digest is
 * computed once per finalized entry from its `inboundRequest.messages` +
 * `outboundResponse.content`, persisted to `entry_lineage` + indexed via
 * `entry_produced_tool_ids` (cryptographic-strength parent edge via
 * upstream-minted 16-byte tool_use ids).
 */

/**
 * Schema version for the canonicalization rules. Bump whenever the
 * canonicalization in `./canonicalize.ts` changes in a way that would alter
 * the hash of previously-recorded entries. Stored per row so a partial
 * rebackfill can detect stale digests.
 */
export const LINEAGE_SCHEMA_VERSION = 1

/** Per-entry digest persisted in the `entry_lineage` table. */
export interface LineageDigest {
  /** Schema version of the canonicalization rules used to compute this digest. */
  v: typeof LINEAGE_SCHEMA_VERSION
  /**
   * Coarse conversation-root partition.
   *
   * `sha256(sha256(canonical(system)) || sha256(canonical(tools)) || sha256(canonical(messages[0])))`.
   *
   * msg[0] alone collides across distinct conversations (empirically verified
   * — see RFC §2.2); folding `system` + `tools` into the root binds the
   * partition to the agent identity.
   */
  rootHash: string
  /**
   * Cumulative Merkle-style chain: `turnHashes[i] = sha256(turnHashes[i-1] || canonicalJson(messages[i]))`.
   * Length always equals `messages.length`.
   *
   * Property: if request B follows request A, then
   * `B.turnHashes[A.turnHashes.length] === A.postResponseHash`
   * proves `B.messages[0..A.turnHashes.length]` deep-equals
   * `A.messages ++ [assistantResponse]` — a single hex compare verifies
   * the entire prefix.
   */
  turnHashes: Array<string>
  /**
   * Hash that a successor request will produce at index `turnHashes.length`
   * (the position where this entry's assistant response would land in the
   * successor's chain). `null` for failed/interrupted entries (no usable
   * assistant message → cannot serve as a parent; can still be a child).
   */
  postResponseHash: string | null
  /**
   * Every `tool_use.id` emitted in the assistant response. Indexed in
   * `entry_produced_tool_ids` so successors can find their parent in O(1)
   * by looking up `backToolUseId`.
   */
  producedToolUseIds: Array<string>
  /**
   * The first `tool_use_id` referenced by a `tool_result` block in the
   * last message of `inboundRequest.messages`. The primary back-edge to
   * the parent entry. `null` when the tail message has no tool_result
   * (pure-text turn, ~1% of completed Claude Code traffic — see RFC §2.3).
   */
  backToolUseId: string | null
  /** Wall-clock ms when this digest was computed. */
  computedAt: number
}
