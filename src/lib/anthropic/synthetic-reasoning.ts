/**
 * Synthetic-reasoning passthrough (forward translation leg only).
 *
 * GPT (OpenAI CC / Responses) models expose their reasoning as a DISPLAYABLE `summary`
 * (`response.reasoning_summary_text.delta`, only when the request asks for `reasoning.summary`) plus an
 * opaque `encrypted_content` blob (the full reasoning, needed for cross-turn round-tripping). When an
 * Anthropic `/v1/messages` client reaches such a model through the translation leg, we FORWARD that
 * reasoning as an Anthropic `thinking` block instead of dropping it (richest-data-flow: the model's
 * visible reasoning has real diagnostic/reading value).
 *
 * We cannot forge a real Anthropic signature, so the block's `signature` is a LABELED ENVELOPE:
 *
 *     copilot-api:synthetic-reasoning:v1:<base64url(encrypted_content)>
 *     └────────────── sentinel prefix ──────────────┘└──── opaque payload (optional) ────┘
 *
 *   1. **Distinguishable marker** (synthetic-data ADR): the prefix makes a forwarded synthetic block
 *      unambiguously OURS — never confusable with a real signed Claude thinking block, even though both
 *      an Anthropic signature and GHC's `encrypted_content` are opaque base64 blobs.
 *   2. **Echo-back poison guard**: Claude Code echoes a thinking block back on the NEXT turn. On the DIRECT
 *      Claude leg an unforgeable-signature thinking block would 400 the upstream ("cannot be modified",
 *      skill `ghc-anthropic-upstream`). The request-side sanitizer strips any block whose signature bears
 *      the sentinel PREFIX UNCONDITIONALLY (not gated by `thinkingBlockSanitizeCheck`).
 *   3. **Cross-turn round-trip** (GPT leg): the encrypted payload lets a future echo-back reconstruct the
 *      Responses `reasoning` item so the model's reasoning is not lost across turns. The prefix guarantees
 *      this only ever fires on OUR blocks.
 *
 * The forward translation leg already drops all thinking blocks, so the strip only matters for the direct
 * Claude leg — which is exactly where poisoning would occur.
 */

/** Sentinel prefix stamped on every forwarded synthetic reasoning (thinking) block's signature. */
export const SYNTHETIC_REASONING_SIGNATURE_PREFIX = "copilot-api:synthetic-reasoning:v1:"

/**
 * Legacy bare sentinel (v1 without a payload separator). Still recognized by the strip guard so a block
 * emitted before the labeled-envelope upgrade is echoed back safely. New blocks always use the prefix form.
 */
export const SYNTHETIC_REASONING_SIGNATURE = "copilot-api:synthetic-reasoning:v1"

/**
 * Build the labeled-envelope signature for a synthetic thinking block. `encryptedContent` (GHC's opaque
 * reasoning blob) is base64url-embedded when present; absent → the bare prefix (still distinguishable).
 */
export function buildSyntheticReasoningSignature(encryptedContent?: string): string {
  if (!encryptedContent) return SYNTHETIC_REASONING_SIGNATURE_PREFIX
  return SYNTHETIC_REASONING_SIGNATURE_PREFIX + Buffer.from(encryptedContent, "utf8").toString("base64url")
}

/** Is this signature one of OUR synthetic-reasoning sentinels? (drives the unconditional request-side strip) */
export function isSyntheticReasoningSignature(signature: unknown): boolean {
  return typeof signature === "string" && (signature.startsWith(SYNTHETIC_REASONING_SIGNATURE_PREFIX) || signature === SYNTHETIC_REASONING_SIGNATURE)
}

/**
 * Extract the embedded `encrypted_content` from a labeled-envelope signature, or undefined if the block
 * carries no payload (bare prefix / legacy / not ours). Used to reconstruct the Responses reasoning item
 * on a GPT-leg echo-back round-trip.
 */
export function extractEncryptedReasoning(signature: unknown): string | undefined {
  if (typeof signature !== "string" || !signature.startsWith(SYNTHETIC_REASONING_SIGNATURE_PREFIX)) return undefined
  const payload = signature.slice(SYNTHETIC_REASONING_SIGNATURE_PREFIX.length)
  if (payload.length === 0) return undefined
  try {
    return Buffer.from(payload, "base64url").toString("utf8")
  } catch {
    return undefined
  }
}
