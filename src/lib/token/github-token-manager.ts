import consola from "consola"

import type { GitHubTokenProvider } from "./providers/base"
import type { TokenInfo, TokenValidationResult } from "./types"

import { CLITokenProvider } from "./providers/cli"
import { DeviceAuthProvider } from "./providers/device-auth"
import { EnvTokenProvider } from "./providers/env"
import { FileTokenProvider } from "./providers/file"

export interface GitHubTokenManagerOptions {
  /** Token provided via CLI --github-token argument */
  cliToken?: string
  /** Whether to validate tokens before use */
  validateOnInit?: boolean
  /** Callback when token expires and cannot be refreshed */
  onTokenExpired?: () => void
}

/**
 * Manages GitHub token acquisition from multiple providers.
 * Providers are tried in priority order until one succeeds.
 */
export class GitHubTokenManager {
  private providers: Array<GitHubTokenProvider> = []
  private currentToken: TokenInfo | null = null
  private onTokenExpired?: () => void
  private validateOnInit: boolean

  constructor(options: GitHubTokenManagerOptions = {}) {
    this.validateOnInit = options.validateOnInit ?? false
    this.onTokenExpired = options.onTokenExpired

    // Initialize providers in priority order
    // Note: GhCliTokenProvider is NOT included because GitHub CLI tokens
    // are obtained via a different OAuth app and cannot access Copilot internal APIs.
    this.providers = [
      new CLITokenProvider(options.cliToken),
      new EnvTokenProvider(),
      new FileTokenProvider(),
      new DeviceAuthProvider(),
    ]

    // Sort by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority)
  }

  /**
   * Get the current token info (without fetching a new one).
   */
  getCurrentToken(): TokenInfo | null {
    return this.currentToken
  }

  /**
   * Get a GitHub token, trying providers in priority order.
   * Caches the result for subsequent calls.
   */
  async getToken(): Promise<TokenInfo> {
    // Return cached token if available
    if (this.currentToken) {
      return this.currentToken
    }

    for (const provider of this.providers) {
      if (!(await provider.isAvailable())) {
        continue
      }

      consola.debug(`Trying ${provider.name} token provider...`)

      const tokenInfo = await provider.getToken()
      if (!tokenInfo) {
        continue
      }

      // Optionally validate the token
      if (this.validateOnInit) {
        const validation = await this.validateToken(tokenInfo.token, provider)
        if (!validation.valid) {
          consola.warn(`Token from ${provider.name} provider is invalid: ${validation.error}`)
          continue
        }
        consola.info(`Logged in as ${validation.username}`)
      }

      consola.debug(`Using token from ${provider.name} provider`)
      this.currentToken = tokenInfo
      return tokenInfo
    }

    throw new Error("No valid GitHub token available from any provider")
  }

  /**
   * Validate a token using a provider's validate method.
   */
  async validateToken(token: string, provider?: GitHubTokenProvider): Promise<TokenValidationResult> {
    const p = provider ?? this.providers[0]
    return p.validate(token)
  }

  /**
   * Force refresh the current token.
   * Only works if the current token source supports refresh.
   * For non-refreshable sources (CLI, env), this will call onTokenExpired.
   */
  async refresh(): Promise<TokenInfo | null> {
    if (!this.currentToken) {
      // No current token, get a new one
      return this.getToken()
    }

    // Check if current token source is refreshable
    if (!this.currentToken.refreshable) {
      consola.warn(`Current token from ${this.currentToken.source} cannot be refreshed`)
      this.onTokenExpired?.()
      return null
    }

    // Find the device auth provider for refresh
    const deviceAuthProvider = this.providers.find((p) => p instanceof DeviceAuthProvider)
    if (!deviceAuthProvider) {
      consola.warn("No provider supports token refresh")
      this.onTokenExpired?.()
      return null
    }

    const newToken = await deviceAuthProvider.refresh()
    if (newToken) {
      this.currentToken = newToken
      return newToken
    }

    consola.error("Failed to refresh token")
    this.onTokenExpired?.()
    return null
  }

  /**
   * Clear the current token cache.
   * Does not delete persisted tokens.
   */
  clearCache(): void {
    this.currentToken = null
  }

  /**
   * Clear all tokens (including persisted ones).
   */
  async clearAll(): Promise<void> {
    this.currentToken = null

    // Clear file-based token
    const fileProvider = this.providers.find((p) => p instanceof FileTokenProvider)
    if (fileProvider) {
      await fileProvider.clearToken()
    }
  }

  /**
   * Get all available providers for debugging.
   */
  async getProviders(): Promise<
    Array<{
      name: string
      priority: number
      available: boolean
    }>
  > {
    return Promise.all(
      this.providers.map(async (p) => ({
        name: p.name,
        priority: p.priority,
        available: await p.isAvailable(),
      })),
    )
  }
}
