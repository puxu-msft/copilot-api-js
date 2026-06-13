/**
 * Pure, SDK-free capability derivation from the raw Copilot `Model.capabilities`.
 *
 * Single source of truth for "what can this model do", consumed by BOTH the
 * backend mappers (capabilities-mapper.ts re-uses the readers here) and the
 * frontend Models page (imported via `~backend`). The frontend MUST NOT
 * re-derive capabilities locally — that is exactly the drift this module
 * prevents (the old `getCapabilities` dropped numeric/array supports and would
 * diverge from the backend's documented mapping).
 *
 * Semantics mirror the documented table in capabilities-mapper.ts.
 */

import type { Model } from "./client"

type SupportsValue = boolean | number | Array<string> | undefined

export function getSupports(model: Model): Record<string, SupportsValue> {
  return model.capabilities?.supports ?? {}
}
export function asBoolean(v: unknown): boolean {
  return v === true
}
export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
export function asStringArray(v: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined
}

/** Normalized capability view for UI display + filtering. */
export interface DerivedCapabilities {
  vision: boolean
  toolCalls: boolean
  parallelToolCalls: boolean
  structuredOutputs: boolean
  streaming: boolean
  /** adaptive thinking OR a positive max_thinking_budget. */
  thinking: boolean
  adaptiveThinking: boolean
  /** 0 when none. */
  maxThinkingBudget: number
  /** [] when none. */
  reasoningEffort: ReadonlyArray<string>
  contextWindow?: number
  maxOutput?: number
  maxPrompt?: number
  maxInputs?: number
  maxNonStreamingOutput?: number
}

export function deriveCapabilities(model: Model): DerivedCapabilities {
  const s = getSupports(model)
  const limits = model.capabilities?.limits
  const adaptiveThinking = asBoolean(s.adaptive_thinking)
  const maxThinkingBudget = asNumber(s.max_thinking_budget) ?? 0
  return {
    vision: asBoolean(s.vision),
    toolCalls: asBoolean(s.tool_calls),
    parallelToolCalls: asBoolean(s.parallel_tool_calls),
    structuredOutputs: asBoolean(s.structured_outputs) || asBoolean(s.tool_calls),
    streaming: asBoolean(s.streaming),
    thinking: adaptiveThinking || maxThinkingBudget > 0,
    adaptiveThinking,
    maxThinkingBudget,
    reasoningEffort: asStringArray(s.reasoning_effort) ?? [],
    contextWindow: limits?.max_context_window_tokens,
    maxOutput: limits?.max_output_tokens,
    maxPrompt: limits?.max_prompt_tokens,
    maxInputs: limits?.max_inputs,
    maxNonStreamingOutput: limits?.max_non_streaming_output_tokens,
  }
}
