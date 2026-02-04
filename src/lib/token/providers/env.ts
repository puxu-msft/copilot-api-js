import type { TokenInfo } from "../types"

import { GitHubTokenProvider } from "./base"

/**
 * Environment variable names to check for GitHub token.
 * Checked in order - first found wins.
 */
const ENV_VARS = [
  "COPILOT_API_GITHUB_TOKEN", // Our dedicated variable
  "GH_TOKEN", // GitHub CLI compatible
  "GITHUB_TOKEN", // Common convention
]

/**
 * Provider for tokens from environment variables.
 * Priority 2 - checked after CLI but before file storage.
 */
export class EnvTokenProvider extends GitHubTokenProvider {
  readonly name = "Environment"
  readonly priority = 2
  readonly refreshable = false

  /** The env var name where the token was found */
  private foundEnvVar: string | undefined

  isAvailable(): boolean {
    return this.findEnvVar() !== undefined
  }

  getToken(): Promise<TokenInfo | null> {
    const envVar = this.findEnvVar()
    if (!envVar) {
      return Promise.resolve(null)
    }

    const token = process.env[envVar]
    if (!token) {
      return Promise.resolve(null)
    }

    this.foundEnvVar = envVar

    return Promise.resolve({
      token: token.trim(),
      source: "env",
      refreshable: false,
    })
  }

  /**
   * Find the first environment variable that contains a token.
   */
  private findEnvVar(): string | undefined {
    for (const envVar of ENV_VARS) {
      const value = process.env[envVar]
      if (value && value.trim()) {
        return envVar
      }
    }
    return undefined
  }

  /**
   * Get the name of the environment variable that provided the token.
   */
  getFoundEnvVar(): string | undefined {
    return this.foundEnvVar
  }
}
