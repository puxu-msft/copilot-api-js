/**
 * The contentless-refusal disposition types **and default texts** — a dependency-FREE leaf.
 *
 * Split out of `recover-refusal.ts` purely for the module graph: `context/{types,request}.ts` need
 * `RefusalPolicy`, but `recover-refusal.ts` is itself imported by `state.ts` (for the default
 * texts), so importing it from the context would pull it into the 19-module core SCC and trip
 * `circular-deps-ratchet`. A leaf with zero imports cannot join a cycle. Keep it that way: no
 * runtime values beyond bare literals, and NO IMPORTS — the import-freedom is the actual property
 * that keeps this file out of every cycle.
 *
 * The three `DEFAULT_REFUSAL_*` constants moved here from `recover-refusal.ts` for the same reason,
 * one step further: `state-defaults.ts` reads them, and that one value edge alone kept `state` and
 * `state-defaults` inside 52 and 50 of the repo's 70 import cycles. Pointing it at this leaf instead
 * measured 70 cycles/63 members → 30/43. See
 * docs/plan/2026-07-28-state-to-foundation/HANDOVER.md §3.2 — the module graph, not taste, decides
 * where these literals live. `recover-refusal.ts` re-exports all three, so its public path is
 * unchanged; `tests/architecture/state-defaults-value-owners.unit.test.ts` fails the build if a
 * second declaration reappears there.
 */

/** The Anthropic error `type` carried by a synthetic refusal `error` frame when config leaves it
 *  empty. Lives on the leaf so the policy snapshot can resolve the fallback ONCE at construction —
 *  otherwise every consumer re-implements the same `"" -> api_error` rule and one of them forgets. */
export const DEFAULT_REFUSAL_ERROR_TYPE = "api_error"

/**
 * DEFAULT for `anthropic.refusal_end_turn_text` (the `end_turn`-mode suppression text).
 *
 * Reports what happened WITHOUT asserting anything the wire does not support: it does not claim the
 * turn was "thinking-only" (the real `cyber` sample produced ZERO content blocks with thinking
 * disabled), and it does not call the block "transient" (unverified — the `bio` sample refused only
 * after 25,636 thinking tokens). It carries `{refusal_category}` but deliberately NOT
 * `{refusal_explanation}`: this text is a SUCCESSFUL assistant message that the client bakes into
 * conversation history, and the upstream explanation is diagnostic metadata about the request, not
 * the model's answer to the user's task — replaying it as assistant content pollutes the semantic
 * context. The explanation stays fully available in History, logs and the `error`-mode message.
 * Overridable via config; see `renderRefusalTemplate` in `recover-refusal.ts`.
 */
export const DEFAULT_REFUSAL_END_TURN_TEXT =
  "上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（拒绝类别：{refusal_category}）。这是上游安全策略对本次请求的拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后继续；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。"

/**
 * DEFAULT for `anthropic.refusal_error_message` (the message carried by the synthetic Anthropic
 * `error` frame in the opt-in `error` mode; the client SDK surfaces it as the thrown `APIError`'s
 * message). Unlike the end_turn text this DOES carry `{refusal_explanation}` — an error frame is
 * never baked into the conversation history, so the full upstream diagnostic can ride along.
 */
export const DEFAULT_REFUSAL_ERROR_MESSAGE =
  "上游模型本轮以「拒绝（refusal）」结束、未产出可用回复（拒绝类别：{refusal_category}）。已按 error 策略中断本次请求。上游说明：{refusal_explanation}"

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
