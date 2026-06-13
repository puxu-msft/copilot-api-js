/**
 * Capability mapping from internal Copilot `Model` → external protocol shapes.
 *
 * Two protocols are produced here:
 *
 *  - `OpenAIModelExtended` — the OpenAI `/v1/models` baseline (`id`, `object`,
 *    `created`, `owned_by`) plus informational fields derived from Copilot's
 *    `capabilities.limits` / `capabilities.supports`. The four baseline fields
 *    are **never modified, renamed, or reordered**: existing OpenAI clients
 *    that only know the spec continue to parse correctly, and any field they
 *    do not understand is ignored per the OpenAI spec.
 *
 *  - `AnthropicModelInfo` — the exact `ModelInfo` + `ModelCapabilities` shape
 *    declared by `@anthropic-ai/sdk/resources/models`. We re-export the SDK
 *    types so the wire format stays in sync with the upstream contract that
 *    `client.models.list()` decodes against.
 *
 * Derivation rules for the Anthropic capability matrix (Copilot exposes a
 * superset/subset of Anthropic's flags; below is the authoritative mapping):
 *
 *  | Anthropic field                | Source                                                | Rule                                                  |
 *  | ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
 *  | `image_input.supported`        | `capabilities.supports.vision`                        | direct boolean                                        |
 *  | `structured_outputs.supported` | `supports.structured_outputs` OR `supports.tool_calls`| logical OR                                            |
 *  | `thinking.supported`           | `supports.adaptive_thinking` OR `max_thinking_budget>0`| logical OR                                           |
 *  | `thinking.types.adaptive`      | `supports.adaptive_thinking`                          | direct boolean                                        |
 *  | `thinking.types.enabled`       | `supports.max_thinking_budget > 0`                    | derived (numeric > 0)                                 |
 *  | `effort.supported`             | `Array.isArray(supports.reasoning_effort)` && length  | non-empty array → supported                           |
 *  | `effort.{low,medium,high,max}` | `supports.reasoning_effort` includes `<level>`        | string membership                                     |
 *  | `effort.xhigh`                 | `supports.reasoning_effort` includes `"xhigh"`        | string membership (nullable in SDK shape, we set it)  |
 *  | `batch`/`citations`/`code_execution`/`pdf_input` | (none — Copilot does not expose)            | always `{ supported: false }`                         |
 *  | `context_management.*`         | (none — Copilot does not expose)                      | always `{ supported: false }` for parent and children |
 *  | `max_input_tokens`             | `capabilities.limits.max_prompt_tokens`               | direct number; `null` if absent                       |
 *  | `max_tokens`                   | `capabilities.limits.max_output_tokens`               | direct number; `null` if absent                       |
 *  | `display_name`                 | `model.name`                                          | direct string                                         |
 *  | `created_at`                   | (none — Copilot does not expose)                      | placeholder `"1970-01-01T00:00:00Z"` (epoch)          |
 *
 * Vendor filter: `buildAnthropicModelsList(..., { vendorFilter: "Anthropic" })`
 * keeps only models whose `vendor === "Anthropic"`, mirroring the upstream
 * Anthropic catalog. Pass `"all"` to expose every Copilot model under the
 * Anthropic shape (useful when a client wants to route GPT/Gemini through the
 * Messages endpoint).
 */

import type {
  //
  ModelCapabilities,
  ModelInfo,
} from "@anthropic-ai/sdk/resources/models"

import type { Model } from "./client"

import {
  //
  asBoolean,
  asNumber,
  asStringArray,
  getSupports,
} from "./capabilities"

/**
 * Epoch placeholder used when Copilot does not expose a release date.
 * Copilot's models API has no `created_at` / `release_date` field, so we emit a
 * stable epoch sentinel rather than `Date.now()` — this keeps the value
 * deterministic across restarts and preserves byte-equality with the previously
 * served `0` (OpenAI shape) for clients that diff catalog responses.
 */
