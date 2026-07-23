import { writeSensitiveOnce } from "@hsupu/ghc-proxy-foundation/sensitive-output"
import consola from "consola"

import type { TokenInfo } from "../types"

import {
  //
  getDeviceCode,
  pollAccessToken,
} from "../github-client"
import { GitHubTokenProvider } from "./base"
import { FileTokenProvider } from "./file"

/**
 * Provider for tokens obtained via GitHub device authorization flow.
 * Priority 4 (lowest) - only used when no other token source is available.
 * This is the interactive fallback that prompts the user to authenticate.
 */
export class DeviceAuthProvider extends GitHubTokenProvider {
  readonly name = "DeviceAuth"
  readonly priority = 4
  readonly refreshable = true

  private fileProvider: FileTokenProvider

  constructor() {
    super()
    this.fileProvider = new FileTokenProvider()
  }

  /**
   * Device auth is always "available" as a fallback.
   * It will prompt the user to authenticate interactively.
   */
  isAvailable(): boolean {
    return true
  }

  /**
   * Run the device authorization flow to get a new token.
   * This will prompt the user to visit a URL and enter a code.
   */
  async getToken(): Promise<TokenInfo | null> {
    try {
      consola.info("Not logged in, starting device authorization flow...")

      const response = await getDeviceCode()
      consola.debug(`Device authorization started (expires_in=${response.expires_in}s interval=${response.interval}s)`)

      consola.info(`Open ${response.verification_uri} to complete GitHub device authorization`)
      if (!writeSensitiveOnce("github-device-code", "GitHub device code", response.user_code)) {
        throw new Error("GitHub device authorization requires a healthy interactive terminal to display the one-time code")
      }

      const token = await pollAccessToken(response)

      // Save to file for future sessions
      await this.fileProvider.saveToken(token)

      return {
        token,
        source: "device-auth",
        refreshable: true,
      }
    } catch (error) {
      // Node.js undici wraps the real error in TypeError.cause — surface it for diagnostics
      const cause = error instanceof TypeError && error.cause ? error.cause : undefined
      consola.error("Device authorization failed:", error)
      if (cause) {
        consola.error("Caused by:", cause)
      }
      return null
    }
  }

  /**
   * Refresh by running the device auth flow again.
   */
  async refresh(): Promise<TokenInfo | null> {
    return this.getToken()
  }
}
