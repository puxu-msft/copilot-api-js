/**
 * Token source types
 */
export type TokenSource =
  | "cli" // --github-token parameter
  | "env" // GITHUB_TOKEN environment variable
  | "file" // File storage (~/.local/share/copilot-api/github_token)
  | "device-auth" // Device authorization flow

/**
 * Token information with metadata
 */
export interface TokenInfo {
  /** The token string */
  token: string
  /** Where the token came from */
  source: TokenSource
  /** Unix timestamp when the token expires (if known) */
  expiresAt?: number
  /** Whether this token can be refreshed */
  refreshable: boolean
}

/**
 * Result of token validation
 */
export interface TokenValidationResult {
  /** Whether the token is valid */
  valid: boolean
  /** Error message if invalid */
  error?: string
  /** GitHub username if valid */
  username?: string
}

/**
 * Copilot token information with expiration details
 */
export interface CopilotTokenInfo {
  /** The Copilot token string */
  token: string
  /** Unix timestamp when the token expires */
  expiresAt: number
  /** Seconds until refresh is needed */
  refreshIn: number
}
