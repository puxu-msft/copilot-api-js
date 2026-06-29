/**
 * Anthropic upstream-response-header forwarding selector.
 *
 * The proxy is otherwise fully isolating: every write-out point (streamSSE / c.json /
 * forwardError) synthesizes its own response headers, so upstream (GHC) response headers
 * — request-id, anthropic-ratelimit-*, anthropic-organization-id, … — never reach the
 * client. `anthropic.strict_response_headers` opts the Anthropic path into forwarding a
 * controlled subset:
 *   - strict=true  → only {@link STRICT_ALLOWLIST_EXACT} ∪ {@link STRICT_ALLOWLIST_PREFIXES}.
 *   - strict=false → everything EXCEPT {@link PROXY_CONTROLLED_RESPONSE_HEADERS}.
 *
 * BOTH modes always drop the proxy-controlled set so a forwarded header can never corrupt
 * the proxy's own framing (a stale upstream content-length after a body rewrite would make
 * the client parse the wrong byte count).
 */

import { matchesHeaderName } from "./header-name-match"

/**
 * Headers the proxy itself controls / synthesizes — NEVER forwarded from upstream,
 * regardless of mode (the permissive-mode blacklist).
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

/** strict-mode allowlist (exact, already-lowercased names). */
const STRICT_ALLOWLIST_EXACT: ReadonlySet<string> = new Set(["request-id", "x-request-id", "anthropic-organization-id", "retry-after"])

/** strict-mode allowlist prefixes (lowercased) — e.g. the whole `anthropic-ratelimit-*` family. */
const STRICT_ALLOWLIST_PREFIXES: ReadonlyArray<string> = ["anthropic-ratelimit-"]

function isStrictAllowed(lowerName: string): boolean {
  return matchesHeaderName(lowerName, STRICT_ALLOWLIST_EXACT, STRICT_ALLOWLIST_PREFIXES)
}

/**
 * Select which upstream response headers to forward to the client.
 *
 * Accepts any iterable of `[name, value]` pairs (a `Headers` is one — its iterator already
 * lowercases names; a raw array lets tests exercise the defensive normalization). Returns a
 * lowercased-key map ready to apply via `c.header(name, value)`.
 */
export function selectForwardableResponseHeaders(headers: Iterable<readonly [string, string]>, strict: boolean): Record<string, string> {
  const forward: Record<string, string> = {}
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (PROXY_CONTROLLED_RESPONSE_HEADERS.has(lower)) continue
    if (strict && !isStrictAllowed(lower)) continue
    forward[lower] = value
  }
  return forward
}
