/**
 * Composition root for the token domain — the core-side assembly module that
 * adapts core primitives into the token package's injected ports and owns the
 * process-singleton {@link TokenRuntime}.
 *
 * The token package must not import core (`~/lib/transport/*`,
 * `~/lib/config/paths`, `~/lib/state`) or it could never become a leaf package.
 * This module lives in CORE and bridges the two: it builds a
 * {@link TokenRuntimeDependencies} from `upstreamFetch` (transport),
 * `PATHS.GITHUB_TOKEN_PATH` (config) and a LIVE core-state view
 * (`showGitHubToken` / `vsCodeVersion`, owned by `setCliState` /
 * `setVSCodeVersion`), constructs the runtime, and installs it as the process
 * singleton read by every construction chain + lifecycle-op consumer.
 *
 * `installDefaultTokenRuntime()` is idempotent (returns the already-installed
 * runtime) so the multiple CLI commands + the test floor can call it freely.
 */

import { PATHS } from "~/lib/config/paths"
import { state } from "~/lib/state"
import {
  //
  createTokenRuntime,
  type InitTokenManagersOptions,
  installTokenDeps,
  installTokenRuntime,
  peekTokenRuntime,
  type TokenFetch,
  type TokenPersistencePaths,
  type TokenRuntime,
  type TokenRuntimeConfigView,
  type TokenRuntimeDependencies,
  type TokenRuntimeManagers,
} from "~/lib/token"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

/** Adapt `upstreamFetch` (the live transport indirection, incl. its test seam) to the token port. */
const tokenFetch: TokenFetch = (url, init) => upstreamFetch(url, init)

/** The token-file path port, read from core `PATHS`. */
const tokenPaths: TokenPersistencePaths = {
  get githubTokenPath(): string {
    return PATHS.GITHUB_TOKEN_PATH
  },
}

/** Live core-state view of the config the token domain reads but does not own. */
const runtimeConfig: TokenRuntimeConfigView = {
  get showGitHubToken(): boolean {
    return state.showGitHubToken
  },
  get vsCodeVersion(): string | undefined {
    return state.vsCodeVersion
  },
}

/** The full dependency set the token runtime is constructed from. */
export function buildTokenRuntimeDependencies(): TokenRuntimeDependencies {
  return { fetch: tokenFetch, paths: tokenPaths, runtimeConfig }
}

/**
 * Install ONLY the token domain's ambient ports (fetch/paths/config) without a
 * runtime singleton. Used by the test floor so free HTTP functions
 * (`getCopilotToken`, `getGitHubUser`, …) resolve their transport even in tests
 * that never assemble a runtime. Production installs these via
 * {@link installDefaultTokenRuntime}.
 */
export function installDefaultTokenDeps(): void {
  installTokenDeps(buildTokenRuntimeDependencies())
}

/**
 * Construct and install the default token runtime (idempotent). Returns the
 * installed singleton — call it from every process entry point (CLI commands,
 * server bootstrap, test floor) before any token operation.
 */
export function installDefaultTokenRuntime(): TokenRuntime {
  const existing = peekTokenRuntime()
  if (existing) return existing

  const runtime = createTokenRuntime(buildTokenRuntimeDependencies())
  installTokenRuntime(runtime)
  return runtime
}

/**
 * Install the default token runtime (if needed) and run the full init flow.
 * The one-line entry point for the `start` / `setup-*` CLI construction chains —
 * replaces the old module-global `initTokenManagers`.
 */
export function initTokenManagers(options: InitTokenManagersOptions = {}): Promise<TokenRuntimeManagers> {
  return installDefaultTokenRuntime().initialize(options)
}
