/**
 * Token store — the single source of truth for the token domain's credentials.
 *
 * C5 reverses ownership of `githubToken` / `copilotToken` / `tokenInfo` /
 * `copilotTokenInfo` out of the core `state` god-object into this module. The
 * token package writes them exclusively through the {@link ../credentials}
 * seam; core consumers read them through {@link getTokenCredentials}. No field
 * lives in both places — this is the sole owner.
 *
 * Test isolation: the store exposes deep snapshot/restore/clear primitives that
 * core's `snapshotStateForTests` / `restoreStateForTests` compose (so the
 * existing per-test state snapshot atomically covers credentials too — no
 * separate fixture wiring or resetter). The `tokenInfo` / `copilotTokenInfo`
 * objects are deep-cloned on snapshot, mirroring the old `cloneState` behavior.
 */

import type {
  //
  CopilotTokenInfo,
  TokenInfo,
} from "./types"

/** The four credentials owned by the token domain. */
interface TokenStore {
  githubToken?: string
  copilotToken?: string
  tokenInfo?: TokenInfo
  copilotTokenInfo?: CopilotTokenInfo
}

/** The single process-wide credential store. */
const store: TokenStore = {}

/** Read-only view of the current credentials, for core consumers. */
export interface TokenCredentialsView {
  readonly githubToken?: string
  readonly copilotToken?: string
  readonly tokenInfo?: TokenInfo
  readonly copilotTokenInfo?: CopilotTokenInfo
}

/**
 * Live read-view of the credentials. Returning `store` directly is safe: it
 * structurally satisfies the narrower read-only view, and the return type hides
 * the mutable setters from consumers.
 */
export function getTokenCredentials(): TokenCredentialsView {
  return store
}

export function setStoreGithubToken(token: string | undefined): void {
  store.githubToken = token
}

export function setStoreCopilotToken(token: string | undefined): void {
  store.copilotToken = token
}

export function setStoreTokenInfo(info: TokenInfo | undefined): void {
  store.tokenInfo = info
}

export function setStoreCopilotTokenInfo(info: CopilotTokenInfo | undefined): void {
  store.copilotTokenInfo = info
}

// ============================================================================
// Test isolation primitives (composed by core's snapshotStateForTests)
// ============================================================================

/** Immutable snapshot of the credential store for per-test isolation. */
export interface TokenStoreSnapshot {
  readonly githubToken?: string
  readonly copilotToken?: string
  readonly tokenInfo?: TokenInfo
  readonly copilotTokenInfo?: CopilotTokenInfo
}

/** Deep-clone the current store (the info objects are copied, not aliased). */
export function snapshotTokenStoreForTests(): TokenStoreSnapshot {
  return {
    githubToken: store.githubToken,
    copilotToken: store.copilotToken,
    tokenInfo: store.tokenInfo ? { ...store.tokenInfo } : undefined,
    copilotTokenInfo: store.copilotTokenInfo ? { ...store.copilotTokenInfo } : undefined,
  }
}

/** Restore the store from a {@link snapshotTokenStoreForTests} snapshot. */
export function restoreTokenStoreForTests(snapshot: TokenStoreSnapshot): void {
  store.githubToken = snapshot.githubToken
  store.copilotToken = snapshot.copilotToken
  store.tokenInfo = snapshot.tokenInfo ? { ...snapshot.tokenInfo } : undefined
  store.copilotTokenInfo = snapshot.copilotTokenInfo ? { ...snapshot.copilotTokenInfo } : undefined
}
