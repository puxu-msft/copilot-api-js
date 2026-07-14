/**
 * Synthetic-reasoning passthrough (forward translation leg only).
 *
 * GPT (OpenAI CC / Responses) models emit PLAINTEXT reasoning (`delta.reasoning` /
 * `reasoning_content`) with NO signature. When an Anthropic `/v1/messages` client reaches such a
 * model through the translation leg (`cc-to-anthropic-stream.ts` / `cc-to-anthropic.ts`), we now
 * FORWARD that reasoning as an Anthropic `thinking` block instead of dropping it (richest-data-flow:
 * the model's visible reasoning has real diagnostic/reading value).
 *
 * The block is stamped with {@link SYNTHETIC_REASONING_SIGNATURE} — a sentinel that is NOT a real
 * Anthropic signature (we cannot forge one). Its two jobs:
 *   1. **Distinguishable marker** (synthetic-data ADR): a forwarded synthetic block is identifiable
 *      as ours, never confusable with a real signed Claude thinking block.
 *   2. **Echo-back poison guard**: Claude Code echoes a thinking block back on the NEXT turn. If that
 *      turn hits the DIRECT Claude leg, an unforgeable-signature thinking block would 400 the upstream
 *      ("cannot be modified", skill `ghc-anthropic-upstream`). The request-side sanitizer strips any
 *      block bearing this sentinel UNCONDITIONALLY (not gated by `thinkingBlockSanitizeCheck`) — see
 *      `sanitize/index.ts`. The forward translation leg already drops all thinking blocks, so the
 *      strip only matters for the direct Claude leg, which is exactly where poisoning would occur.
 */

/** Sentinel signature stamped on every forwarded synthetic reasoning (thinking) block. */
export const SYNTHETIC_REASONING_SIGNATURE = "copilot-api:synthetic-reasoning:v1"

/** Is this signature our synthetic-reasoning sentinel? (drives the unconditional request-side strip) */
export function isSyntheticReasoningSignature(signature: unknown): boolean {
  return typeof signature === "string" && signature === SYNTHETIC_REASONING_SIGNATURE
}
