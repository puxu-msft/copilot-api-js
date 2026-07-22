/**
 * Shared frozen retry-strategy-name fixtures (Task 6 / plan carryover, Task 2 reviewer Minor ③).
 *
 * The 16-name `@messages` order and the 3-name shared-leg order are hand-authored constants
 * (deliberately NOT derived from `~/lib/request/retry-registry.ts`'s `RETRY_STRATEGY_REGISTRY` — these
 * are independent oracles: the golden test and the config-driven test both need to detect a real
 * regression in the registry's declared order, so they must NOT import their expected value FROM the
 * thing they're testing). Previously duplicated verbatim across `tests/pipeline/retry-strategy-assembly.
 * golden.it.test.ts`, `tests/request/retry-registry.unit.test.ts`, and `tests/config/retry-strategies.
 * it.test.ts` — three independent literals that could silently drift apart on a future edit to just one
 * of them. Centralizing here keeps the "one frozen truth, three independent consumers" property while
 * eliminating the drift risk.
 */

/** The frozen 16-name Anthropic-stack order (RFC §12.9) — shared by the direct `/v1/messages` leg AND
 *  all 3 reverse `@messages` legs (the reverse branch of `buildLegStrategies` delegates to the SAME
 *  `buildAnthropicStrategies`). */
export const ANTHROPIC_16_NAMES = [
  "network-retry",
  "server-error-retry",
  "token-refresh",
  "effort-learning",
  "tool-field-rejection-retry",
  "body-field-rejection-retry",
  "cache-control-subfield-rejection-retry",
  "legacy-thinking-retry",
  "adaptive-thinking-rejection-retry",
  "poisoned-thinking-retry",
  "unsupported-beta-retry",
  "server-tool-rejection-retry",
  "structured-outputs-rejection-retry",
  "system-reject-retry",
  "web-search-not-found-retry",
  "deferred-tool-retry",
]

/** The shared 3-name stack (network → server-error → token-refresh) both CC and Responses direct legs
 *  yield since master removed auto-truncate (2026-07-13) — every CC-family leg's strategy STACK is now
 *  identical. */
export const SHARED_3_NAMES = ["network-retry", "server-error-retry", "token-refresh"]
