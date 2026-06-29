/**
 * Request-side header-boundary policy: select which of the client's inbound HTTP
 * request headers are safe to forward to the upstream (the security floor).
 * Request-side mirror of `./response-header-forward.ts`. All matching is
 * case-insensitive over the header *name*. The mode-specific glob layers
 * (blacklist strip / whitelist keep) live in `./header-glob-strip.ts`; the shared
 * name matcher in `./header-name-match.ts`.
 *
 * `selectPassthroughHeaders` is the SHARED floor for BOTH forwarding modes
 * (`anthropic.strict_request_headers`): it removes the proxy's own core keys and
 * the sensitive denylist so that neither blacklist mode (`false`, keep-all-minus-
 * `request_header_blacklist`) nor whitelist mode (`true`, keep-only-
 * `request_header_whitelist`) can ever leak client credentials / break framing.
 *
 * `SENSITIVE_DENYLIST` / `SENSITIVE_PREFIXES` are client header names that must
 * never be forwarded upstream in EITHER mode: client credentials (would leak to
 * GHC), hop-by-hop headers, body-framing headers (the proxy rebuilds the body —
 * a stale content-length / content-encoding / accept-encoding breaks the upstream
 * exchange), forwarded-chain headers (leak client topology), and the proxy's own
 * routing/billing namespaces. Whitelist mode cannot re-admit these — the whitelist
 * is an intersection WITHIN the floor's output.
 *
 * Wired for the upstream REQUEST only (Anthropic v4 path: floor + blacklist/whitelist
 * in `buildAnthropicHeaders`). The client-bound RESPONSE side is `./response-header-forward.ts`.
 */

import { matchesHeaderName } from "./header-name-match"

/**
 * Client header names that must NEVER be passed through to the upstream, even
 * when passthrough is enabled. `authorization` / `api-key` are already covered by
 * the dynamic core-key set, but listed here as defense-in-depth against a future
 * refactor that makes a core key conditional.
 */
const SENSITIVE_DENYLIST: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "host",
  "content-length",
  "content-encoding",
  "accept-encoding",
  "expect",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "via",
  "forwarded",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "true-client-ip",
  "cf-connecting-ip",
  "x-client-ip",
])

/**
 * Proxy-owned header namespaces. Client headers under these prefixes (other
 * than the specific core keys the proxy itself sets, which are reserved
 * separately via the dynamic core-key set) must not be forwarded — they could
 * let a client impersonate the proxy's routing/billing identity to GHC.
 */
const SENSITIVE_PREFIXES: ReadonlyArray<string> = ["x-github-", "openai-"]

/** True when a (lowercased) header name is denied passthrough by name or prefix. */
function isSensitivePassthrough(nameLower: string): boolean {
  return matchesHeaderName(nameLower, SENSITIVE_DENYLIST, SENSITIVE_PREFIXES)
}

/**
 * Select the subset of client headers safe to forward upstream: drop any name
 * that is a proxy-owned core key (`reservedCoreLower`, lowercased) or matches
 * the passthrough denylist/prefixes. Never mutates input.
 *
 * `clientHeaders` keys are expected lowercased (they come from `Headers.entries()`,
 * which normalizes names). The comparison still lowercases defensively.
 */
export function selectPassthroughHeaders(clientHeaders: Record<string, string>, reservedCoreLower: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(clientHeaders).filter(([name]) => {
      const lower = name.toLowerCase()
      return !reservedCoreLower.has(lower) && !isSensitivePassthrough(lower)
    }),
  )
}
