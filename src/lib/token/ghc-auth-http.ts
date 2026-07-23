import {
  //
  EDITOR_PLUGIN_VERSION,
  GITHUB_API_VERSION,
  standardHeaders,
  USER_AGENT,
} from "~/lib/ghc-http-primitives"

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"

/**
 * The narrow role interface `githubHeaders` needs from its caller — NOT the
 * whole `State` god-object. Adding a field leaves every call site unchanged:
 * callers pass a context view (token domain's `getTokenReadView()`) that
 * structurally satisfies this.
 */
export interface GithubHeaderIdentity {
  readonly githubToken?: string
  readonly vsCodeVersion?: string
}
export const githubHeaders = (identity: GithubHeaderIdentity) => ({
  ...standardHeaders(),
  authorization: `token ${identity.githubToken}`,
  "editor-version": `vscode/${identity.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": GITHUB_API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
