/**
 * Config module — API configuration, paths, and proxy settings
 */
export {
  copilotBaseUrl,
  copilotHeaders,
  GITHUB_API_BASE_URL,
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  githubHeaders,
  standardHeaders,
} from "./api"

export { ensurePaths, PATHS } from "./paths"

export { initProxyFromEnv } from "./proxy"
