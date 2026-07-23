// Managers
export { CopilotTokenManager, type CopilotTokenManagerOptions } from "./copilot-token-manager"
// Injected dependency ports (the token domain's external contract)
export {
  getTokenDeps,
  installTokenDeps,
  type TokenFetch,
  type TokenFetchInit,
  type TokenPersistencePaths,
  type TokenRuntimeConfigView,
  type TokenRuntimeDependencies,
} from "./dependencies"

export { GitHubTokenManager, type GitHubTokenManagerOptions } from "./github-token-manager"
// Providers
export { GitHubTokenProvider } from "./providers/base"
export { CLITokenProvider } from "./providers/cli"
export { DeviceAuthProvider } from "./providers/device-auth"

export { EnvTokenProvider } from "./providers/env"

export { FileTokenProvider } from "./providers/file"

// Composition root (the token domain's assembly entry point + process singleton)
export {
  type AcquireGitHubTokenOptions,
  createTokenRuntime,
  getTokenRuntime,
  type InitTokenManagersOptions,
  installTokenRuntime,
  peekTokenRuntime,
  resetTokenRuntimeForTests,
  type TokenRuntime,
  type TokenRuntimeManagers,
} from "./runtime"

// Types
export type { CopilotTokenInfo, TokenInfo, TokenSource, TokenValidationResult } from "./types"
