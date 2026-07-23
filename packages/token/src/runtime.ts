/**
 * Token runtime — the composition root for the GitHub/Copilot auth lifecycle.
 *
 * A `TokenRuntime` OWNS the process's `GitHubTokenManager` +
 * `CopilotTokenManager` instances and exposes a narrow operation API
 * (initialize / acquire / usage / user / ensure-valid / refresh / dispose). It
 * is constructed once from injected {@link TokenRuntimeDependencies} and
 * installed as a process singleton; every construction chain (CLI commands) and
 * every request/shutdown-time consumer reads THAT SAME instance rather than
 * constructing a fresh manager or reaching a module-global.
 *
 * The runtime itself holds no `~/lib/*` import: its dependencies (fetch, paths,
 * live runtime-config view) are injected by a core-side assembly module and
 * installed into the ambient {@link installTokenDeps} port so the token
 * package's HTTP clients and file provider see them too.
 */

import { writeSensitiveOnce } from "@hsupu/ghc-proxy-foundation/sensitive-output"
import consola from "consola"

import type { CopilotUsageResponse } from "./copilot-client"
import type { GitHubUser } from "./github-client"
import type { TokenInfo } from "./types"

import {
  //
  getCopilotToken,
  getCopilotUsage,
} from "./copilot-client"
import { CopilotTokenManager } from "./copilot-token-manager"
import {
  //
  setCopilotCredential,
  setGithubCredential,
  setTokenInfoCredential,
} from "./credentials"
import {
  //
  getTokenDeps,
  installTokenDeps,
  type TokenRuntimeDependencies,
} from "./dependencies"
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

/** Options for {@link TokenRuntime.acquireGitHubToken}. */
export interface AcquireGitHubTokenOptions {
  /** Token provided via CLI --github-token argument (highest-priority provider). */
  cliToken?: string
  /** Force interactive device authorization, ignoring cached/file/env tokens. */
  forceDeviceAuth?: boolean
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
  /**
   * Acquire a GitHub token WITHOUT the full init/refresh lifecycle (for the
   * `auth` and `debug` CLI paths). Sets the GitHub credential and returns the
   * token info. `forceDeviceAuth` forces the interactive device flow.
   */
  acquireGitHubToken(options?: AcquireGitHubTokenOptions): Promise<TokenInfo>
  /**
   * Fetch a Copilot token once and set the credential, WITHOUT starting the
   * auto-refresh timer (for the `debug models` path). Returns the token string.
   */
  acquireCopilotTokenOnce(): Promise<string>
  /** Fetch the current Copilot usage/quota snapshot. */
  getCopilotUsage(): Promise<CopilotUsageResponse>
  /** Fetch the authenticated GitHub user. */
  getGitHubUser(): Promise<GitHubUser>
  /** Request-time proactive validity check (server middleware). No-op before init. */
  ensureValidCopilotToken(): Promise<void>
  /** Refresh the Copilot token (retry strategy). Returns true on success, false if unavailable/failed. */
  refreshCopilotToken(): Promise<boolean>
  /** Stop auto-refresh + release owned managers. Idempotent; safe before init. */
  dispose(): Promise<void>
}

class TokenRuntimeImpl implements TokenRuntime {
  private githubTokenManager: GitHubTokenManager | null = null
  private copilotTokenManager: CopilotTokenManager | null = null

  private ensureGitHubTokenManager(options: { cliToken?: string } = {}): GitHubTokenManager {
    if (!this.githubTokenManager) {
      this.githubTokenManager = new GitHubTokenManager({
        cliToken: options.cliToken,
        validateOnInit: false, // We'll validate manually to show login info
        onTokenExpired: () => {
          consola.error("GitHub token has expired. Please run `copilot-api auth` to re-authenticate.")
        },
      })
    }
    return this.githubTokenManager
  }

