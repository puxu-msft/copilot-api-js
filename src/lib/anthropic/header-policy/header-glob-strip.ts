/**
 * Generic glob-based header-name filtering primitives (format-agnostic).
 *
 * Two duals over the Anthropic request-header passthrough set
 * (`./request-header-forward.ts` → `buildAnthropicHeaders`), selected by mode:
 *   - `pruneHeaders` (BLACKLIST mode, `strict_request_headers: false`): drops
 *     headers whose *name* matches an operator glob (`request_header_blacklist`),
 *     never dropping `PROTECTED_HEADERS`.
 *   - `keepHeaders` (WHITELIST mode, `strict_request_headers: true`): keeps ONLY
 *     headers whose name matches an operator glob (`request_header_whitelist`).
 *
 * Both are case-insensitive and never mutate input. The empty-pattern semantics
 * are deliberately MIRROR-OPPOSITE: `pruneHeaders([])` keeps everything (strip
 * nothing), `keepHeaders([])` keeps NOTHING (allow nothing → only the proxy core
 * headers survive the `{...selected, ...core}` merge).
 *
 * NOTE on PROTECTED_HEADERS reachability: in the Anthropic passthrough chain
 * (`pruneHeaders(selectPassthroughHeaders(client, coreLower), blacklist)`) these
 * four names are ALREADY removed before `pruneHeaders` runs — the core keys by
 * `coreLower`, `content-length` by the passthrough denylist — so the guard never
 * fires there. It is kept because these primitives are exported, independently-
 * tested contracts ("a glob never strips the proxy's own credentials"), robust to
 * a future direct caller or a reordered chain. `keepHeaders` needs no such guard:
 * it is an intersection (whitelist ∩ already-safe set), and the proxy core is
 * re-injected by the `{...selected, ...core}` merge regardless.
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

/**
 * Compile patterns into an allow-predicate; returns null when nothing is allowed.
 * MIRROR-OPPOSITE of `compileHeaderStrip`: an empty pattern list compiles to
 * `null` here too, but the `null` is interpreted by `keepHeaders` as "allow
 * nothing" (vs `pruneHeaders`' "strip nothing"). No PROTECTED_HEADERS logic —
 * keep is an intersection, and the proxy core is re-injected downstream.
 */
export function compileHeaderAllow(patterns: ReadonlyArray<string>): ((name: string) => boolean) | null {
  const globs = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => globToRegExp(p))
  if (globs.length === 0) return null
  return (name: string) => globs.some((g) => g.test(name))
}

/**
 * Return a new header map keeping ONLY names that match an allow glob. Never
 * mutates input. Empty/blank pattern list → `{}` (allow nothing) — the deliberate
 * mirror-opposite of `pruneHeaders([])` (keep everything).
 */
export function keepHeaders(headers: Record<string, string>, patterns: ReadonlyArray<string>): Record<string, string> {
  const isAllowed = compileHeaderAllow(patterns)
  if (!isAllowed) return {}
  return Object.fromEntries(Object.entries(headers).filter(([name]) => isAllowed(name)))
}
