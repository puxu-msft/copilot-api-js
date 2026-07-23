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

// Composition root (the token domain's assembly entry point)
export { createTokenRuntime, type TokenRuntime, type TokenRuntimeManagers } from "./runtime"

// Types
export type { CopilotTokenInfo, TokenInfo, TokenSource, TokenValidationResult } from "./types"
