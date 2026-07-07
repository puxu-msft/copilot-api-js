/**
 * Resolve the effective server-tool rewrite mode for a given resolved
 * OUTBOUND model name. A model in the learned server-tool-downgrade set
 * (or when the global `server_tool_rewrite` config is already
 * `"downgrade"`) downgrades prior-turn native server-tool blocks; every other
 * model falls back to the global `rewriteServerTools` (default `false`).
 *
 * Gap C adds NO new per-model config list — the config side is the existing
 * global `rewriteServerTools`. So the effective mode is the learned set
 * (a per-model boolean SYMPTOM learned from a `Tool '…' not found in provided
 * tools` 400) UNION the global config. The learned membership is exact
 * normalized modelKey membership (see feature-negotiation.ts).
 */

import { state } from "~/lib/state"

import type { RewriteServerToolMode } from "./sanitize/rewrite-server-tool-blocks"

import { isServerToolDowngradeLearned } from "./feature-negotiation"

/** Whether prior-turn server-tool blocks should be downgraded for this model (learned OR global config already downgrade). */
export function resolveServerToolMode(model: string): RewriteServerToolMode {
  if (isServerToolDowngradeLearned(model)) return "downgrade"
  return state.rewriteServerTools
}
