import consola from "consola"

import { state } from "~/lib/state"

import type { GitHubTokenManager } from "./github-token-manager"
import type { CopilotTokenInfo } from "./types"

import { getCopilotToken } from "./copilot-client"

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
 *
 * All refresh paths (scheduled + on-demand via 401) go through `refresh()`,
 * which deduplicates concurrent callers and reschedules the next refresh based
 * on the server's `refresh_in` value.
 */
export class CopilotTokenManager {
  private githubTokenManager: GitHubTokenManager
  private currentToken: CopilotTokenInfo | null = null
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null
  private minRefreshIntervalMs: number
  private maxRetries: number
  /** Shared promise to prevent concurrent refresh attempts */
  private refreshInFlight: Promise<CopilotTokenInfo | null> | null = null

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

    // Schedule first refresh based on server's refresh_in
    this.scheduleRefresh(tokenInfo.refreshIn)

    return tokenInfo
  }

  /**
   * Fetch a new Copilot token from the API.
   */
  private async fetchCopilotToken(): Promise<CopilotTokenInfo> {
    const response = await getCopilotToken()

    const tokenInfo: CopilotTokenInfo = {
      token: response.token,
      expiresAt: response.expires_at,
      refreshIn: response.refresh_in,
      raw: response,
    }

    this.currentToken = tokenInfo
    return tokenInfo
  }

  /**
   * Fetch a new Copilot token with exponential backoff retry.
   * Pure acquisition logic — does not update global state or reschedule timers.
   */
  private async fetchTokenWithRetry(): Promise<CopilotTokenInfo | null> {
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
   * Schedule the next refresh using setTimeout.
   *
   * Uses the server-provided `refresh_in` value each time, adapting to
   * changing token lifetimes. After each refresh, reschedules based on
   * the new token's `refresh_in`.
   */
  private scheduleRefresh(refreshInSeconds: number): void {
    // Sanity check: refresh_in should be positive and reasonable
    let effectiveRefreshIn = refreshInSeconds
    if (refreshInSeconds <= 0) {
      consola.warn(`[CopilotToken] Invalid refresh_in=${refreshInSeconds}s, using default 30 minutes`)
      effectiveRefreshIn = 1800 // 30 minutes
    }

    // Calculate delay (refresh a bit before expiration)
    const delayMs = Math.max((effectiveRefreshIn - 60) * 1000, this.minRefreshIntervalMs)

    consola.debug(
      `[CopilotToken] refresh_in=${effectiveRefreshIn}s, scheduling next refresh in ${Math.round(delayMs / 1000)}s`,
    )

    // Clear any existing timer
    this.cancelScheduledRefresh()

    this.refreshTimeout = setTimeout(() => {
      this.refresh().catch((error: unknown) => {
        consola.error("Unexpected error during scheduled token refresh:", error)
      })
    }, delayMs)
  }

  /**
   * Cancel the currently scheduled refresh.
   */
  private cancelScheduledRefresh(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout)
      this.refreshTimeout = null
    }
  }

  /**
   * Stop automatic token refresh.
   * Call this during cleanup/shutdown.
   */
  stopAutoRefresh(): void {
    this.cancelScheduledRefresh()
  }

  /**
   * Refresh the Copilot token.
   *
   * Single entry point for all refreshes — both scheduled and on-demand
   * (e.g. after a 401). Concurrent callers share the same in-flight refresh.
   * On success, updates global state and reschedules the next refresh based
   * on the new token's `refresh_in`.
   */
  async refresh(): Promise<CopilotTokenInfo | null> {
    // If a refresh is already in progress, piggyback on it
    if (this.refreshInFlight) {
      consola.debug("[CopilotToken] Refresh already in progress, waiting...")
      return this.refreshInFlight
    }

    this.refreshInFlight = this.fetchTokenWithRetry()
      .then((tokenInfo) => {
        if (tokenInfo) {
          state.copilotToken = tokenInfo.token
          // Reschedule based on new token's refresh_in
          this.scheduleRefresh(tokenInfo.refreshIn)
          consola.verbose(`[CopilotToken] Token refreshed (next refresh_in=${tokenInfo.refreshIn}s)`)
        } else {
          consola.error("[CopilotToken] Token refresh failed, keeping existing token")
          // Still reschedule with a fallback to avoid stopping the refresh loop entirely
          this.scheduleRefresh(300) // retry in 5 minutes
        }
        return tokenInfo
      })
      .finally(() => {
        this.refreshInFlight = null
      })

    return this.refreshInFlight
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
