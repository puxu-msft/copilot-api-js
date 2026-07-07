/**
 * Resolve the effective server-tool-history rewrite mode for a given resolved
 * OUTBOUND model name. A model in the learned server-tool-history-downgrade set
 * (or when the global `tool_rewrite_history_server` config is already
 * `"downgrade"`) downgrades prior-turn native server-tool blocks; every other
 * model falls back to the global `rewriteHistoryServerTools` (default `false`).
 *
 * Gap C adds NO new per-model config list — the config side is the existing
 * global `rewriteHistoryServerTools`. So the effective mode is the learned set
 * (a per-model boolean SYMPTOM learned from a `Tool '…' not found in provided
 * tools` 400) UNION the global config. The learned membership is exact
 * normalized modelKey membership (see feature-negotiation.ts).
 */

import { state } from "~/lib/state"

import type { RewriteServerToolHistoryMode } from "./sanitize/rewrite-server-tool-history"

import { isServerToolHistoryDowngradeLearned } from "./feature-negotiation"

/** Whether server-tool history should be downgraded for this model (learned OR global config already downgrade). */
export function resolveServerToolHistoryMode(model: string): RewriteServerToolHistoryMode {
  if (isServerToolHistoryDowngradeLearned(model)) return "downgrade"
  return state.rewriteHistoryServerTools
}
