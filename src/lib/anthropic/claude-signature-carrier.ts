/**
 * Claude-signature carrier (reverse round-trip leg only).
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §4.2/§4.4, Phase 5 — the REVERSE direction
 * (openai-responses client ↔ Claude model @messages). A Claude `thinking` block carries a REAL,
 * Anthropic-signed `signature` (via `/v1/messages`'s wire, or a `signature_delta` on the streaming
 * leg). To let that reasoning survive a round-trip through a responses-shaped client (the client
 * echoes the reasoning item back on a later turn), the real signature must be carried in the
 * Responses `reasoning` output item's `encrypted_content` slot and reconstructed byte-exact on
 * echo-back — Claude's upstream REJECTS a signature that has been altered by even one byte
 * ("Invalid signature in thinking block", 400 — exp/anthropic-responses-direct/FINDINGS.md 探针 e).
 *
 * ⚠️ R-DIRECTION-ASYMMETRY (RFC §4.4): this is a SEPARATE, NON-SHARED primitive from
 * `synthetic-reasoning.ts` (the FORWARD leg's sentinel-envelope primitive for GPT's
 * `encrypted_content` → Anthropic `thinking.signature`). Both use the SAME shape (a stamped prefix +
 * base64url payload) because that shape is simply the right generic tool for "make an opaque wire
 * blob distinguishable + round-trippable" — but the prefixes are DISTINCT and the functions here are
 * NOT called from, and do not call, `synthetic-reasoning.ts`. This distinction matters operationally:
 * `sanitize/content-blocks.ts`'s `stripSyntheticReasoningBlocks` strips ONLY the `synthetic-reasoning`
 * sentinel prefix (a poison guard for the FORWARD leg's un-forgeable envelope hitting the direct
 * Claude leg) — a thinking block reconstructed by THIS primitive carries the real Claude signature
 * BARE (no prefix at all, see {@link extractClaudeSignature}), so it is invisible to that guard and
 * reaches the Claude upstream unmodified, exactly as it must (the real signature IS valid there).
 *
 * The reasoning item's DISPLAYABLE text lives in the Responses `summary` field (Responses' own
 * native slot for it — richest-data-flow, no reason to duplicate it inside the opaque carrier);
 * `encrypted_content` carries ONLY the signature. This carrier makes NO claim about, and never
 * touches, plaintext — see the F-leg / D-leg callers for how `summary` and this carrier combine.
 */

/** Sentinel prefix stamped on a carried real Claude thinking signature. Distinct from `SYNTHETIC_REASONING_SIGNATURE_PREFIX` (synthetic-reasoning.ts) — the two are never interchangeable (R-DIRECTION-ASYMMETRY). */
export const CLAUDE_SIGNATURE_CARRIER_PREFIX = "copilot-api:claude-signature:v1:"

/**
 * Wrap a real Claude thinking `signature` into the labeled-envelope carrier for the Responses
 * `reasoning` output item's `encrypted_content`. `undefined`/empty input → `undefined` (no carrier
 * emitted; a reasoning item with no signature to carry, e.g. scenario B's stripped case, simply omits
 * `encrypted_content` rather than emitting a hollow envelope).
 */
export function buildClaudeSignatureCarrier(signature: string | undefined): string | undefined {
  if (!signature) return undefined
  return CLAUDE_SIGNATURE_CARRIER_PREFIX + Buffer.from(signature, "utf8").toString("base64url")
}

/**
 * Extract the real Claude signature from a carrier string (the reasoning item's `encrypted_content`
 * as echoed back by the client). Returns undefined for anything that isn't OUR carrier (absent,
 * empty, a foreign/synthetic-reasoning-prefixed value, or a corrupt base64url payload) — never
 * throws (never-swallow: the caller decides what "no signature" means for its leg, this primitive
 * only ever reports presence/absence of a byte-exact recoverable payload).
 */
export function extractClaudeSignature(carrier: unknown): string | undefined {
  if (typeof carrier !== "string" || !carrier.startsWith(CLAUDE_SIGNATURE_CARRIER_PREFIX)) return undefined
  const payload = carrier.slice(CLAUDE_SIGNATURE_CARRIER_PREFIX.length)
  if (payload.length === 0) return undefined
  try {
    return Buffer.from(payload, "base64url").toString("utf8")
  } catch {
    return undefined
  }
}
