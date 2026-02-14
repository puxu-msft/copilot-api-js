import { state } from "~/lib/state"
import { getGitHubUser } from "~/lib/token/github-client"

import type { TokenInfo, TokenValidationResult } from "../types"

/**
 * Abstract base class for GitHub token providers.
 * Each provider represents a different source of GitHub tokens.
 */
export abstract class GitHubTokenProvider {
  /** Human-readable name of the provider */
  abstract readonly name: string

  /** Priority (lower = higher priority, tried first) */
  abstract readonly priority: number

  /** Whether this provider can refresh tokens */
  abstract readonly refreshable: boolean

  /**
   * Check if this provider is available (has required configuration).
   * For example, CLI provider is only available if token was passed via args.
   */
  abstract isAvailable(): boolean | Promise<boolean>

  /**
   * Get the token from this provider.
   * Returns null if not available or token cannot be obtained.
   */
  abstract getToken(): Promise<TokenInfo | null>

  /**
   * Refresh the token (if supported).
   * Default implementation returns null (not supported).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async refresh(): Promise<TokenInfo | null> {
    return null
  }

  /**
   * Validate the token by calling GitHub API.
   * Returns validation result with username if successful.
   */
  async validate(token: string): Promise<TokenValidationResult> {
    // Temporarily set the token to validate
    const originalToken = state.githubToken

    try {
      state.githubToken = token
      const user = await getGitHubUser()
      return {
        valid: true,
        username: user.login,
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      // Restore original token
      state.githubToken = originalToken
    }
  }
}
