/**
 * Shared header-name matching primitive for the proxy's header-boundary policies.
 *
 * Tests whether an (already-lowercased) header name is in an exact set OR under a
 * prefix. Consumed by the request side (`./request-header-forward.ts`) for the
 * passthrough sensitive denylist (`strict_request_headers`), so client credentials /
 * proxy namespaces never reach the upstream.
 *
 * NOTE: the response side (`./response-header-forward.ts`) used to consume this for its
 * strict-mode allowlist, but its exact+prefix allowlist was migrated to the shared glob
 * primitives in `./header-glob-strip.ts` (it now mirrors the request side's blacklist/
 * whitelist mode), so only the request side consumes this matcher today.
 */

/**
 * True when `lowerName` (a header name already normalized to lowercase) is in
 * `exact` or starts with any entry of `prefixes` (also lowercased). Pure.
 */
export function matchesHeaderName(lowerName: string, exact: ReadonlySet<string>, prefixes: ReadonlyArray<string>): boolean {
  return exact.has(lowerName) || prefixes.some((prefix) => lowerName.startsWith(prefix))
}
