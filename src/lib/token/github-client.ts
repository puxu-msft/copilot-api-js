/** GitHub OAuth API client — device code flow and user info */

import consola from "consola"

import {
  GITHUB_API_BASE_URL,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  githubHeaders,
  standardHeaders,
} from "~/lib/config/api"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

// ============================================================================
// User
// ============================================================================

export interface GitHubUser {
  login: string
  id: number
  name: string | null
  email: string | null
  created_at: string
  updated_at: string
  two_factor_authentication: boolean
}

export const getGitHubUser = async (): Promise<GitHubUser> => {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: githubHeaders(state),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get GitHub user", response)

  return (await response.json()) as GitHubUser
}

// ============================================================================
// Device code flow
// ============================================================================

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export const getDeviceCode = async (): Promise<DeviceCodeResponse> => {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}

export async function pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  // Calculate expiration time based on expires_in from device code response
  const expiresAt = Date.now() + deviceCode.expires_in * 1000

  while (Date.now() < expiresAt) {
    const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) {
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())

      continue
    }

    const json = (await response.json()) as AccessTokenResponse
    consola.debug("Polling access token response:", json)

    const { access_token } = json

    if (access_token) {
      return access_token
    } else {
      await sleep(sleepDuration)
    }
  }

  throw new Error("Device code expired. Please run the authentication flow again.")
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
