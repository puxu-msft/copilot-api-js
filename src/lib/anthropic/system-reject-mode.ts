/**
 * Resolve the effective inline-`role:"system"` sanitize mode for a given resolved
 * OUTBOUND model name. A model in the reject set (config `system_reject_models`
 * ∪ the learned negotiation set) uses `system_reject_mode`; every other model
 * falls back to the global `system_messages_sanitize` (default passthrough).
 *
 * The reject membership is a SYMPTOM ("this outbound model rejects inline system"),
 * NOT a Vertex assertion (Vertex is this account's known cause but is not asserted).
 * Config match is list substring-includes over normalized names (NOT findMostSpecific —
 * that is Record→value, meaningless for a boolean set); the learned side is exact
 * normalized modelKey membership.
 */

import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

import type { SystemMessagesSanitizeMode } from "./sanitize/system-messages"

import { isSystemRejectModelLearned } from "./feature-negotiation"

export function isSystemRejectModel(model: string): boolean {
  const normalized = normalizeForMatching(model)
  for (const key of state.systemRejectModels) {
    if (normalized.includes(normalizeForMatching(key))) return true
  }
  return isSystemRejectModelLearned(model)
}

export function resolveSystemSanitizeMode(model: string): SystemMessagesSanitizeMode {
  return isSystemRejectModel(model) ? state.systemRejectMode : state.systemMessagesSanitize
}