const UNKNOWN_MODEL_CREATED_AT = "1970-01-01T00:00:00Z"

const SUPPORTED = { supported: true } as const
const UNSUPPORTED = { supported: false } as const

// ============================================================================
// OpenAI extended shape
// ============================================================================

/**
 * OpenAI `/v1/models` extended object — baseline 4 fields plus informational
 * capability fields. Unknown fields are ignored by spec-compliant clients, so
 * adding them is backward compatible.
 */
export interface OpenAIModelExtended {
  /** OpenAI baseline — model id. */
  id: string
  /** OpenAI baseline — always `"model"`. */
  object: "model"
  /**
   * OpenAI baseline — unix seconds; always `0` because Copilot does not expose
   * a release date. Kept stable to avoid changing previously-served values.
   */
  created: number
  /** OpenAI baseline — owner / vendor name. */
  owned_by: string
  /** Human-readable name (Copilot `name`). */
  display_name?: string
  /** `capabilities.limits.max_context_window_tokens`. */
  context_window?: number
  /** `capabilities.limits.max_prompt_tokens`. */
  max_input_tokens?: number
  /** `capabilities.limits.max_output_tokens`. */
  max_output_tokens?: number
  /** `capabilities.supports.vision`. */
  vision?: boolean
  /** `capabilities.supports.tool_calls`. */
  tool_calls?: boolean
  /** `capabilities.supports.parallel_tool_calls`. */
  parallel_tool_calls?: boolean
  /** `capabilities.supports.reasoning_effort` (string array). */
  reasoning_effort?: ReadonlyArray<string>
  /** `capabilities.family`. */
  family?: string
  /** `model.vendor` (duplicated from `owned_by` for clients that key on `vendor`). */
  vendor?: string
}

// ============================================================================
// Anthropic shapes (re-export SDK types so consumers stay in sync)
// ============================================================================

export type { ModelCapabilities, ModelInfo } from "@anthropic-ai/sdk/resources/models"

/**
 * Anthropic `ModelInfo` with a guaranteed (non-null) `capabilities` field.
 * The upstream SDK declares `capabilities: ModelCapabilities | null` to model
 * payloads from older Anthropic endpoints; we always emit the full matrix, so
 * we narrow the contract for our consumers and avoid forcing non-null
 * assertions at every call site.
 */
export interface AnthropicModelInfo extends Omit<ModelInfo, "capabilities"> {
  capabilities: ModelCapabilities
}

/**
 * Anthropic `GET /v1/models` list envelope. Matches the SDK's `ModelInfosPage`
 * JSON wire shape (`Page<ModelInfo>`).
 */
export interface AnthropicModelsListResponse {
  data: ReadonlyArray<AnthropicModelInfo>
  first_id: string | null
  has_more: boolean
  last_id: string | null
}

// ============================================================================
// Helpers — supports-readers live in ./capabilities (single source, shared with
// the pure deriveCapabilities used by the frontend) to prevent derivation drift.
// ============================================================================

// ============================================================================
// Mappers
// ============================================================================

/**
 * Convert an internal Copilot `Model` to the OpenAI extended shape.
 * Baseline 4 fields are preserved in their original positions/types.
 */
export function toOpenAIModelExtended(model: Model): OpenAIModelExtended {
  const supports = getSupports(model)
  const limits = model.capabilities?.limits
  const reasoningEffort = asStringArray(supports.reasoning_effort)

  const out: OpenAIModelExtended = {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.vendor,
  }

  if (model.name) out.display_name = model.name
  if (limits?.max_context_window_tokens !== undefined) out.context_window = limits.max_context_window_tokens
  if (limits?.max_prompt_tokens !== undefined) out.max_input_tokens = limits.max_prompt_tokens
  if (limits?.max_output_tokens !== undefined) out.max_output_tokens = limits.max_output_tokens
  if (supports.vision !== undefined) out.vision = asBoolean(supports.vision)
  if (supports.tool_calls !== undefined) out.tool_calls = asBoolean(supports.tool_calls)
  if (supports.parallel_tool_calls !== undefined) out.parallel_tool_calls = asBoolean(supports.parallel_tool_calls)
  if (reasoningEffort) out.reasoning_effort = reasoningEffort
  if (model.capabilities?.family) out.family = model.capabilities.family
  if (model.vendor) out.vendor = model.vendor

  return out
}

