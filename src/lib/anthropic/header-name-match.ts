/**
 * Shared header-name matching primitive for the proxy's header-boundary policies.
 *
 * Both directions filter headers crossing the proxy boundary by the same idiom —
 * "is this (already-lowercased) header name in an exact set OR under a prefix" —
 * but with direction-specific sets and threat models:
 *   - request side (`lib/anthropic/request-header-forward.ts`): the passthrough sensitive denylist
 *     (`strict_request_headers`), so client credentials / proxy namespaces never
 *     reach the upstream.
 *   - response side (`lib/anthropic/response-header-forward.ts`): the strict-mode
 *     allowlist (`strict_response_headers`), so only known-safe upstream headers
 *     reach the client.
 *
 * Only this name-matching mechanic is shared; the policy sets and the selectors
 * stay in their own modules (different reserved sets, strict semantics, and the
 * request side's extra glob-strip layer make a merged selector false cohesion).
 */

/**
 * True when `lowerName` (a header name already normalized to lowercase) is in
 * `exact` or starts with any entry of `prefixes` (also lowercased). Pure.
 */
export function matchesHeaderName(lowerName: string, exact: ReadonlySet<string>, prefixes: ReadonlyArray<string>): boolean {
  return exact.has(lowerName) || prefixes.some((prefix) => lowerName.startsWith(prefix))
}
