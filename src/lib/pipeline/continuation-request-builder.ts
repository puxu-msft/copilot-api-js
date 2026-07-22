/**
 * Continuation-request-builder registry (spec 2026-07-22-continuation-retry-and-sequential-anchor
 * §4.3). On a mid-stream failure after the first block committed, the driver reconstructs the upstream
 * request as `[original request] + [assistant turn = committed blocks] + [synthetic user "continue"
 * turn]` so the model continues rather than restarts (upstream rejects assistant PREFILL, so the
 * committed prefix is carried as a full assistant turn ending in a user message — PoC-verified).
 *
 * The assembly is per client format (anthropic messages / openai-cc messages / openai-responses input),
 * so each format registers its own builder here. A format with no registered builder (e.g. gemini)
 * yields `undefined` and the caller degrades to `partial-degrade` — the registry lookup is the seam
 * that keeps continuation opt-in per format without the driver hard-coding format knowledge.
 */

import type { CanonicalBlock } from "./committed-blocks-ledger"

export type ClientFormat = "anthropic" | "openai-cc" | "openai-responses" | "gemini"

/**
 * Build the upstream continuation request. `original` is the format-native request envelope (typed
 * loosely here; each builder narrows it internally — tightened when the per-format builders land in
 * P3-P6). `committed` is the ledger snapshot; `message` is the configured synthetic user-turn text.
 */
export type ContinuationRequestBuilder = (original: unknown, committed: Array<CanonicalBlock>, message: string) => unknown

const REGISTRY = new Map<ClientFormat, ContinuationRequestBuilder>()

export function registerContinuationBuilder(format: ClientFormat, builder: ContinuationRequestBuilder): void {
  REGISTRY.set(format, builder)
}

export function getContinuationBuilder(format: ClientFormat): ContinuationRequestBuilder | undefined {
  return REGISTRY.get(format)
}
