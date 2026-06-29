/**
 * Generic glob-based header-name stripping primitive (format-agnostic).
 *
 * `pruneHeaders` removes headers whose *name* matches an operator glob (`*` `?`),
 * case-insensitive, while never dropping `PROTECTED_HEADERS`. Used as the strip
 * layer over the Anthropic request-header passthrough set
 * (`./request-header-forward.ts` → `buildAnthropicHeaders`).
 *
 * NOTE on PROTECTED_HEADERS reachability: in the Anthropic passthrough chain
 * (`pruneHeaders(selectPassthroughHeaders(client, coreLower), strip)`) these four
 * names are ALREADY removed before `pruneHeaders` runs — the core keys by
 * `coreLower`, `content-length` by the passthrough denylist — so the guard never
 * fires there. It is kept because `pruneHeaders` / `compileHeaderStrip` are
 * exported, independently-tested primitives: the guard is their self-contained
 * contract ("a glob never strips the proxy's own credentials"), robust to a
 * future direct caller or a reordered chain.
 */

/** Headers that must never be stripped, even if a glob matches them. */
const PROTECTED_HEADERS: ReadonlySet<string> = new Set(["authorization", "content-type", "content-length", "copilot-integration-id"])

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
