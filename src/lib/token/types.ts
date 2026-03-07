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
 * Copilot token information with expiration details.
 *
 * Preserves the full raw API response alongside extracted fields
 * for convenient access (principle: data flows in its richest form).
 */
export interface CopilotTokenInfo {
  /** The Copilot token string */
  token: string
  /** Unix timestamp when the token expires */
  expiresAt: number
  /** Seconds until refresh is needed (server-recommended interval) */
  refreshIn: number
  /** Full raw response from the Copilot token API, for future consumers */
  raw: Record<string, unknown>
}
