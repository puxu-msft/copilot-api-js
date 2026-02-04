export {
  CopilotTokenManager,
  type CopilotTokenManagerOptions,
} from "./copilot-token-manager"

// Managers
export {
  GitHubTokenManager,
  type GitHubTokenManagerOptions,
} from "./github-token-manager"
// Providers
export { GitHubTokenProvider } from "./providers/base"
export { CLITokenProvider } from "./providers/cli"
export { DeviceAuthProvider } from "./providers/device-auth"
export { EnvTokenProvider } from "./providers/env"

export { FileTokenProvider } from "./providers/file"
// Types
export type {
  CopilotTokenInfo,
  TokenInfo,
  TokenSource,
  TokenValidationResult,
} from "./types"

import consola from "consola"

import { state } from "~/lib/state"
import { getGitHubUser } from "~/services/github/get-user"

import { CopilotTokenManager } from "./copilot-token-manager"
import { GitHubTokenManager } from "./github-token-manager"

// Global manager instances
let githubTokenManager: GitHubTokenManager | null = null
let copilotTokenManager: CopilotTokenManager | null = null

export interface InitTokenManagersOptions {
  /** Token provided via CLI --github-token argument */
  cliToken?: string
}

/**
 * Initialize the token management system.
 * This sets up both GitHub and Copilot token managers.
 */
export async function initTokenManagers(
  options: InitTokenManagersOptions = {},
): Promise<{
  githubTokenManager: GitHubTokenManager
  copilotTokenManager: CopilotTokenManager
}> {
  // Create GitHub token manager
  githubTokenManager = new GitHubTokenManager({
    cliToken: options.cliToken,
    validateOnInit: false, // We'll validate manually to show login info
    onTokenExpired: () => {
      consola.error(
        "GitHub token has expired. Please run `copilot-api auth` to re-authenticate.",
      )
    },
  })

  // Get GitHub token
  const tokenInfo = await githubTokenManager.getToken()
  state.githubToken = tokenInfo.token
  state.tokenInfo = tokenInfo

  // Log token source
  switch (tokenInfo.source) {
    case "cli": {
      consola.info("Using provided GitHub token (from CLI)")

      break
    }
    case "env": {
      consola.info("Using GitHub token from environment variable")

      break
    }
    case "file": {
      // File is the default, no need to log

      break
    }
    // No default
  }

  // Show token if configured
  if (state.showToken) {
    consola.info("GitHub token:", tokenInfo.token)
  }

  // Validate and show user info
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)

  // Create Copilot token manager
  copilotTokenManager = new CopilotTokenManager({
    githubTokenManager,
  })

  // Initialize Copilot token
  const copilotTokenInfo = await copilotTokenManager.initialize()
  // eslint-disable-next-line require-atomic-updates -- Sequential assignment after await
  state.copilotTokenInfo = copilotTokenInfo

  return { githubTokenManager, copilotTokenManager }
}

/**
 * Get the global GitHub token manager instance.
 */
export function getGitHubTokenManager(): GitHubTokenManager | null {
  return githubTokenManager
}

/**
 * Get the global Copilot token manager instance.
 */
export function getCopilotTokenManager(): CopilotTokenManager | null {
  return copilotTokenManager
}

/**
 * Stop all token refresh timers.
 * Call this during cleanup/shutdown.
 */
export function stopTokenRefresh(): void {
  copilotTokenManager?.stopAutoRefresh()
}

// Re-export for backwards compatibility with old token.ts
// These can be removed once all consumers are updated

/**
 * @deprecated Use initTokenManagers() instead
 */
export async function setupGitHubToken(options?: {
  force?: boolean
}): Promise<void> {
  if (options?.force) {
    // Force re-auth - clear cache and use device auth
    githubTokenManager?.clearCache()
  }

  await initTokenManagers()
}

/**
 * @deprecated Use initTokenManagers() instead
 */
export async function setupCopilotToken(): Promise<void> {
  // This is now handled by initTokenManagers
  if (!copilotTokenManager && githubTokenManager) {
    copilotTokenManager = new CopilotTokenManager({
      githubTokenManager,
    })
    await copilotTokenManager.initialize()
  }
}

/**
 * @deprecated Use stopTokenRefresh() instead
 */
export function clearCopilotTokenRefresh(): void {
  stopTokenRefresh()
}