function buildAnthropicCapabilities(model: Model): ModelCapabilities {
  const supports = getSupports(model)

  const vision = asBoolean(supports.vision)
  const toolCalls = asBoolean(supports.tool_calls)
  const structuredOutputs = asBoolean(supports.structured_outputs) || toolCalls

  const adaptiveThinking = asBoolean(supports.adaptive_thinking)
  const maxThinkingBudget = asNumber(supports.max_thinking_budget) ?? 0
  const thinkingEnabled = maxThinkingBudget > 0
  const thinkingSupported = adaptiveThinking || thinkingEnabled

  const effortLevels = asStringArray(supports.reasoning_effort) ?? []
  const effortSupported = effortLevels.length > 0

  return {
    batch: UNSUPPORTED,
    citations: UNSUPPORTED,
    code_execution: UNSUPPORTED,
    context_management: {
      supported: false,
      clear_thinking_20251015: UNSUPPORTED,
      clear_tool_uses_20250919: UNSUPPORTED,
      compact_20260112: UNSUPPORTED,
    },
    effort: {
      supported: effortSupported,
      low: effortLevels.includes("low") ? SUPPORTED : UNSUPPORTED,
      medium: effortLevels.includes("medium") ? SUPPORTED : UNSUPPORTED,
      high: effortLevels.includes("high") ? SUPPORTED : UNSUPPORTED,
      max: effortLevels.includes("max") ? SUPPORTED : UNSUPPORTED,
      xhigh: effortLevels.includes("xhigh") ? SUPPORTED : UNSUPPORTED,
    },
    image_input: vision ? SUPPORTED : UNSUPPORTED,
    pdf_input: UNSUPPORTED,
    structured_outputs: structuredOutputs ? SUPPORTED : UNSUPPORTED,
    thinking: {
      supported: thinkingSupported,
      types: {
        adaptive: adaptiveThinking ? SUPPORTED : UNSUPPORTED,
        enabled: thinkingEnabled ? SUPPORTED : UNSUPPORTED,
      },
    },
  }
}

/** Convert an internal Copilot `Model` to Anthropic `ModelInfo`. */
export function toAnthropicModelInfo(model: Model): AnthropicModelInfo {
  const limits = model.capabilities?.limits

  return {
    id: model.id,
    type: "model",
    display_name: model.name,
    created_at: UNKNOWN_MODEL_CREATED_AT,
    max_input_tokens: limits?.max_prompt_tokens ?? null,
    max_tokens: limits?.max_output_tokens ?? null,
    capabilities: buildAnthropicCapabilities(model),
  }
}

/**
 * Build the Anthropic `GET /v1/models` list response envelope from a Copilot
 * model catalog. Defaults to filtering by `vendor === "Anthropic"` since the
 * Anthropic-shaped endpoint is meant to mirror the upstream Anthropic catalog;
 * pass `vendorFilter: "all"` to disable the filter.
 */
export function buildAnthropicModelsList(models: ReadonlyArray<Model>, opts?: { vendorFilter?: "Anthropic" | "all" }): AnthropicModelsListResponse {
  const vendorFilter = opts?.vendorFilter ?? "Anthropic"
  const filtered = vendorFilter === "all" ? [...models] : models.filter((m) => m.vendor === "Anthropic")
  const data = filtered.map((m) => toAnthropicModelInfo(m))

  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  }
}
