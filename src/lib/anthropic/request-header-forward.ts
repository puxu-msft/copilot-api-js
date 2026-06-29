/**
 * Request-side header-boundary policy: forward the client's inbound HTTP request
 * headers to the upstream (passthrough), with a glob strip layer. Request-side
 * mirror of `./response-header-forward.ts`. All matching is case-insensitive over
 * the header *name*.
 *
 * Two distinct guard sets live here, with opposite purposes — do NOT conflate:
 *   - `PROTECTED_HEADERS` (STRIP side): names `pruneHeaders` must never drop,
 *     even if an operator glob matches them (so a stray `*` can't strip the
 *     proxy's own credentials).
 *   - `SENSITIVE_DENYLIST` / `SENSITIVE_PREFIXES` (PASSTHROUGH side): client
 *     header names that must never be forwarded upstream when passthrough is
 *     enabled (`anthropic.strict_request_headers: false`), regardless of strip
 *     config.
 *
 * Wired for the upstream REQUEST only (Anthropic v4 path: passthrough + strip in
 * `buildAnthropicHeaders`). The client-bound RESPONSE side is `./response-header-forward.ts`.
 */

import { matchesHeaderName } from "./header-name-match"

/** Headers that must never be stripped, even if a glob matches them. */
const PROTECTED_HEADERS: ReadonlySet<string> = new Set(["authorization", "content-type", "content-length", "copilot-integration-id"])

/**
 * Client header names that must NEVER be passed through to the upstream, even
 * when passthrough is enabled. Covers: client credentials (would leak to GHC),
 * hop-by-hop headers (meaningless/harmful when the proxy rebuilds the request),
 * body-framing headers (the proxy rebuilds the body — a stale content-length /
 * content-encoding / accept-encoding breaks or corrupts the upstream exchange),
 * and forwarded-chain headers (leak client topology). `authorization` / `api-key`
 * are already covered by the dynamic core-key set, but listed here as
 * defense-in-depth against a future refactor that makes a core key conditional.
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

/** Translate a glob (`*` `?`) into an anchored case-insensitive RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${escaped}$`, "iu")
}

/** Compile patterns into a predicate; returns null when nothing to strip. */
export function compileHeaderStrip(patterns: ReadonlyArray<string>): ((name: string) => boolean) | null {
  const globs = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => globToRegExp(p))
  if (globs.length === 0) return null
  return (name: string) => !PROTECTED_HEADERS.has(name.toLowerCase()) && globs.some((g) => g.test(name))
}

/** Return a new header map with matching names removed. Never mutates input. */
export function pruneHeaders(headers: Record<string, string>, patterns: ReadonlyArray<string>): Record<string, string> {
  const shouldStrip = compileHeaderStrip(patterns)
  if (!shouldStrip) return headers
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !shouldStrip(name)))
}

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
