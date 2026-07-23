/**
 * The token domain's credential seam — the single site that reads and writes
 * the GitHub/Copilot credentials.
 *
 * In C4 the credentials still live in core `state` (read via the token
 * read-view, written via the named setters). C5 reverses ownership into this
 * package's token store and rewrites the bodies here — this module is the ONLY
 * file C5 edits to switch the source of truth. Everything else in the token
 * package (HTTP clients, managers, runtime) mutates credentials exclusively
 * through these helpers, and the advertised VS Code version comes from the
 * injected, core-owned {@link TokenRuntimeConfigView}.
 */

import {
  //
  setCopilotToken,
  setGitHubToken,
  setTokenState,
} from "~/lib/state"
import { getTokenReadView } from "~/lib/state-readers/token"

import type { GithubHeaderIdentity } from "./ghc-auth-http"
import type {
  //
  CopilotTokenInfo,
  TokenInfo,
} from "./types"

import { getTokenDeps } from "./dependencies"

/**
 * Assemble the {@link GithubHeaderIdentity} for the current process: the GitHub
 * token (core state today, token store after C5) plus the injected advertised
 * VS Code version.
 */
export function currentGithubHeaderIdentity(): GithubHeaderIdentity {
  return {
    githubToken: getTokenReadView().githubToken,
    vsCodeVersion: getTokenDeps().runtimeConfig.vsCodeVersion,
  }
}

/** Set the current GitHub token credential. */
export function setGithubCredential(token: string | undefined): void {
  setGitHubToken(token)
}

/** Set the current Copilot token credential. */
export function setCopilotCredential(token: string | undefined): void {
  setCopilotToken(token)
}

/** Record GitHub / Copilot token metadata. */
export function setTokenInfoCredential(patch: { tokenInfo?: TokenInfo; copilotTokenInfo?: CopilotTokenInfo }): void {
  setTokenState(patch)
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
 * validation. This is the single site C5 rewrites to swap the token store
 * instead of core state.
 */
export async function withGitHubTokenForValidation<T>(token: string, op: () => Promise<T>): Promise<T> {
  const run = validationChain.then(async () => {
    const original = getTokenReadView().githubToken
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
