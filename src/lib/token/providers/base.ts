import type {
  //
  TokenInfo,
  TokenValidationResult,
} from "../types"

import { withGitHubTokenForValidation } from "../credentials"
import { getGitHubUser } from "../github-client"

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

  async refresh(): Promise<TokenInfo | null> {
    return null
  }

  /**
   * Validate the token by calling GitHub API.
   * Returns validation result with username if successful.
   */
  async validate(token: string): Promise<TokenValidationResult> {
    try {
      // Temporarily swap in the token being validated, atomically w.r.t. other
      // validations and requests, so `getGitHubUser` authenticates as it.
      const user = await withGitHubTokenForValidation(token, () => getGitHubUser())
      return {
        valid: true,
        username: user.login,
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
