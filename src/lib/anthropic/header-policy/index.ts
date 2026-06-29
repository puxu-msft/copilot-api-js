/**
 * Header-boundary policy for the Anthropic path: which HTTP headers cross the
 * proxy in each direction.
 *
 *   - `request-header-forward.ts` — client → upstream passthrough policy
 *     (`anthropic.strict_request_headers`).
 *   - `response-header-forward.ts` — upstream → client forward policy
 *     (`anthropic.strict_response_headers`).
 *   - `header-glob-strip.ts` — generic glob header-name filter primitives
 *     (blacklist strip + whitelist keep over the request passthrough set).
 *   - `header-name-match.ts` — shared case-insensitive name matcher.
 *
 * This barrel re-exports the cross-module public API. White-box unit tests import
 * the individual files directly.
 */

export { keepHeaders, pruneHeaders } from "./header-glob-strip"
export { selectPassthroughHeaders } from "./request-header-forward"
export { selectForwardableResponseHeaders } from "./response-header-forward"
