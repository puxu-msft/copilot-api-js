/**
 * Resolve the effective server-tool rewrite mode for a given resolved OUTBOUND
 * model name. A model in the learned server-tool-downgrade set downgrades
 * prior-turn native server-tool blocks; every other model falls back to `false`
 * (no rewrite).
 *
 * The global `server_tool_rewrite` config source was removed with the web_search
 * retirement (2026-07-13). The only remaining source is the learned set — a
 * per-model boolean SYMPTOM learned from a `Tool '…' not found in provided tools`
 * 400 (exact normalized modelKey membership; see feature-negotiation.ts).
 */

import type { RewriteServerToolMode } from "./sanitize/rewrite-server-tool-blocks"

import { isServerToolDowngradeLearned } from "./feature-negotiation"

/** Whether prior-turn server-tool blocks should be downgraded for this model (learned only). */
export function resolveServerToolMode(model: string): RewriteServerToolMode {
  return isServerToolDowngradeLearned(model) ? "downgrade" : false
}
