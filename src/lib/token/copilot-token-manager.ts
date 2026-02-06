import consola from "consola"

import { state } from "~/lib/state"
import { getCopilotToken } from "~/services/github/get-copilot-token"

import type { GitHubTokenManager } from "./github-token-manager"
import type { CopilotTokenInfo } from "./types"

export interface CopilotTokenManagerOptions {
  /** GitHub token manager instance */
  githubTokenManager: GitHubTokenManager
  /** Minimum refresh interval in seconds (default: 60) */
  minRefreshIntervalSeconds?: number
  /** Maximum retries for token refresh (default: 3) */
  maxRetries?: number
}

/**
 * Manages Copilot token lifecycle including automatic refresh.
 * Depends on GitHubTokenManager for authentication.
 */
export class CopilotTokenManager {
  private githubTokenManager: GitHubTokenManager
  private currentToken: CopilotTokenInfo | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private minRefreshIntervalMs: number
  private maxRetries: number

  constructor(options: CopilotTokenManagerOptions) {
    this.githubTokenManager = options.githubTokenManager
    this.minRefreshIntervalMs = (options.minRefreshIntervalSeconds ?? 60) * 1000
    this.maxRetries = options.maxRetries ?? 3
  }

  /**
   * Get the current Copilot token info.
   */
  getCurrentToken(): CopilotTokenInfo | null {
    return this.currentToken
  }

  /**
   * Initialize the Copilot token and start automatic refresh.
   */
  async initialize(): Promise<CopilotTokenInfo> {
    const tokenInfo = await this.fetchCopilotToken()

    // Update global state
    state.copilotToken = tokenInfo.token

    // Show token in verbose mode
    consola.debug("GitHub Copilot Token fetched successfully!")

    // Start automatic refresh
    this.startAutoRefresh(tokenInfo.refreshIn)

    return tokenInfo
  }

  /**
   * Fetch a new Copilot token from the API.
   */
  private async fetchCopilotToken(): Promise<CopilotTokenInfo> {
    const { token, expires_at, refresh_in } = await getCopilotToken()

    const tokenInfo: CopilotTokenInfo = {
      token,
      expiresAt: expires_at,
      refreshIn: refresh_in,
    }

    this.currentToken = tokenInfo
    return tokenInfo
  }

  /**
   * Refresh the Copilot token with exponential backoff retry.
   */
  private async refreshWithRetry(): Promise<CopilotTokenInfo | null> {
    let lastError: unknown = null

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.fetchCopilotToken()
      } catch (error) {
        lastError = error

        // Check if this is a 401 error - might need to refresh GitHub token
        if (this.isUnauthorizedError(error)) {
          consola.warn("Copilot token refresh got 401, trying to refresh GitHub token...")
          const newGithubToken = await this.githubTokenManager.refresh()
          if (newGithubToken) {
            // Update state and retry
            state.githubToken = newGithubToken.token
            continue
          }
        }

        const delay = Math.min(1000 * 2 ** attempt, 30000) // Max 30s delay
        consola.warn(`Token refresh attempt ${attempt + 1}/${this.maxRetries} failed, retrying in ${delay}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    consola.error("All token refresh attempts failed:", lastError)
    return null
  }

  /**
   * Check if an error is a 401 Unauthorized error.
   */
  private isUnauthorizedError(error: unknown): boolean {
    if (error && typeof error === "object" && "status" in error) {
      return (error as { status: number }).status === 401
    }
    return false
  }

  /**
   * Start automatic token refresh.
   */
  private startAutoRefresh(refreshInSeconds: number): void {
    // Sanity check: refresh_in should be positive and reasonable
    let effectiveRefreshIn = refreshInSeconds
    if (refreshInSeconds <= 0) {
      consola.warn(`[CopilotToken] Invalid refresh_in=${refreshInSeconds}s, using default 30 minutes`)
      effectiveRefreshIn = 1800 // 30 minutes
    }

    // Calculate refresh interval (refresh a bit before expiration)
    const refreshInterval = Math.max((effectiveRefreshIn - 60) * 1000, this.minRefreshIntervalMs)

    consola.debug(
      `[CopilotToken] refresh_in=${effectiveRefreshIn}s, scheduling refresh every ${Math.round(refreshInterval / 1000)}s`,
    )

    // Clear any existing timer
    this.stopAutoRefresh()

    this.refreshTimer = setInterval(() => {
      consola.debug("Refreshing Copilot token...")

      this.refreshWithRetry()
        .then((newToken) => {
          if (newToken) {
            state.copilotToken = newToken.token
            consola.debug(`Copilot token refreshed (next refresh_in=${newToken.refreshIn}s)`)
          } else {
            consola.error("Failed to refresh Copilot token after retries, using existing token")
          }
        })
        .catch((error: unknown) => {
          consola.error("Unexpected error during token refresh:", error)
        })
    }, refreshInterval)
  }

  /**
   * Stop automatic token refresh.
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * Force an immediate token refresh.
   */
  async forceRefresh(): Promise<CopilotTokenInfo | null> {
    const tokenInfo = await this.refreshWithRetry()
    if (tokenInfo) {
      state.copilotToken = tokenInfo.token
      consola.debug("Force-refreshed Copilot token")
    }
    return tokenInfo
  }

  /**
   * Check if the current token is expired or about to expire.
   */
  isExpiredOrExpiring(marginSeconds = 60): boolean {
    if (!this.currentToken) {
      return true
    }

    const now = Date.now() / 1000
    return this.currentToken.expiresAt - marginSeconds <= now
  }
}
