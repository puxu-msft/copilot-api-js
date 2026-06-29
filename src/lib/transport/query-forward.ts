/**
 * Client query-string forwarding filter (S4 upstream URL composition).
 *
 * The proxy forwards a client's inbound query string to the GHC upstream so
 * params like `?beta=true` reach the completion endpoint. A small built-in set
 * of keys is ALWAYS stripped — auth secrets that must never leak upstream/into
 * history, and params the proxy itself consumes (so forwarding them is wrong or
 * a no-op against the GHC endpoint, which is not the real provider).
 *
 * "Faithful" here is semantic, not byte-exact: `URLSearchParams` re-serialization
 * normalizes (`%20`→`+`, valueless `?flag`→`?flag=`), which a standard URL parser
 * (GHC) decodes to the same key/value set. History records the inbound `raw`
 * (verbatim) and the outbound `forwarded` (normalized) separately, so the
 * original form is never lost.
 */

/**
 * Query keys ALWAYS removed before forwarding upstream — the security/conflict
 * floor. Matched case-insensitively. Not overridable via config (auth keys must
 * stay stripped); config can only ADD more keys (see `filterUpstreamQuery`).
 */
export const UPSTREAM_QUERY_EXCLUDE: ReadonlySet<string> = new Set([
  "api-version", // Azure classic format intentionally ignores it; GHC is not real Azure (load-bearing — azure routes reuse the CC/Responses handlers)
  "key", // Gemini/OpenAI query-form API key — auth secret
  "access_token", // Google OAuth query credential — auth secret
  "alt", // Gemini stream flag (alt=sse) — the proxy decides streaming from the path method
])

/**
 * Filter a raw inbound query string for upstream forwarding.
 *
 * @param rawSearch  The inbound query string, with or without a leading `?`
 *                   (e.g. `c.req.url`'s search). Empty / `"?"` → `""`.
 * @param extraExclude  Additional keys to strip (config `forward_client_query_exclude`),
 *                   unioned with {@link UPSTREAM_QUERY_EXCLUDE}. Case-insensitive.
 * @returns The filtered query string WITH a leading `?` when non-empty, else `""`
 *          (so callers can append it directly to the endpoint path).
 */
export function filterUpstreamQuery(rawSearch: string, extraExclude?: ReadonlyArray<string>): string {
  if (!rawSearch || rawSearch === "?") return ""

  const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch)
  const exclude = extraExclude?.length ? new Set([...UPSTREAM_QUERY_EXCLUDE, ...extraExclude.map((k) => k.toLowerCase())]) : UPSTREAM_QUERY_EXCLUDE

  // URLSearchParams keys are case-sensitive; collect the original-cased keys whose
  // lowercased form is excluded, then delete (deleting while iterating is unsafe).
  const keysToDelete = new Set<string>()
  for (const key of params.keys()) {
    if (exclude.has(key.toLowerCase())) keysToDelete.add(key)
  }
  for (const key of keysToDelete) params.delete(key)

  const out = params.toString()
  return out ? `?${out}` : ""
}
