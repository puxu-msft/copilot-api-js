import type { TokenInfo } from "../types"

import { GitHubTokenProvider } from "./base"

/**
 * Provider for tokens passed via CLI --github-token argument.
 * Highest priority (1) - if user explicitly provides a token, use it.
 */
export class CLITokenProvider extends GitHubTokenProvider {
  readonly name = "CLI"
  readonly priority = 1
  readonly refreshable = false

  private token: string | undefined

  constructor(token?: string) {
    super()
    this.token = token
  }

  isAvailable(): boolean {
    return Boolean(this.token && this.token.trim())
  }

  getToken(): Promise<TokenInfo | null> {
    if (!this.isAvailable() || !this.token) {
      return Promise.resolve(null)
    }

    return Promise.resolve({
      token: this.token.trim(),
      source: "cli",
      refreshable: false,
    })
  }
}
