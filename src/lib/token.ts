import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

/**
 * Refresh the Copilot token with exponential backoff retry.
 * Returns the new token on success, or null if all retries fail.
 */
async function refreshCopilotTokenWithRetry(
  maxRetries = 3,
): Promise<string | null> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { token } = await getCopilotToken()
      return token
    } catch (error) {
      lastError = error
      const delay = Math.min(1000 * 2 ** attempt, 30000) // Max 30s delay
      consola.warn(
        `Token refresh attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  consola.error("All token refresh attempts failed:", lastError)
  return null
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(async () => {
    consola.debug("Refreshing Copilot token")

    const newToken = await refreshCopilotTokenWithRetry()
    if (newToken) {
      state.copilotToken = newToken
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", newToken)
      }
    } else {
      // Token refresh failed after all retries
      // The existing token will continue to work until it expires
      // Next scheduled refresh will try again
      consola.error(
        "Failed to refresh Copilot token after retries, using existing token",
      )
    }
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", error.responseText)
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
