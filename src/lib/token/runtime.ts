/**
 * Token runtime — the composition root for the GitHub/Copilot auth lifecycle.
 *
 * A `TokenRuntime` OWNS the process's `GitHubTokenManager` +
 * `CopilotTokenManager` instances and exposes a narrow operation API
 * (initialize / accessors / ensure-valid / dispose). It replaces the scattered
 * module-global manager pair that used to live in `lifecycle.ts`.
 *
 * Cutover DAG:
 *   - C3 (this commit): establish the seam. `createTokenRuntime()` wraps
 *     managers that still read global `~/lib/state`, `~/lib/config/paths` and
 *     `~/lib/transport/upstream-fetch` directly. `lifecycle.ts` is reduced to
 *     thin façades over a single runtime instance, so no consumer changes.
 *   - C4: add `TokenRuntimeDependencies` (fetch / paths / runtime-config) to
 *     this factory, install the runtime as a process singleton, and converge
 *     every construction chain + lifecycle-op consumer onto it.
 *   - C5: reverse token-store ownership into this package.
 */

import consola from "consola"

import {
  //
  setGitHubToken,
  setTokenState,
} from "~/lib/state"
import { getTokenReadView } from "~/lib/state-readers/token"
import { writeSensitiveOnce } from "~/lib/tui/sensitive-output"

import { CopilotTokenManager } from "./copilot-token-manager"
import { getGitHubUser } from "./github-client"
import { GitHubTokenManager } from "./github-token-manager"

export interface InitTokenManagersOptions {
  /** Token provided via CLI --github-token argument */
  cliToken?: string
}

/** The manager pair produced by {@link TokenRuntime.initialize}. */
export interface TokenRuntimeManagers {
  githubTokenManager: GitHubTokenManager
  copilotTokenManager: CopilotTokenManager
}

/**
 * The token domain's single owner of the GitHub/Copilot auth lifecycle.
 *
 * Request- and shutdown-time consumers operate on ONE runtime instance rather
 * than constructing a fresh manager or reaching a module-global — this is what
 * lets the token domain later become a package with an explicit assembly entry point.
 */
export interface TokenRuntime {
  /** Run the full init flow (GitHub token → user check → Copilot token) and start auto-refresh. */
  initialize(options?: InitTokenManagersOptions): Promise<TokenRuntimeManagers>
  /** The owned GitHub token manager, or null before {@link initialize}. */
  getGitHubTokenManager(): GitHubTokenManager | null
  /** The owned Copilot token manager, or null before {@link initialize}. */
  getCopilotTokenManager(): CopilotTokenManager | null
  /** Request-time proactive validity check (server middleware). No-op before init. */
  ensureValidCopilotToken(): Promise<void>
  /** Stop auto-refresh + release owned managers. Idempotent; safe before init. */
  dispose(): Promise<void>
}

class TokenRuntimeImpl implements TokenRuntime {
  private githubTokenManager: GitHubTokenManager | null = null
  private copilotTokenManager: CopilotTokenManager | null = null

  async initialize(options: InitTokenManagersOptions = {}): Promise<TokenRuntimeManagers> {
    // Create GitHub token manager
    const githubTokenManager = new GitHubTokenManager({
      cliToken: options.cliToken,
      validateOnInit: false, // We'll validate manually to show login info
      onTokenExpired: () => {
        consola.error("GitHub token has expired. Please run `copilot-api auth` to re-authenticate.")
      },
    })
    this.githubTokenManager = githubTokenManager

    // Get GitHub token
    const tokenInfo = await githubTokenManager.getToken()
    setGitHubToken(tokenInfo.token)
    setTokenState({ tokenInfo })

    // Log token source
    const isExplicitToken = tokenInfo.source === "cli" || tokenInfo.source === "env"
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
    if (getTokenReadView().showGitHubToken && !writeSensitiveOnce("github-token", "GitHub token", tokenInfo.token)) {
      consola.warn("GitHub token display requested, but no healthy interactive terminal is available")
    }

    // Validate and show user info
    // If the token was explicitly provided (CLI or env), give a clear error and abort on failure
    try {
      const user = await getGitHubUser()
      consola.info(`Logged in as ${user.login}`)
    } catch (error) {
      if (isExplicitToken) {
        const source = tokenInfo.source === "cli" ? "--github-token" : "environment variable"
        consola.error(`The GitHub token provided via ${source} is invalid or expired.`, error instanceof Error ? error.message : error)
        process.exit(1)
      }
      throw error
    }

    // Create Copilot token manager
    const copilotTokenManager = new CopilotTokenManager({
      githubTokenManager,
    })
    this.copilotTokenManager = copilotTokenManager

    // Initialize Copilot token
    // If the token was explicitly provided and Copilot rejects it, abort with clear error
    try {
      const copilotTokenInfo = await copilotTokenManager.initialize()
      setTokenState({ copilotTokenInfo })
    } catch (error) {
      if (isExplicitToken) {
        const source = tokenInfo.source === "cli" ? "--github-token" : "environment variable"
        consola.error(`The GitHub token provided via ${source} does not have Copilot access.`, error instanceof Error ? error.message : error)
        process.exit(1)
      }
      throw error
    }

    return { githubTokenManager, copilotTokenManager }
  }

  getGitHubTokenManager(): GitHubTokenManager | null {
    return this.githubTokenManager
  }

  getCopilotTokenManager(): CopilotTokenManager | null {
    return this.copilotTokenManager
  }

  async ensureValidCopilotToken(): Promise<void> {
    await this.copilotTokenManager?.ensureValidToken()
  }

  async dispose(): Promise<void> {
    this.copilotTokenManager?.stopAutoRefresh()
    this.copilotTokenManager = null
    this.githubTokenManager = null
  }
}

/**
 * Construct a token runtime. In C3 this takes no dependencies (the managers
 * still read globals); C4 adds a `TokenRuntimeDependencies` parameter and
 * threads fetch/paths/runtime-config injection through here.
 */
export function createTokenRuntime(): TokenRuntime {
  return new TokenRuntimeImpl()
}
