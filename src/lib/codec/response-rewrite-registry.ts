/**
 * Full-format response-rewrite registry (RFC 2026-07-11-anthropic-via-openai-translation §7.1,
 * "registry 全格式装配" / FAIL-P).
 *
 * The v4 driver's S5 chain used to be assembled from a PER-ROUTE single-format array
 * (`deps.responseRewrites`): the messages route injected `ANTHROPIC_RESPONSE_REWRITES`, the
 * Responses route injected `RESPONSES_RESPONSE_REWRITES` (fixStreamIds), cc/gemini injected
 * nothing. That is wrong for the translation matrix: a leg's rewrites gate on the OUTBOUND
 * wire (`targetEndpoint`, §3.1), so a reverse translation leg (e.g. cc→`/v1/messages`) must
 * fire the ANTHROPIC册 even though its inbound route is cc — but the cc route never injected it.
 *
 * The fix: every driver assembles its S5 chain from the SAME full-format union, keyed by the
 * outbound leg via each rewrite's `targetEndpoint`-based `appliesTo`. This module is the single
 * source of that table. It lives in `lib/codec` (not `lib/pipeline`) so it can import both codec
 * registries without the `lib/pipeline → lib/codec` import cycle the driver deliberately avoids;
 * the driver stays format-agnostic and receives the union via `deps.responseRewrites`.
 *
 * Phase 1 zero-regression: no translation leg exists yet, so for each of the 6 live grids the
 * only rewrites whose `appliesTo` passes are exactly the ones the per-route injection used to
 * supply (ANTHROPIC gates `targetEndpoint===/v1/messages`, co-true with anthropic-direct;
 * fixStreamIds still gates `clientFormat===openai-responses && targetEndpoint===/responses`).
 * The other formats' rewrites are inert via `appliesTo`, so the assembled chain — and every
 * forwarded byte — is identical to before (Phase 0 golden + response-rewrite goldens unchanged).
 */

import type { UpstreamEndpoint } from "~/lib/pipeline/envelope"
import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"

import { ANTHROPIC_RESPONSE_REWRITES } from "./anthropic/response-rewrite-adapters"
import { RESPONSES_RESPONSE_REWRITES } from "./openai-responses/response-rewrites"

/**
 * The response-rewrite册 that process each OUTBOUND leg's wire, keyed by `targetEndpoint`
 * (the §7.1 "{targetEndpoint→改写册} 全格式表"). The messages leg runs the Anthropic wire
 * rewrites; the Responses HTTP/WS legs run fixStreamIds; the CC leg has none today (CC-family
 * rewrites land with the forward/reverse CC legs in later phases). This is the SSOT the flat
 * {@link ALL_RESPONSE_REWRITES} union is derived from.
 */
export const RESPONSE_REWRITES_BY_ENDPOINT: Record<UpstreamEndpoint, ReadonlyArray<ResponseRewrite>> = {
  "/v1/messages": ANTHROPIC_RESPONSE_REWRITES,
  "/responses": RESPONSES_RESPONSE_REWRITES,
  "ws:/responses": RESPONSES_RESPONSE_REWRITES,
  "/chat/completions": [],
}

/**
 * The de-duplicated union of every leg's response rewrites — the full-format S5 registry every
 * v4 driver passes as `deps.responseRewrites`. The driver's `assembleResponseRewrites` filters
 * it by each rewrite's `appliesTo` (targetEndpoint-keyed) and sorts by `order`, so the chain is
 * the leg-correct subset. (`/responses` and `ws:/responses` share the same array instance, so the
 * `Set` collapses the duplicate.)
 */
export const ALL_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [...new Set(Object.values(RESPONSE_REWRITES_BY_ENDPOINT).flat())]
