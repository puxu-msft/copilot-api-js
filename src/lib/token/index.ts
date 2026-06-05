// Managers
export { CopilotTokenManager, type CopilotTokenManagerOptions } from "./copilot-token-manager"
export { GitHubTokenManager, type GitHubTokenManagerOptions } from "./github-token-manager"

// Lifecycle (singleton init/teardown + accessors)
export {
  ensureValidCopilotToken,
  getCopilotTokenManager,
  getGitHubTokenManager,
  initTokenManagers,
  type InitTokenManagersOptions,
  stopTokenRefresh,
} from "./lifecycle"
// Providers
export { GitHubTokenProvider } from "./providers/base"
export { CLITokenProvider } from "./providers/cli"
export { DeviceAuthProvider } from "./providers/device-auth"
export { EnvTokenProvider } from "./providers/env"

export { FileTokenProvider } from "./providers/file"

// Types
export type { CopilotTokenInfo, TokenInfo, TokenSource, TokenValidationResult } from "./types"
