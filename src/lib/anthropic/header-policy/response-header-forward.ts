/**
 * Anthropic upstream-response-header forwarding selector.
 *
 * The proxy is otherwise fully isolating: every write-out point (streamSSE / c.json /
 * forwardError) synthesizes its own response headers, so upstream (GHC) response headers
 * — request-id, anthropic-ratelimit-*, anthropic-organization-id, … — never reach the
 * client. `anthropic.strict_response_headers` opts the Anthropic path into a controlled
 * forwarding MODE (the client-bound mirror of the request-side `strict_request_headers`):
 *   - strict=false → BLACKLIST mode: forward everything EXCEPT `responseHeaderBlacklist`.
 *   - strict=true  → WHITELIST mode: forward ONLY headers matching `responseHeaderWhitelist`.
 *
 * BOTH modes ALWAYS first drop {@link PROXY_CONTROLLED_RESPONSE_HEADERS} (the security
 * floor) so a forwarded header can never corrupt the proxy's own framing (a stale upstream
 * content-length after a body rewrite would make the client parse the wrong byte count) —
 * the operator globs act on the floored subset only. Unlike the request side there is no
 * "core re-injection" merge: the proxy's own response headers are synthesized by the
 * handler write-out layer and the forwarded subset is purely additive on top.
 *
 * The mode-specific glob layers (`pruneHeaders` blacklist / `keepHeaders` whitelist) are
 * the SAME primitives the request side uses (`./header-glob-strip.ts`), so both directions
 * share one glob-compilation + mirror-opposite empty-list semantics.
 */

import {
  //
  keepHeaders,
  pruneHeaders,
} from "./header-glob-strip"

/**
 * Headers the proxy itself controls / synthesizes — NEVER forwarded from upstream,
 * regardless of mode (the always-on security floor).
 */
export const PROXY_CONTROLLED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  // Content framing — load-bearing. The proxy re-serializes the body (and may rewrite it
  // via runResponseWhole / per-frame rewrites), so the upstream content-length / encoding /
  // type / transfer-encoding do NOT describe the bytes the client receives. Forwarding them
  // corrupts client parsing. DO NOT remove these four.
  "content-length",
  "content-encoding",
  "content-type",
  "transfer-encoding",
  // Hop-by-hop (RFC 9110 §7.6.1) — meaningful only on the upstream↔proxy connection.
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  // Proxy-decided.
  "cache-control",
  "date",
  // Defensive: GHC does not set cookies, but in permissive mode an unexpected upstream
  // Set-Cookie would be forwarded — and Headers iteration folds multiple Set-Cookie into
  // one comma-joined value, producing a corrupt header. Cheap to exclude.
  "set-cookie",
])

/** Mode + operator glob lists for {@link selectForwardableResponseHeaders}. */
export interface ResponseHeaderForwardOptions {
  /** false = BLACKLIST mode (use `blacklist`); true = WHITELIST mode (use `whitelist`). */
  readonly strict: boolean
  /** BLACKLIST-mode globs: names stripped from the floored set. `[]` strips nothing. */
  readonly blacklist: ReadonlyArray<string>
  /** WHITELIST-mode globs: the ONLY names kept from the floored set. `[]` keeps nothing. */
  readonly whitelist: ReadonlyArray<string>
}

/**
 * Select which upstream response headers to forward to the client.
 *
 * Accepts any iterable of `[name, value]` pairs (a `Headers` is one — its iterator already
 * lowercases names; a raw array lets tests exercise the defensive normalization). Returns a
 * lowercased-key map ready to apply via `c.header(name, value)`.
 *
 * Two steps mirroring the request side's `selectPassthroughHeaders` → `keep/prune`:
 *   1. floor: drop the proxy-controlled set, lowercasing names.
 *   2. mode: `strict ? keepHeaders(floored, whitelist) : pruneHeaders(floored, blacklist)`.
 *
 * NOTE: `pruneHeaders`'s PROTECTED_HEADERS guard (authorization/content-type/content-length/
 * copilot-integration-id) is a request-side concept reused here harmlessly — content-type /
 * content-length are already removed by the floor; authorization / copilot-integration-id do
 * not appear on Anthropic responses, and not stripping them via a blacklist glob is only the
 * safer default.
 */
export function selectForwardableResponseHeaders(headers: Iterable<readonly [string, string]>, opts: ResponseHeaderForwardOptions): Record<string, string> {
  const floored: Record<string, string> = {}
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (PROXY_CONTROLLED_RESPONSE_HEADERS.has(lower)) continue
    floored[lower] = value
  }
  return opts.strict ? keepHeaders(floored, opts.whitelist) : pruneHeaders(floored, opts.blacklist)
}
