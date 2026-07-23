/**
 * The token domain's credential seam — the single site that reads and writes
 * the GitHub/Copilot credentials.
 *
 * C5 reversed ownership of the credentials out of core `state` into this
 * package's {@link ./store}. Everything else in the token package (HTTP
 * clients, managers, runtime) reads/writes credentials exclusively through
 * these helpers; the advertised VS Code version still comes from the injected,
 * core-owned {@link TokenRuntimeConfigView}. This module is the ONLY place that
 * knows where the credentials physically live.
 */

import type { GithubHeaderIdentity } from "./ghc-auth-http"
import type {
  //
  CopilotTokenInfo,
  TokenInfo,
} from "./types"

import { getTokenDeps } from "./dependencies"
import {
  //
  getTokenCredentials,
  setStoreCopilotToken,
  setStoreCopilotTokenInfo,
  setStoreGithubToken,
  setStoreTokenInfo,
} from "./store"

/**
 * Assemble the {@link GithubHeaderIdentity} for the current process: the GitHub
 * token (token store) plus the injected advertised VS Code version.
 */
export function currentGithubHeaderIdentity(): GithubHeaderIdentity {
  return {
    githubToken: getTokenCredentials().githubToken,
    vsCodeVersion: getTokenDeps().runtimeConfig.vsCodeVersion,
  }
}

/** Set the current GitHub token credential. */
export function setGithubCredential(token: string | undefined): void {
  setStoreGithubToken(token)
}

/** Set the current Copilot token credential. */
export function setCopilotCredential(token: string | undefined): void {
  setStoreCopilotToken(token)
}

/** Record GitHub / Copilot token metadata (only the keys present in `patch`). */
export function setTokenInfoCredential(patch: { tokenInfo?: TokenInfo; copilotTokenInfo?: CopilotTokenInfo }): void {
  if ("tokenInfo" in patch) setStoreTokenInfo(patch.tokenInfo)
  if ("copilotTokenInfo" in patch) setStoreCopilotTokenInfo(patch.copilotTokenInfo)
}

/**
 * Serialization chain for validation swaps. The GitHub token is a process-wide
 * credential, so two concurrent temporary swaps would clobber each other's
 * restore; chaining keeps each validation atomic with respect to the others.
 */
let validationChain: Promise<unknown> = Promise.resolve()

/**
 * Run `op` with the GitHub credential temporarily set to `token`, restoring the
 * previous value afterwards (try/finally). Concurrent calls are serialized so
 * the temporary swap is never observed by an unrelated request or another
 * validation.
 */
export async function withGitHubTokenForValidation<T>(token: string, op: () => Promise<T>): Promise<T> {
  const run = validationChain.then(async () => {
    const original = getTokenCredentials().githubToken
    setGithubCredential(token)
    try {
      return await op()
    } finally {
      setGithubCredential(original)
    }
  })
  // Keep the chain alive regardless of this op's success/failure.
  validationChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