  async initialize(options: InitTokenManagersOptions = {}): Promise<TokenRuntimeManagers> {
    // Create GitHub token manager
    const githubTokenManager = this.ensureGitHubTokenManager({ cliToken: options.cliToken })

    // Get GitHub token
    const tokenInfo = await githubTokenManager.getToken()
    setGithubCredential(tokenInfo.token)
    setTokenInfoCredential({ tokenInfo })

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

    // Show token if configured (read the ambient runtime-config, the single
    // installed deps source — same view credentials.ts reads vsCodeVersion from).
    if (getTokenDeps().runtimeConfig.showGitHubToken && !writeSensitiveOnce("github-token", "GitHub token", tokenInfo.token)) {
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
      setTokenInfoCredential({ copilotTokenInfo })
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

  async acquireGitHubToken(options: AcquireGitHubTokenOptions = {}): Promise<TokenInfo> {
    const manager = this.ensureGitHubTokenManager({ cliToken: options.cliToken })
    const tokenInfo = options.forceDeviceAuth ? await manager.forceDeviceAuth() : await manager.getToken()
    setGithubCredential(tokenInfo.token)
    setTokenInfoCredential({ tokenInfo })
    return tokenInfo
  }

  async acquireCopilotTokenOnce(): Promise<string> {
    const { token } = await getCopilotToken()
    setCopilotCredential(token)
    return token
  }

  async getCopilotUsage(): Promise<CopilotUsageResponse> {
    return getCopilotUsage()
  }

  async getGitHubUser(): Promise<GitHubUser> {
    return getGitHubUser()
  }

  async ensureValidCopilotToken(): Promise<void> {
    await this.copilotTokenManager?.ensureValidToken()
  }

  async refreshCopilotToken(): Promise<boolean> {
    if (!this.copilotTokenManager) return false
    const result = await this.copilotTokenManager.refresh()
    return result !== null
  }

  async dispose(): Promise<void> {
    await this.copilotTokenManager?.dispose()
    this.copilotTokenManager = null
    this.githubTokenManager = null
  }
}

/**
 * Construct a token runtime from its injected dependencies and install those
 * dependencies into the ambient port so the token package's HTTP clients + file
 * provider read the same fetch/paths/config.
 */
export function createTokenRuntime(deps: TokenRuntimeDependencies): TokenRuntime {
  installTokenDeps(deps)
  return new TokenRuntimeImpl()
}

// ============================================================================
// Process-singleton lifecycle
// ============================================================================

let installedRuntime: TokenRuntime | null = null

/**
 * Install the process-singleton token runtime. Installing over a LIVE runtime
 * throws (prevents two owners) — the caller must `dispose()` the previous one
 * first. Tests clear it via {@link resetTokenRuntimeForTests}.
 */
export function installTokenRuntime(runtime: TokenRuntime): void {
  if (installedRuntime) {
    throw new Error("A token runtime is already installed; dispose it before installing another")
  }
  installedRuntime = runtime
}

/**
 * Read the installed token runtime, failing fast if none is installed (no
 * silent module-global fallback — an uninstalled runtime is a wiring bug). Used
 * by CLI construction chains, which always assemble a runtime first.
 */
export function getTokenRuntime(): TokenRuntime {
  if (!installedRuntime) {
    throw new Error("Token runtime not installed — call installTokenRuntime() from the composition root first")
  }
  return installedRuntime
}

/**
 * Read the installed runtime WITHOUT throwing (null if none). Used by the
 * request/shutdown/retry consumers, whose pre-init no-op tolerance
 * (`manager ?? null`) is semantically correct and must not require every HTTP
 * test to assemble a dummy runtime.
 */
export function peekTokenRuntime(): TokenRuntime | null {
  return installedRuntime
}

/** Dispose the current runtime (stop timers) and clear the singleton. */
export async function resetTokenRuntimeForTests(): Promise<void> {
  await installedRuntime?.dispose()
  installedRuntime = null
}
