import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"

import type { TokenInfo } from "../types"

import { GitHubTokenProvider } from "./base"

/**
 * Provider for tokens stored in file system.
 * Priority 3 - checked after CLI and environment variables.
 */
export class FileTokenProvider extends GitHubTokenProvider {
  readonly name = "File"
  readonly priority = 3
  readonly refreshable = false

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.readTokenFile()
      return Boolean(token && token.trim())
    } catch {
      return false
    }
  }

  async getToken(): Promise<TokenInfo | null> {
    try {
      const token = await this.readTokenFile()
      if (!token || !token.trim()) {
        return null
      }

      return {
        token: token.trim(),
        source: "file",
        refreshable: false,
      }
    } catch {
      return null
    }
  }

  /**
   * Save a token to the file.
   * This is used by device auth provider to persist tokens.
   */
  async saveToken(token: string): Promise<void> {
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token.trim())
  }

  /**
   * Clear the stored token.
   */
  async clearToken(): Promise<void> {
    try {
      await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "")
    } catch {
      // Ignore errors when clearing
    }
  }

  private async readTokenFile(): Promise<string> {
    return fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
  }
}
