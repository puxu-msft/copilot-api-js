/**
 * The contentless-refusal disposition types — a dependency-FREE leaf.
 *
 * Split out of `recover-refusal.ts` purely for the module graph: `context/{types,request}.ts` need
 * `RefusalPolicy`, but `recover-refusal.ts` is itself imported by `state.ts` (for the default
 * texts), so importing it from the context would pull it into the 19-module core SCC and trip
 * `circular-deps-ratchet`. A leaf with zero imports cannot join a cycle. Keep it that way: no
 * runtime values, no imports.
 */

/** The three client-facing dispositions for a contentless refusal. `refusal` = identity passthrough,
 *  `end_turn` = SUPPRESS (synthesize a normal completed turn — the default),
 *  `error` = surface an Anthropic `event: error` frame. */
export type RefusalMode = "refusal" | "end_turn" | "error"

/**
 * The refusal disposition + templates for ONE request, resolved ONCE and then immutable.
 *
 * Why frozen per request rather than read at each layer: the rewriter captures its policy when the
 * response processor is constructed, while the handler settles after the stream drains, and any
 * concurrent request carrying a `system` re-runs `applyConfigToState()` in between. Two independent
 * reads of a hot-reloadable global cannot agree. With an immutable snapshot both layers become pure
 * functions of the same inputs again, so each derives the same disposition WITHOUT a shared mutable
 * channel between them — which is also what keeps concurrent hedge candidates from stepping on each
 * other: they share the request, never a verdict.
 */
export interface RefusalPolicy {
  mode: RefusalMode
  /** `anthropic.refusal_end_turn_text` (empty string = suppress without appending any text block). */
  endTurnText: string
  /** `anthropic.refusal_error_message`. */
  errorMessage: string
  /** `anthropic.refusal_error_type` (empty falls back to `DEFAULT_REFUSAL_ERROR_TYPE`). */
  errorType: string
}
