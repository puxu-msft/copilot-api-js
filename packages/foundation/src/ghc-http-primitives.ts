/**
 * Pure GHC/Copilot HTTP header primitives shared by BOTH the core Copilot-chat
 * header builder (`copilot-api.ts::copilotHeaders`) and the token package's
 * GitHub-auth header builder (`token/ghc-auth-http.ts::githubHeaders`).
 *
 * Foundation-hosted so the token package can build its auth headers with zero
 * core dependency (spec §7.2 / token-package plan C6). Pure consts + a stateless
 * header factory — no state/transport/fs.
 */

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const COPILOT_VERSION = "0.38.0"
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

/** GitHub public API version (for /user, repos, etc.) */
export const GITHUB_API_VERSION = "2022-11-28"
/** Copilot internal API version (for token & usage endpoints) */
export const COPILOT_INTERNAL_API_VERSION = "2025-04-01"
