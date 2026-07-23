import { randomUUID } from "node:crypto"

import {
  //
  EDITOR_PLUGIN_VERSION,
  standardHeaders,
  USER_AGENT,
} from "~/lib/ghc-http-primitives"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

import type { State } from "./state"

import { setVSCodeVersion } from "./state"

/** Copilot Chat API version (for chat/completions requests) */
const COPILOT_API_VERSION = "2025-05-01"

/**
 * Session-level interaction ID.
 * Used to correlate all requests within a single server session.
 * Unlike x-request-id (per-request UUID), this stays constant for the server lifetime.
 */
const INTERACTION_ID = randomUUID()

/**
 * Resolve the GHC API base URL.
 *
 * Priority:
 *   1. `state.ghcApiBaseUrl` — explicit override (CLI `--ghc-api-base-url`
 *      or `ghc_api_base_url` in config.yaml). Trailing slashes are trimmed
 *      so callers can safely template `${base}/path`.
 *   2. Derived from `state.accountType`.
 */
export const copilotBaseUrl = (state: State) => {
  if (state.ghcApiBaseUrl) return state.ghcApiBaseUrl.replace(/\/+$/u, "")
  return state.accountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${state.accountType}.githubcopilot.com`
}

export const copilotWsUrl = (state: State) => {
  const url = new URL(copilotBaseUrl(state))
  // Only HTTP-family protocols upgrade to WebSocket. Any other scheme is a
  // misconfiguration (e.g. accidentally passing a ws://, file://, or unix:
  // base URL through Copilot's account-type → URL pipeline). Fail fast with
  // a clear error rather than silently constructing an invalid wss:// URL.
  if (url.protocol === "https:") {
    url.protocol = "wss:"
  } else if (url.protocol === "http:") {
    url.protocol = "ws:"
  } else {
    throw new Error(`copilotWsUrl: cannot derive a WebSocket URL from base "${url.toString()}" (protocol "${url.protocol}")`)
  }
  url.pathname = "/responses"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/u, "")
}

export interface CopilotHeaderOptions {
  /** Whether to set the Copilot-Vision-Request header */
  vision?: boolean
  /** Model-specific request headers from CAPI to forward upstream */
  modelRequestHeaders?: Record<string, string>
  /** OpenAI intent value (default: "conversation-panel") */
  intent?: string
}

export const copilotHeaders = (state: State, opts?: CopilotHeaderOptions) => {
  const requestId = randomUUID()
  const interactionType = opts?.intent ?? "conversation-panel"
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": interactionType,
    "x-github-api-version": COPILOT_API_VERSION,
    "x-request-id": requestId,
    "X-Interaction-Id": INTERACTION_ID,
    "X-Interaction-Type": interactionType,
    "X-Agent-Task-Id": requestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (opts?.vision) headers["copilot-vision-request"] = "true"

  // Forward model-specific request headers from CAPI (lowest priority — don't override core headers)
  if (opts?.modelRequestHeaders) {
    const coreKeysLower = new Set(Object.keys(headers).map((k) => k.toLowerCase()))
    for (const [key, value] of Object.entries(opts.modelRequestHeaders)) {
      if (!coreKeysLower.has(key.toLowerCase())) headers[key] = value
    }
  }

  return headers
}

// ============================================================================
// VSCode version detection
// ============================================================================

/** Fallback VSCode version when GitHub API is unavailable */
const VSCODE_VERSION_FALLBACK = "1.104.3"

/** GitHub API endpoint for latest VSCode release */
const VSCODE_RELEASE_URL = "https://api.github.com/repos/microsoft/vscode/releases/latest"

/** GitHub release response shape */
interface GitHubRelease {
  tag_name: string
}

/** Fetch the latest VSCode version and cache in global state */
export async function cacheVSCodeVersion(): Promise<void> {
  const response = await getVSCodeVersion()
  setVSCodeVersion(response)
}

/** Fetch the latest VSCode version from GitHub releases, falling back to a hardcoded version */
export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await upstreamFetch(VSCODE_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "copilot-api",
      },
    })

    if (!response.ok) {
      return VSCODE_VERSION_FALLBACK
    }

    const release = (await response.json()) as GitHubRelease
    // tag_name is in format "1.107.1"
    const version = release.tag_name
    if (version && /^\d+\.\d+\.\d+$/.test(version)) {
      return version
    }

    return VSCODE_VERSION_FALLBACK
  } catch {
    return VSCODE_VERSION_FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}
