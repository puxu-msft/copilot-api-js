/**
 * Token manager lifecycle — legacy façades over a single {@link TokenRuntime}.
 *
 * These module-level functions are the historical public surface
 * (`initTokenManagers` / `getGitHubTokenManager` / `getCopilotTokenManager` /
 * `stopTokenRefresh` / `ensureValidCopilotToken`). They now delegate to one
 * process-wide runtime instance owned here, so there is still exactly one
 * `GitHubTokenManager` + `CopilotTokenManager` pair.
 *
 * C4 replaces these façades with an installed `TokenRuntime` singleton read via
 * `getTokenRuntime()` at every construction chain and lifecycle-op consumer, at
 * which point the module-level escape exports below are deleted. Until then this
 * file bridges old callers onto the new runtime without changing any consumer.
 */

import type { CopilotTokenManager } from "./copilot-token-manager"
import type { GitHubTokenManager } from "./github-token-manager"
import type {
  //
  InitTokenManagersOptions,
  TokenRuntime,
} from "./runtime"

import { createTokenRuntime } from "./runtime"

export type { InitTokenManagersOptions } from "./runtime"

/** The single process-wide runtime the façades delegate to. */
const runtime: TokenRuntime = createTokenRuntime()

/**
 * Initialize the token management system.
 * This sets up both GitHub and Copilot token managers.
 */
export async function initTokenManagers(options: InitTokenManagersOptions = {}): Promise<{
  githubTokenManager: GitHubTokenManager
  copilotTokenManager: CopilotTokenManager
}> {
  return runtime.initialize(options)
}

/**
 * Get the global GitHub token manager instance.
 */
export function getGitHubTokenManager(): GitHubTokenManager | null {
  return runtime.getGitHubTokenManager()
}

/**
 * Get the global Copilot token manager instance.
 */
export function getCopilotTokenManager(): CopilotTokenManager | null {
  return runtime.getCopilotTokenManager()
}

/**
 * Stop all token refresh timers.
 * Call this during cleanup/shutdown.
 */
export function stopTokenRefresh(): void {
  void runtime.dispose()
}

/**
 * Proactively ensure the Copilot token is valid.
 * Triggers a refresh if the token is expired/expiring or the last
 * background refresh failed. No-op if the manager is not initialized.
 */
export async function ensureValidCopilotToken(): Promise<void> {
  await runtime.ensureValidCopilotToken()
}
