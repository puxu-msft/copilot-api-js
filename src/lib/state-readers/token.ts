import { state } from "~/lib/state"

/**
 * Narrow read-view of the token domain's slice of global {@link state}.
 *
 * Consumers in the token domain depend on THIS view interface instead of the
 * whole `State` god-object, so the token domain can later be peeled out of the
 * core SCC / into its own package against a small structural contract rather
 * than a 50-field interface (spec docs/spec/2026-07-22-monorepo-workspace-split.md
 * §5, Phase 0d).
 *
 * **Why a view interface, not bare getters / positional args**: adding a field
 * a consumer needs is a one-line addition here — every `getTokenReadView()`
 * call site is unchanged (structural typing). Bare `getX()` getters or
 * positional helper params (`fn(a, b)`) would break every call site on each new
 * field and lose richest-data-flow (context flows as an object; the end
 * consumer reads what it needs). Writes stay on state.ts's named setters
 * (`setGitHubToken`, `setCopilotToken`, `setTokenState`) — this seam is
 * read-only.
 */
export interface TokenReadView {
  readonly githubToken?: string
  readonly showGitHubToken: boolean
  /** VS Code version advertised in upstream GitHub/Copilot request headers. */
  readonly vsCodeVersion?: string
}

/**
 * Live narrow view over the mutable `state` singleton — structural typing means
 * this is a zero-copy, always-current projection (returning `state` directly is
 * safe because `State` structurally satisfies the narrower `TokenReadView`, and
 * the return type hides every field outside the view from consumers).
 */
export function getTokenReadView(): TokenReadView {
  return state
}
