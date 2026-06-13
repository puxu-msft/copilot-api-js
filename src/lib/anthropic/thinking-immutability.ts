/**
 * Deprecated re-export shim. The real implementation moved to
 * `thinking-protection.ts` when the policy was simplified from three levels
 * (`stripped` / `immutable` / `fixed-index`) to two (`preserve` / `stripped`),
 * after empirical verification that Anthropic thinking signatures are
 * self-contained (encrypt the thinking content itself; no context/position
 * binding).
 *
 * No new code should import from this file — import from `./thinking-protection`
 * directly. This shim exists only to avoid breaking any importer we may have
 * missed; it can be removed once no `from "../thinking-immutability"` references
 * remain in the repo.
 */
export * from "./thinking-protection"
