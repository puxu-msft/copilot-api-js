/**
 * Token domain injected dependencies — the token package's external ports.
 *
 * The token domain must not import core modules directly (`~/lib/transport/*`,
 * `~/lib/config/paths`, …) or it could never become a leaf package. Instead the
 * composition root (a core-side assembly module) adapts core primitives into
 * these role interfaces and installs them here; the token package's HTTP clients
 * and file provider read the installed ports via {@link getTokenDeps}.
 *
 * This mirrors the transport layer's own `activeUpstreamFetch` seam: a single
 * live indirection set once by the owner. Because the installed `fetch` is a
 * thin adapter over the live `upstreamFetch` function (which itself reads its
 * test seam at call time), every existing upstream-fetch mock keeps flowing
 * through unchanged.
 */

/** Request init accepted by {@link TokenFetch} — the subset the token clients use. */
export interface TokenFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/**
 * The token domain's HTTP transport port. The assembly layer adapts
 * `upstreamFetch` to this; tests inherit the same adapter through the floor.
 */
export type TokenFetch = (url: string, init: TokenFetchInit) => Promise<Response>

/** Where the token domain persists the GitHub token (assembly adapts `PATHS`). */
export interface TokenPersistencePaths {
  readonly githubTokenPath: string
}

/**
 * Core-owned runtime config the token domain reads but does NOT own — injected
 * as a LIVE view (each getter reads current core state) so config hot-reload of
 * `showGitHubToken` / `vsCodeVersion` is honoured on the next read.
 */
export interface TokenRuntimeConfigView {
  readonly showGitHubToken: boolean
  /** VS Code version advertised in upstream GitHub/Copilot request headers. */
  readonly vsCodeVersion?: string
}

/** The full set of ports the token runtime needs from its host. */
export interface TokenRuntimeDependencies {
  readonly fetch: TokenFetch
  readonly paths: TokenPersistencePaths
  readonly runtimeConfig: TokenRuntimeConfigView
}

let installed: TokenRuntimeDependencies | null = null

/**
 * Install the token domain's ports. Called by the composition root (production)
 * and the test floor. Idempotent overwrite — the ports are stateless adapters,
 * so last-writer-wins is safe (unlike the runtime singleton, which guards
 * against two owners).
 */
export function installTokenDeps(deps: TokenRuntimeDependencies): void {
  installed = deps
}

/** Read the installed ports, failing fast if the host never installed them. */
export function getTokenDeps(): TokenRuntimeDependencies {
  if (!installed) {
    throw new Error("Token dependencies not installed — the composition root must call installTokenDeps() before any token HTTP call")
  }
  return installed
}
