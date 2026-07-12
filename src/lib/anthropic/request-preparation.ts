import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { CacheTtl } from "~/lib/state"

import { copilotHeaders } from "~/lib/copilot-api"
import { state } from "~/lib/state"
import {
  //
  type MessageParam,
  type MessagesPayload,
  type OutputConfig,
  type Tool,
  EFFORT_LEVELS,
  isToolResultBlock,
} from "~/types/api/anthropic"

import {
  //
  getSupportedEfforts,
  getUnsupportedFeatures,
  isAnthropicBetaUnsupported,
  isAnthropicFeatureUnsupported,
  isAnthropicPartnerFeatureUnsupported,
  isEffortUnsupported,
  markEffortUnsupported,
  setSupportedEfforts,
} from "./feature-negotiation"
import {
  //
  buildAnthropicBetaHeaders,
  buildContextManagement,
  isContextEditingEnabled,
  mergeAnthropicBeta,
  modelHasAdaptiveThinking,
  modelRequiresEnabledThinking,
  modelSupportsContextEditing,
  modelSupportsExtendedCacheTtl,
  modelSupportsMemory,
} from "./features"
import {
  //
  keepHeaders,
  pruneHeaders,
  selectPassthroughHeaders,
} from "./header-policy"
import {
  //
  stripServerTools,
  stripToolFields,
} from "./message-tools"
import {
  //
  PARTNER_FEATURE_STRIP_TARGETS,
  stripPartnerFeatureFromWire,
} from "./partner-feature-strip"
import {
  //
  collectAllMatching,
  findMostSpecific,
} from "./per-model-config"
import {
  //
  adaptiveToEnabledThinking,
  budgetToEffort,
} from "./thinking-coercion"

export interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * The mutable prepare context threaded through the prepare steps: the wire body
 * (built from the payload, then trimmed/clamped in place), the accumulating
 * headers, and the per-attempt options (resolvedModel + PrepareHints).
 */
export interface PrepareContext {
  wire: Record<string, unknown>
  headers: Record<string, string>
  opts: PrepareAnthropicRequestOptions
  /**
   * Set by the `cache-control` step: true iff the final wire carries a `cache_control` with
   * `ttl:"1h"` (whether the proxy wrote it or a passthrough client sent it). Read by `build-headers`
   * to emit `extended-cache-ttl-2025-04-11` exactly when the body needs it (header mirrors body).
   */
  wroteExtendedTtl?: boolean
  /**
   * Set by the `rewrite-memory-tool` step: true iff a client tool named `memory` was rewritten to the
   * native `{name:"memory", type:"memory_20250818"}` server tool. Read by `build-headers` to force the
   * shared `context-management-2025-06-27` beta (memory rides it, GHC-style).
   */
  hasMemoryTool?: boolean
}

/** One named prepare step. Mutates `ctx.wire` and/or `ctx.headers` in place. */
export interface PrepareStep {
  readonly name: string
  apply(ctx: PrepareContext): void
}

interface PrepareAnthropicRequestOptions {
  resolvedModel?: Model
  /**
   * Client-sent `anthropic-beta` header (raw comma-separated string).
   * Merged with locally-built beta features so SDK-provided betas survive.
   * Mirrors GHC #4945 fix.
   */
  clientAnthropicBeta?: string
  /**
   * Client's raw inbound HTTP headers (lowercased keys). When passthrough is
   * enabled (`state.strictRequestHeaders === false`), the safe subset is merged
   * UNDER the proxy's core headers — see `buildAnthropicHeaders`. Absent/undefined
   * means no passthrough source (the request behaves as strict).
   */
  clientRequestHeaders?: Record<string, string>
  /**
   * Per-attempt overrides supplied by retry strategies (see PrepareHints in
   * lib/request/pipeline.ts). These are unioned with the persistent
   * negotiation cache results during filtering, so the retry caller gets
   * deterministic exclusion of THIS attempt without depending on the cache
   * having been written by a prior strategy.
   */
  excludeBetas?: ReadonlyArray<string>
  rejectFields?: ReadonlyArray<string>
  /**
   * Server tool type prefixes to strip from the next wire payload, in addition
   * to anything the global config / negotiation cache already strips. Supplied
   * by the server-tool-rejection retry strategy via
   * `PrepareHints.excludeServerToolTypes`.
   */
  excludeServerToolTypes?: ReadonlyArray<string>
  /**
   * Custom-tool top-level field names to strip from every tool in the next wire
   * payload, in addition to the built-in defaults / config / negotiation cache.
   * Supplied by the tool-field-rejection retry strategy via
   * `PrepareHints.excludeToolFields`.
   */
  excludeToolFields?: ReadonlyArray<string>
  /**
   * L2 buffered-retry escalation (RFC §8) from `PrepareHints.contextEscalation`: when set, FORCE
   * an aggressive native `clear_tool_uses` context_management edit on this attempt (independent of
   * `contextEditingMode`). Skipped when `contextManagementDisabled` (model doesn't support it).
   */
  contextEscalation?: { trigger: number; keepTools: number; keepThinking: number }
}

/**
 * Built-in body fields the Copilot upstream historically rejects.
 * Merged with config `rejectBodyFields` (per-model) and runtime-learned
 * negotiation cache entries.
 */
const BUILTIN_REJECTED_FIELDS: ReadonlyArray<string> = ["inference_geo"]
const CACHE_CONTROL_BREAKPOINT_LIMIT = 4
/** A prompt-cache breakpoint. `ttl:"1h"` marks the extended TTL; omitting `ttl` is Anthropic's 5m default. */
type EphemeralCacheControl = { type: "ephemeral"; ttl?: "1h" }

/** Resolve the concrete breakpoint object for a per-layer TTL (5m → bare ephemeral, 1h → +ttl). */
function ephemeralFor(ttl: CacheTtl): EphemeralCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
}

/** True when the request is agent-style (an assistant message is present) — the closest analog to GHC's
 * `ChatLocation.Agent && !subagent` gate for extended cache TTL. */
function isAgentCall(messages: MessagesPayload["messages"] | undefined): boolean {
  return Array.isArray(messages) && messages.some((msg) => msg.role === "assistant")
}

let warnedExtendedTtlClamp = false

/**
 * Resolve the effective per-layer TTLs, clamping `messagesTtl` down to `toolsSystemTtl` (order 5m<1h).
 * Anthropic requires longer TTLs to appear earlier in the tools→system→messages prefix order, so a
 * messages breakpoint may not outlive the tools/system breakpoints. Warns once on clamp.
 */
function resolveExtendedTtls(): { toolsSystem: CacheTtl; messages: CacheTtl } {
  const toolsSystem = state.extendedCacheTtlToolsSystem
  let messages = state.extendedCacheTtlMessages
  if (messages === "1h" && toolsSystem === "5m") {
    if (!warnedExtendedTtlClamp) {
      consola.warn(
        `[config] anthropic.extended_cache_ttl.messages_ttl (1h) exceeds tools_system_ttl (5m); clamping messages to 5m (Anthropic requires longer TTLs earlier in the tools→system→messages order)`,
      )
      warnedExtendedTtlClamp = true
    }
    messages = "5m"
  }
  return { toolsSystem, messages }
}

export interface PerLayerClientTtls {
  tools?: CacheTtl
  system?: CacheTtl
  messages?: CacheTtl
}
export interface SanitizedLayerTtls {
  tools?: CacheTtl
  system?: CacheTtl
  messages?: CacheTtl
}

/** ttl 大小比较：5m < 1h。 */
function maxTtl(a: CacheTtl, b: CacheTtl): CacheTtl {
  return a === "1h" || b === "1h" ? "1h" : "5m"
}
function minTtl(a: CacheTtl, b: CacheTtl): CacheTtl {
  return a === "5m" || b === "5m" ? "5m" : "1h"
}

/**
 * sanitize 的 TTL 决策（规范化已有断点，NOT 注入）。对每个**有客户端断点**的层取
 * max(客户端最大 ttl, extended floor)，再沿 tools→system→messages 单调化——后层 ≤ 最近的
 * 前面有断点层（满足 Anthropic 前缀递减约束，spec §4.3）。**无断点层返回 undefined**：它不产生
 * 断点，也不作为后层的上界约束（约束只对实际存在的断点成立）。
 * extended 未激活时所有 floor = 5m。proxied 不用此函数（它自注入固定 floor，见 applyCacheControlMode）。
 */
export function resolveSanitizedTtls(
  clientMax: PerLayerClientTtls,
  extendedActive: boolean,
  extendedTtls: { toolsSystem: CacheTtl; messages: CacheTtl },
): SanitizedLayerTtls {
  const floorTS: CacheTtl = extendedActive ? extendedTtls.toolsSystem : "5m"
  const floorM: CacheTtl = extendedActive ? extendedTtls.messages : "5m"
  const tools = clientMax.tools !== undefined ? maxTtl(clientMax.tools, floorTS) : undefined
  const systemRaw = clientMax.system !== undefined ? maxTtl(clientMax.system, floorTS) : undefined
  const system = systemRaw !== undefined && tools !== undefined ? minTtl(systemRaw, tools) : systemRaw
  const msgCeil = system ?? tools // 最近的前面有断点层
  const messagesRaw = clientMax.messages !== undefined ? maxTtl(clientMax.messages, floorM) : undefined
  const messages = messagesRaw !== undefined && msgCeil !== undefined ? minTtl(messagesRaw, msgCeil) : messagesRaw
  return { tools, system, messages }
}

/** 扫 wire 每层（system/messages/tools + 嵌套 content），返回该层出现的最大 cache_control ttl（缺则 undefined）。 */
export function collectPerLayerClientTtls(wire: Record<string, unknown>): PerLayerClientTtls {
  const result: PerLayerClientTtls = {}
  for (const section of ["tools", "system", "messages"] as const) {
    if (!Array.isArray(wire[section])) continue
    let layerMax: CacheTtl | undefined
    const visit = (items: Array<Record<string, unknown> | null | undefined>): void => {
      for (const item of items) {
        if (!item || typeof item !== "object") continue
        const cc = item.cache_control as { ttl?: unknown } | undefined
        if (cc) {
          const ttl: CacheTtl = cc.ttl === "1h" ? "1h" : "5m"
          layerMax = layerMax === undefined ? ttl : maxTtl(layerMax, ttl)
        }
        if (Array.isArray(item.content)) visit(item.content as Array<Record<string, unknown>>)
      }
    }
    visit(wire[section] as Array<Record<string, unknown>>)
    result[section] = layerMax
  }
  return result
}

/** True when any cache_control in the wire (system / messages / tools) carries `ttl:"1h"` — read-only. */
function wireHasOneHourTtl(wire: Record<string, unknown>): boolean {
  return ["system", "messages", "tools"].some((key) => hasOneHourTtlDeep(wire[key]))
}

function hasOneHourTtlDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasOneHourTtlDeep(item))
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const cc = record.cache_control as { ttl?: unknown } | undefined
  if (cc && cc.ttl === "1h") return true
  return Object.values(record).some((nested) => nested !== record.cache_control && hasOneHourTtlDeep(nested))
}

/**
 * Collect the full set of body fields to strip for `modelName`:
 *   - built-in defaults (e.g. inference_geo)
 *   - config-sourced `anthropic.retry_reject_body_fields` (per-model substring, `"*"` = all)
 *   - runtime-learned negotiation cache (per-(endpoint, model))
 *
 * Use `getUnsupportedFeatures(model)` rather than per-field probing so this
 * stays O(1) over the negotiation map size.
 */
function collectRejectedFields(modelName: string): Set<string> {
  const reject = new Set<string>(BUILTIN_REJECTED_FIELDS)
  for (const fields of collectAllMatching(modelName, state.rejectBodyFields)) {
    for (const field of fields) reject.add(field)
  }
  for (const field of getUnsupportedFeatures(modelName)) reject.add(field)
  return reject
}

/**
 * Return the set of beta tokens that should be stripped for `modelName`,
 * combining config-sourced `stripBetaHeaders` and runtime-learned entries.
 * The pseudo-key `"*"` in config applies to every model.
 */
function collectStripBetas(modelName: string): Set<string> {
  const strip = new Set<string>()
  for (const tokens of collectAllMatching(modelName, state.stripBetaHeaders)) {
    for (const token of tokens) strip.add(token)
  }
  return strip
}

/**
 * Partner-model feature names (e.g. `structured_outputs`) the operator declared
 * disallowed via config `anthropic.partner_strip_features`. The config twin of
 * the `partnerFeatures` negotiation cache — union'd at the strip step, exactly
 * like `collectStripBetas` ∪ the beta negotiation cache. `"*"` applies to all.
 */
function collectStripPartnerFeatures(modelName: string): Set<string> {
  const strip = new Set<string>()
  for (const features of collectAllMatching(modelName, state.stripPartnerFeatures)) {
    for (const feature of features) strip.add(feature)
  }
  return strip
}

/**
 * Drop beta tokens that are known-unsupported for `modelName`. Returns the
 * filtered comma-separated header value, or `undefined` if nothing remains.
 *
 * Filter sources, unioned:
 *   - Config `stripBetaHeaders` (per-model + wildcard "*")
 *   - Persistent negotiation cache (runtime-learned across requests)
 *   - `excludeBetas` — per-attempt hint passed from a retry strategy via
 *     `PrepareHints.excludeBetas`. Makes intra-retry exclusion deterministic
 *     without depending on cache having been written.
 */
export function filterUnsupportedBetas(modelName: string, merged: string | undefined, excludeBetas?: ReadonlyArray<string>): string | undefined {
  if (!merged) return undefined
  const configStrip = collectStripBetas(modelName)
  const hintStrip = new Set(excludeBetas ?? [])
  const kept: Array<string> = []
  const dropped: Array<string> = []
  for (const raw of merged.split(",")) {
    const token = raw.trim()
    if (!token) continue
    if (configStrip.has(token) || hintStrip.has(token) || isAnthropicBetaUnsupported(modelName, token)) {
      dropped.push(token)
      continue
    }
    kept.push(token)
  }
  if (dropped.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped unsupported beta(s) for ${modelName}: ${dropped.join(", ")}`)
  }
  return kept.length > 0 ? kept.join(",") : undefined
}

/**
 * Build the request headers from the prepared wire body (B7–B12). Kept cohesive
 * as one step: `contextManagementDisabled` gates the context_management body
 * delete, the beta-header build, AND the context_management auto-injection, and
 * the beta sub-pipeline (build → merge → filter) threads a single local value —
 * splitting them would scatter that shared intermediate state (the same honest
 * in-step coupling as sanitize's A6<A8). Reads ctx.wire + ctx.opts, writes
 * ctx.headers (and may add/remove ctx.wire.context_management).
 */
function buildAnthropicHeaders(ctx: PrepareContext): void {
  const { wire, opts } = ctx
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const thinking = wire.thinking as MessagesPayload["thinking"]

  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  const isAgent = isAgentCall(messages)
  const modelSupportsVision = opts.resolvedModel?.capabilities?.supports?.vision !== false
  // context_management body field is stripped by buildWirePayload when the negotiation
  // cache or rejectBodyFields config marks it unsupported. We also need to suppress
  // the matching beta header and any subsequent auto-injection by the contextEditingMode
  // logic. The signal source is the negotiation cache (config-driven strip implies
  // the operator already knows it's unsupported but is independent of the cache).
  const contextManagementDisabled = wire.context_management === null || isAnthropicFeatureUnsupported(model, "context_management")

  if (contextManagementDisabled) {
    delete wire.context_management
  }

  // L2 escalation (RFC §8): force-inject an aggressive `clear_tool_uses` on retry regardless of
  // `contextEditingMode`, gated by model support + not-disabled + no client-provided
  // context_management. Computed HERE (before the beta build) so the beta header includes
  // `context-management-2025-06-27` whenever escalation will inject the body — the body without its
  // beta 400s upstream (the bug the mode-off force-inject would otherwise hit).
  const escalating = Boolean(opts.contextEscalation) && modelSupportsContextEditing(model, opts.resolvedModel)
  const willInjectEscalation = escalating && !contextManagementDisabled && !("context_management" in wire)

  const localBeta = buildAnthropicBetaHeaders(model, opts.resolvedModel, {
    disableContextManagement: contextManagementDisabled,
    forceContextManagementBeta: willInjectEscalation,
    emitExtendedCacheTtlBeta: ctx.wroteExtendedTtl,
    forceMemoryContextBeta: ctx.hasMemoryTool,
  })
  const mergedBeta = mergeAnthropicBeta(opts.clientAnthropicBeta, localBeta["anthropic-beta"])
  const filteredBeta = filterUnsupportedBetas(model, mergedBeta, opts.excludeBetas)

  // Core = the proxy's own upstream headers, ALWAYS authoritative. anthropic-beta
  // is folded in HERE (before passthrough/strip) so it lives in `core` and is
  // therefore immune to both client override and the strip glob below.
  const core: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts.resolvedModel?.request_headers,
      intent: isAgent ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgent ? "agent" : "user",
    "anthropic-version": "2023-06-01",
  }
  if (filteredBeta) core["anthropic-beta"] = filteredBeta

  // Client-header forwarding policy, two modes selected by `strict_request_headers`.
  // BOTH modes share the same security floor: `selectPassthroughHeaders` removes EVERY
  // core key (lowercased, dynamically derived so it covers vision + modelRequestHeaders)
  // plus the sensitive denylist (credentials + framing) BEFORE the mode split — so the
  // whitelist can never re-admit a credential. The guard is NOT the spread order:
  // `new Headers()` JOINS case-variant duplicate keys ("authorization" + "Authorization"
  // → "a, b"), so the floor removes them by name first → selected ∩ core = ∅, and
  // `{ ...selected, ...core }` is collision-free with core authoritative.
  //   - blacklist mode (strict_request_headers: false): keep the safe set MINUS the
  //     `request_header_blacklist` globs. `["*"]` empties the set (back to core-only).
  //   - whitelist mode (strict_request_headers: true): keep ONLY the safe-set headers
  //     matching `request_header_whitelist` globs. `[]` → core-only (old strict behavior).
  let headers = core
  if (opts.clientRequestHeaders) {
    const coreLower = new Set(Object.keys(core).map((k) => k.toLowerCase()))
    // copilot-vision-request is a conditional core key (set only when vision is on).
    // Reserve it unconditionally so a client can't forge it on a non-vision request.
    coreLower.add("copilot-vision-request")
    const safe = selectPassthroughHeaders(opts.clientRequestHeaders, coreLower)
    const selected = state.strictRequestHeaders ? keepHeaders(safe, state.requestHeaderWhitelist) : pruneHeaders(safe, state.requestHeaderBlacklist)
    headers = { ...selected, ...core }
  }

  // Context_management injection: normally gated by `contextEditingMode != off` (isContextEditingEnabled).
  // L2 escalation (opts.contextEscalation) ALSO injects — FORCING an aggressive clear_tool_uses even
  // when context_editing is off (and adding its beta header above). Escalation takes precedence over
  // the config-driven build; the gates (model support + not-disabled + no client context_management)
  // were already folded into `willInjectEscalation` for the beta header.
  //
  // NOTE (deliberate): the `!("context_management" in wire)` gate means escalation does NOT override a
  // CLIENT-PROVIDED `context_management` — the client's explicit context policy is respected even on a
  // transparent retry. A client that manages its own context owns that choice; escalation only fills
  // the gap when the proxy is the one managing context (RFC §8 / §12 Q5).
  if (!contextManagementDisabled && !("context_management" in wire) && (isContextEditingEnabled(model, opts.resolvedModel) || escalating)) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(state.contextEditingMode, hasThinking, escalating ? opts.contextEscalation : undefined)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  ctx.headers = headers
}

/**
 * The Anthropic prepare pipeline — a FIXED ordered list of named steps (B3–B12).
 * Unlike the S3 request rewrites (which filter via appliesTo + sort), prepare is
 * an unfiltered fixed sequence: every step always runs and self-gates on config/
 * model internally, so declaration order IS the contract (no order keys / sort).
 * B1+B2 (buildWirePayload: reject-field strip + server-tool strip) is the ctx
 * initializer that creates the wire the steps mutate.
 *
 * Thinking transforms keep their fixed order (B3<B4<B5): coerce the SHAPE first
 * (enabled→adaptive for adaptive-only models, else adaptive→enabled for
 * enabled-only models), then clamp the budget (a no-op once adaptive), then clamp
 * the effort against the model whitelist — so an out-of-range value the coerce
 * steps map can't reach upstream.
 */
export const ANTHROPIC_PREPARE_STEPS: ReadonlyArray<PrepareStep> = [
  { name: "coerce-thinking", apply: (ctx) => coerceAdaptiveThinking(ctx.wire, ctx.opts.resolvedModel) },
  { name: "coerce-enabled-thinking", apply: (ctx) => coerceEnabledThinking(ctx.wire, ctx.opts.resolvedModel) },
  { name: "adjust-budget", apply: (ctx) => adjustThinkingBudget(ctx.wire, ctx.opts.resolvedModel) },
  { name: "clamp-effort", apply: (ctx) => clampEffortLevel(ctx.wire, ctx.opts.resolvedModel) },
  { name: "strip-partner-features", apply: (ctx) => stripUnsupportedPartnerFeatures(ctx.wire) },
  { name: "rewrite-memory-tool", apply: rewriteMemoryTool },
  { name: "cache-control", apply: (ctx) => applyCacheControlMode(ctx) },
  { name: "build-headers", apply: buildAnthropicHeaders },
]

/**
 * Derive the final wire (body + headers) for one upstream attempt. Initializes
 * the prepare context from the payload (buildWirePayload = B1+B2) then runs the
 * ordered prepare steps. Called per-attempt — PrepareHints in opts (excludeBetas
 * / rejectFields) vary per retry.
 *
 * `steps` defaults to {@link ANTHROPIC_PREPARE_STEPS}; the param is a DI seam for
 * tests (assert the runner iterates the list) and P2's driver (which assembles
 * the prepareWire chain and feeds per-step `request.rewrite_applied` events).
 */
export function prepareAnthropicRequest(
  payload: MessagesPayload,
  opts?: PrepareAnthropicRequestOptions,
  steps: ReadonlyArray<PrepareStep> = ANTHROPIC_PREPARE_STEPS,
): PreparedAnthropicRequest {
  const ctx: PrepareContext = {
    wire: buildWirePayload(payload, opts?.rejectFields, opts?.excludeServerToolTypes, opts?.excludeToolFields),
    headers: {},
    opts: opts ?? {},
  }
  for (const step of steps) step.apply(ctx)
  return { wire: ctx.wire, headers: ctx.headers }
}

function buildWirePayload(
  payload: MessagesPayload,
  rejectFields?: ReadonlyArray<string>,
  excludeServerToolTypes?: ReadonlyArray<string>,
  excludeToolFields?: ReadonlyArray<string>,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  const rejected = collectRejectedFields(payload.model)
  if (rejectFields) {
    for (const f of rejectFields) rejected.add(f)
  }
  const rejectedFields: Array<string> = []

  // Fields that prepare-time transforms (applyCacheControlMode,
  // stripServerTools, clampEffortLevel, adjustThinkingBudget, etc.) mutate
  // via walkCacheControlArray, direct splice, or property assignment.
  // Without deep-cloning these into the wire object, the mutations leak back
  // into the caller's payload — and on retry, the next prep step sees an
  // already-stripped / already-clamped payload, accumulating losses across
  // attempts.
  //
  // Add to this set whenever a new mutate-in-place transform targets a
  // nested payload field; the set is the single source of "what wire owns
  // exclusively" so we don't grow an ad-hoc collection of one-off clones.
  const DEEP_CLONE_FIELDS = new Set(["messages", "system", "tools", "output_config", "thinking"])

  for (const [key, value] of Object.entries(payload)) {
    if (rejected.has(key)) {
      rejectedFields.push(key)
    } else if (DEEP_CLONE_FIELDS.has(key) && value !== undefined && value !== null) {
      wire[key] = structuredClone(value)
    } else {
      wire[key] = value
    }
  }

  if (rejectedFields.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped rejected fields: ${rejectedFields.join(", ")}`)
  }

  if (wire.tools) {
    wire.tools = stripServerTools(wire.tools as Array<Tool>, payload.model, excludeServerToolTypes)
  }
  if (wire.tools) {
    wire.tools = stripToolFields(wire.tools as Array<Tool>, payload.model, excludeToolFields)
  }

  return wire
}

// ============================================================================
// Adaptive thinking coercion
// ============================================================================

/**
 * Coerce a legacy `thinking: { type: "enabled", budget_tokens }` to
 * `{ type: "adaptive" }` when the target model only supports adaptive thinking.
 *
 * Old clients (e.g. older Claude Code CLI) send the pre-adaptive shape, which
 * adaptive-only models (opus 4.6/4.7/4.8) reject with HTTP 400
 * (`"thinking.type.enabled" is not supported for this model`). GHC constructs
 * `{ type: "adaptive" }` (no budget_tokens) for these models, so coercing to
 * the same shape matches the upstream contract.
 *
 * - Only touches `type: "enabled"`; adaptive/disabled are left as-is (no-op).
 * - Gated on modelHasAdaptiveThinking (metadata + name fallback).
 * - Preserves the `display` field (summarized/omitted) for multi-turn signature
 *   continuity.
 * - In `"best_effort"` mode, maps budget_tokens to output_config.effort, but
 *   only when the client did not already send an explicit effort.
 */
function coerceAdaptiveThinking(wire: Record<string, unknown>, resolvedModel?: Model): void {
  if (state.coerceAdaptiveThinking === false) return

  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type !== "enabled") return

  const model = wire.model as string
  if (!modelHasAdaptiveThinking(model, resolvedModel)) return

  // Map budget→effort BEFORE clampEffortLevel runs, and only when the client did
  // not send an explicit effort (never override the client's intent).
  if (state.coerceAdaptiveThinking === "best_effort") {
    const outputConfig = wire.output_config as OutputConfig | undefined
    if (!outputConfig?.effort) {
      const effort = budgetToEffort(thinking.budget_tokens)
      if (effort) wire.output_config = { ...outputConfig, effort }
    }
  }

  const display = (thinking as { display?: string }).display
  wire.thinking = { type: "adaptive", ...(display ? { display } : {}) }
  consola.debug(`[DirectAnthropic] Coerced legacy thinking enabled→adaptive (model=${model})`)
}

/**
 * Coerce `thinking: { type: "adaptive" }` to `{ type: "enabled", budget_tokens }`
 * when the target model only accepts the budget-based (enabled) thinking shape.
 *
 * The mirror of {@link coerceAdaptiveThinking}: newer clients (e.g. Claude Code
 * whose main model is an adaptive opus) reuse their `adaptive` thinking config
 * for fast subagent calls routed to a NON-adaptive model (e.g. haiku-4.5), which
 * rejects `adaptive` with HTTP 400 ("adaptive thinking is not supported on this
 * model"). GHC constructs the enabled shape for these models, so coercing to it
 * matches the upstream contract.
 *
 * - Only touches `type: "adaptive"`; enabled/disabled are left as-is (no-op).
 * - Gated on a POSITIVE enabled-only signal ({@link modelRequiresEnabledThinking}
 *   = `max_thinking_budget > 0` AND not adaptive). Predictive normalization must
 *   never downgrade a model that might in fact be adaptive but whose metadata has
 *   not loaded yet — that silent case is left to the reactive
 *   `adaptive-thinking-rejection-retry` strategy (ground-truth 400).
 * - Folds `output_config.effort` into `budget_tokens` (adjustThinkingBudget then
 *   clamps it to the model window) and drops the now-redundant effort dimension.
 * - Preserves the `display` field for multi-turn signature continuity.
 */
function coerceEnabledThinking(wire: Record<string, unknown>, resolvedModel?: Model): void {
  if (state.coerceAdaptiveThinking === false) return

  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type !== "adaptive") return

  if (!modelRequiresEnabledThinking(resolvedModel)) return

  const outputConfig = wire.output_config as OutputConfig | undefined
  const display = (thinking as { display?: string }).display
  wire.thinking = adaptiveToEnabledThinking(outputConfig?.effort, display)

  // `effort` is the adaptive-only intensity dimension — now folded into
  // budget_tokens, so drop it (keep any other output_config fields, e.g. format).
  if (outputConfig?.effort !== undefined) {
    const { effort: _effort, ...rest } = outputConfig
    if (Object.keys(rest).length === 0) delete wire.output_config
    else wire.output_config = rest
  }

  const model = wire.model as string
  consola.debug(`[DirectAnthropic] Coerced adaptive thinking→enabled (model=${model})`)
}

function adjustThinkingBudget(wire: Record<string, unknown>, resolvedModel?: Model): void {
  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type === "disabled" || thinking.type === "adaptive") return

  const budgetTokens = thinking.budget_tokens
  if (!budgetTokens) return

  let adjusted = budgetTokens
  const minBudget = resolvedModel?.capabilities?.supports?.min_thinking_budget
  const maxBudget = resolvedModel?.capabilities?.supports?.max_thinking_budget
  const maxTokens = wire.max_tokens as number | undefined

  if (typeof minBudget === "number" && adjusted < minBudget) {
    adjusted = minBudget
  }

  if (typeof maxBudget === "number" && adjusted > maxBudget) {
    adjusted = maxBudget
  }

  if (typeof maxTokens === "number" && adjusted >= maxTokens) {
    adjusted = maxTokens - 1
    // The max_tokens ceiling can force the budget below the model's min (the min
    // clamp ran first). That combination is unsatisfiable — Anthropic requires
    // both budget_tokens < max_tokens AND budget_tokens >= min — so upstream will
    // reject. Surface it loudly rather than emitting a silently-invalid budget;
    // the honest resolution (raise max_tokens vs disable thinking) is deferred —
    // see docs/todo/deferred-backlog.md.
    if (typeof minBudget === "number" && adjusted < minBudget) {
      consola.warn(
        `[DirectAnthropic] max_tokens=${maxTokens} cannot host min thinking budget=${minBudget} (model=${wire.model as string}); budget_tokens=${adjusted} is below the model minimum and will likely be rejected upstream`,
      )
    }
  }

  if (adjusted !== budgetTokens) {
    ;(wire.thinking as { budget_tokens: number }).budget_tokens = adjusted
    consola.debug(`[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} (max_tokens=${maxTokens})`)
  }
}

// ============================================================================
// Effort level clamping
// ============================================================================

/**
 * Parse an `invalid_reasoning_effort` upstream error and extract the supported values.
 * Example error body:
 *   {"error":{"message":"output_config.effort \"high\" is not supported by model claude-opus-4.7; supported values: [medium]","code":"invalid_reasoning_effort"}}
 *
 * Returns { modelName, supported } if the error matches, otherwise null.
 */
export function parseInvalidEffortError(responseText: string): { modelName: string; supported: Array<string> } | null {
  // Find the "supported values: [...]" list and the "model X;" identifier.
  // The outer JSON may be double-wrapped so operate on the raw text.
  const codeMatch = responseText.includes("invalid_reasoning_effort")
  if (!codeMatch) return null

  const modelMatch = /by model ([^;"]+)[;"]/.exec(responseText)
  const supportedMatch = /supported values:\s*\[([^\]]*)\]/.exec(responseText)
  if (!modelMatch || !supportedMatch) return null

  const modelName = modelMatch[1].trim()
  const supported = supportedMatch[1]
    .split(",")
    .map((s) => s.trim().replaceAll(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)

  if (supported.length === 0) return null
  return { modelName, supported }
}

/**
 * Parse the ZERO-support effort variant: `output_config.effort "X" was provided,
 * but model <M> does not support reasoning effort` (code invalid_reasoning_effort,
 * NO `supported values:[...]` list). Distinct from parseInvalidEffortError (which
 * requires the supported list). Returns the model name, or null when not this variant.
 */
export function parseEffortUnsupportedError(responseText: string): string | null {
  if (!responseText.includes("invalid_reasoning_effort")) return null
  if (!/does not support reasoning effort/i.test(responseText)) return null
  const m = /model ([^;"]+?) does not support reasoning effort/i.exec(responseText)
  return m ? m[1].trim() : null
}

/**
 * Dynamically record per-model effort whitelists discovered from upstream
 * `invalid_reasoning_effort` errors. Persisted via the negotiation cache.
 * Config-sourced `effortsOverrides` remains untouched. Returns true if the
 * cache was updated (first-time learn or value changed).
 */
export function learnEffortsFromError(responseText: string): boolean {
  const parsed = parseInvalidEffortError(responseText)
  if (!parsed) {
    // Zero-support variant (no supported list): learn "known-unsupported" so
    // clampEffortLevel strips output_config.effort on the retried attempt.
    const unsupportedModel = parseEffortUnsupportedError(responseText)
    if (unsupportedModel) {
      markEffortUnsupported(unsupportedModel)
      consola.info(`[DirectAnthropic] Learned ${unsupportedModel} supports NO reasoning effort; will strip output_config.effort.`)
      return true
    }
    return false
  }

  const existing = getSupportedEfforts(parsed.modelName)
  const isFirstLearn = !existing
  const changed = setSupportedEfforts(parsed.modelName, parsed.supported)
  if (!changed) return false

  if (isFirstLearn) {
    consola.info(`[DirectAnthropic] Learned supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`)
  } else {
    consola.debug(`[DirectAnthropic] Updated supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`)
  }
  return true
}

/**
 * Find the supported-effort whitelist for a given model name.
 *
 * Priority (highest → lowest):
 *   1. Config-sourced `effortsOverrides` (explicit operator override).
 *      Matched via most-specific key (longest substring); the pseudo-key `"*"`
 *      is a wildcard fallback. Switching from union to most-specific avoids the
 *      bug where a shorter family key (e.g. `claude-opus-4.7`) would shadow a
 *      stricter variant-specific entry (e.g. `claude-opus-4.7-high`).
 *   2. Runtime-learned entries from the negotiation cache (persisted).
 *   3. Model metadata `capabilities.supports.reasoning_effort` (upstream declaration).
 *
 * Reading metadata as a fallback lets us skip the first-round 400 for models
 * that declare effort support upfront (mirrors GHC #5010 precheck), while still
 * allowing operators to override via config when metadata is inaccurate.
 *
 * Cross-validation: when config or learned values include efforts not declared
 * by the model metadata, those out-of-range entries are dropped and warned.
 * Operator intent is preserved for values that ARE in the metadata; only the
 * unsupported tail is trimmed. If the intersection is empty (operator wrote a
 * whitelist that the model rejects entirely), we trust the metadata over the
 * stale config to avoid guaranteed 400s.
 */
export function findSupportedEfforts(modelName: string, resolvedModel?: Model): Array<string> | undefined {
  const rawMetadata = resolvedModel?.capabilities?.supports?.reasoning_effort
  const metadataEfforts = Array.isArray(rawMetadata) && rawMetadata.length > 0 ? rawMetadata : undefined
  const metadataSet = metadataEfforts ? new Set(metadataEfforts) : undefined

  const fromConfig = findMostSpecific(modelName, state.effortsOverrides)
  if (fromConfig && fromConfig.length > 0) {
    return reconcileWithMetadata(fromConfig, metadataSet, modelName, "config")
  }
  const learned = getSupportedEfforts(modelName)
  if (learned && learned.length > 0) {
    return reconcileWithMetadata(learned, metadataSet, modelName, "learned")
  }
  if (metadataEfforts) return metadataEfforts
  return undefined
}

/**
 * Intersect a configured/learned effort whitelist with the model's declared
 * metadata set, logging any out-of-range entries. Returns the intersection
 * when non-empty; otherwise falls back to the metadata list (or the original
 * whitelist if metadata is unavailable).
 */
function reconcileWithMetadata(whitelist: Array<string>, metadataSet: Set<string> | undefined, modelName: string, source: "config" | "learned"): Array<string> {
  if (!metadataSet) return whitelist
  const kept: Array<string> = []
  const dropped: Array<string> = []
  for (const effort of whitelist) {
    if (metadataSet.has(effort)) kept.push(effort)
    else dropped.push(effort)
  }
  if (dropped.length === 0) return whitelist
  if (kept.length === 0) {
    consola.warn(
      `[DirectAnthropic] ${source} effort whitelist for ${modelName} has no overlap with model metadata [${[...metadataSet].join(", ")}]; falling back to metadata. Dropped: [${dropped.join(", ")}]`,
    )
    return [...metadataSet]
  }
  consola.warn(
    `[DirectAnthropic] ${source} effort whitelist for ${modelName} dropped out-of-range values [${dropped.join(", ")}] not in model metadata [${[...metadataSet].join(", ")}]`,
  )
  return kept
}

/**
 * Pre-emptively strip disallowed partner-model features from the wire, driven by
 * the shared {@link PARTNER_FEATURE_STRIP_TARGETS} table (the same table the
 * reactive `structured-outputs-rejection-retry` strategy consults). For each
 * feature in the table, strip its wire field when the resolved model's upstream
 * is known to disallow it — learned reactively (negotiation `partnerFeatures`
 * cache) OR declared by the operator (config `anthropic.partner_strip_features`).
 * Same config ∪ cache union as betas.
 *
 * Today the table holds exactly `structured_outputs → output_config.format`:
 * some GHC accounts route to Vertex AI where the org policy
 * `constraints/vertexai.allowedPartnerModelFeatures` blocks `structured_outputs`
 * for the partner Claude model, returning a 400. The rejection strategy records
 * the incompatibility in the cache; declaring it in config makes the strip
 * first-request-durable. Either way this step pre-emptively strips the field so
 * requests don't re-pay a failed upstream round-trip. Sibling `output_config`
 * keys (e.g. `effort`) are preserved; an emptied `output_config` is dropped.
 * Adding a partner feature is a table (data) change — this loop needs no edit.
 */
function stripUnsupportedPartnerFeatures(wire: Record<string, unknown>): void {
  const modelName = wire.model as string | undefined
  if (!modelName) return

  const declared = collectStripPartnerFeatures(modelName)
  for (const feature of Object.keys(PARTNER_FEATURE_STRIP_TARGETS)) {
    const disallowed = isAnthropicPartnerFeatureUnsupported(modelName, feature) || declared.has(feature)
    if (!disallowed) continue
    if (stripPartnerFeatureFromWire(wire, feature)) {
      consola.debug(`[DirectAnthropic] Stripped partner feature "${feature}" wire field (disallowed, model=${modelName})`)
    }
  }
}

/**
 * Adjust output_config.effort to fit the supported whitelist for the resolved model.
 * Always clamps to the nearest supported value:
 *   - Above max supported → max supported
 *   - Below min supported → min supported
 *   - Within range → pass through
 *
 * Some models (e.g. opus 4.6-1m) only support low/medium/high and reject xhigh/max.
 * Some models (e.g. opus 4.7) only support medium.
 */
function clampEffortLevel(wire: Record<string, unknown>, resolvedModel?: Model): void {
  const outputConfig = wire.output_config as OutputConfig | undefined
  if (!outputConfig?.effort) return

  const modelName = resolvedModel?.id ?? (wire.model as string)
  if (!modelName) return

  // Zero-support variant (learned from a `does not support reasoning effort` 400):
  // the model supports NO reasoning effort at all. Strip the field entirely (drop
  // output_config if it empties) BEFORE the whitelist/clamp logic below.
  if (isEffortUnsupported(modelName)) {
    const { effort: _effort, ...rest } = outputConfig
    if (Object.keys(rest).length > 0) {
      wire.output_config = rest
    } else {
      delete wire.output_config
    }
    consola.debug(`[DirectAnthropic] Stripped output_config.effort (model=${modelName} supports no reasoning effort)`)
    return
  }

  const supported = findSupportedEfforts(modelName, resolvedModel)
  if (!supported) return

  // Compute min/max indices of supported efforts
  const supportedIndices = supported.map((e) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number])).filter((i) => i >= 0)
  if (supportedIndices.length === 0) return

  const minIndex = Math.min(...supportedIndices)
  const maxIndex = Math.max(...supportedIndices)
  const minEffort = EFFORT_LEVELS[minIndex]
  const maxEffort = EFFORT_LEVELS[maxIndex]

  const currentIndex = EFFORT_LEVELS.indexOf(outputConfig.effort as (typeof EFFORT_LEVELS)[number])
  // Unknown effort level — treat as overflow (above max)
  const isOverflow = currentIndex === -1 || currentIndex > maxIndex
  const isUnderflow = currentIndex >= 0 && currentIndex < minIndex

  if (isOverflow) {
    const original = outputConfig.effort
    ;(wire.output_config as OutputConfig).effort = maxEffort
    consola.debug(`[DirectAnthropic] Clamped output_config.effort: ${original} → ${maxEffort} (model=${modelName})`)
  } else if (isUnderflow) {
    const original = outputConfig.effort
    ;(wire.output_config as OutputConfig).effort = minEffort
    consola.debug(`[DirectAnthropic] Raised output_config.effort: ${original} → ${minEffort} (model=${modelName})`)
  }
  // else: currentIndex within [min, max], pass through
}

// ============================================================================
// Memory tool
// ============================================================================

/**
 * Rewrite a client tool named `memory` to Anthropic's native `{name:"memory", type:"memory_20250818"}`
 * server tool, mirroring GHC's BYOK path (anthropicProvider.ts). Gated by the `memoryToolEnabled` master
 * switch (default off — CAPI acceptance unverified) AND model support. Drops the client tool's
 * input_schema / description / cache_control (server tools carry none). Sets `ctx.hasMemoryTool` so
 * build-headers forces the shared context-management beta. Matched by NAME because an earlier stage
 * (preprocessTools) may already have added an input_schema to the plain `{name:"memory"}` tool.
 *
 * Runs BEFORE the cache-control step so proxied/sanitize see the final server-tool shape — the
 * server-tool is excluded from cache anchoring anyway (see addToolCacheControl), so it never carries a
 * breakpoint.
 */
function rewriteMemoryTool(ctx: PrepareContext): void {
  if (!state.memoryToolEnabled) return
  const model = ctx.wire.model as string
  if (!modelSupportsMemory(model, ctx.opts.resolvedModel)) return
  const tools = ctx.wire.tools
  if (!Array.isArray(tools)) return

  const isMemoryClientTool = (tool: unknown): boolean =>
    Boolean(tool) && typeof tool === "object" && (tool as { name?: unknown }).name === "memory" && (tool as { type?: unknown }).type === undefined

  if (!tools.some((tool) => isMemoryClientTool(tool))) return
  ctx.wire.tools = tools.map((tool) => (isMemoryClientTool(tool) ? { name: "memory", type: "memory_20250818" } : tool))
  ctx.hasMemoryTool = true
}

// ============================================================================
// Cache control
// ============================================================================

/**
 * Dispatch cache_control handling based on the configured mode.
 * - disabled:    strip all cache_control from the wire payload
 * - passthrough: leave everything as-is
 * - sanitize:    normalize all cache_control to { type: "ephemeral" }
 * - proxied:     strip client cache_control then auto-inject breakpoints —
 *                message-level breakpoints first (GHC `addCacheBreakpoints`
 *                strategy, caches the growing conversation), then tools+system
 *                with any spare slots.
 */
function applyCacheControlMode(ctx: PrepareContext): void {
  const { wire } = ctx
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"] | undefined

  // Extended TTL upgrades the breakpoints WE write (proxied/sanitize). Gated by the master switch,
  // model support, and an agent-style request (GHC's Agent-location analog). When inactive, both
  // layers stay at the 5m default — identical to the pre-feature behavior.
  const extendedTtlActive = state.extendedCacheTtlEnabled && modelSupportsExtendedCacheTtl(model, ctx.opts.resolvedModel) && isAgentCall(messages)
  const { toolsSystem, messages: messagesTtl } = extendedTtlActive ? resolveExtendedTtls() : { toolsSystem: "5m" as CacheTtl, messages: "5m" as CacheTtl }
  const toolsSystemEphemeral = ephemeralFor(toolsSystem)
  const messagesEphemeral = ephemeralFor(messagesTtl)

  switch (state.cacheControlMode) {
    case "disabled": {
      walkCacheControl(wire, () => undefined)
      break
    }
    case "passthrough": {
      break
    }
    case "sanitize": {
      // 收窄语义（spec §4）：保留客户端合法 ttl（不再无条件降 5m），剥非白名单子字段（scope 等），
      // 跨层单调化满足 Anthropic tools→system→messages 递减约束。TTL 决策归 resolveSanitizedTtls。
      const clientMax = collectPerLayerClientTtls(wire)
      const ttls = resolveSanitizedTtls(clientMax, extendedTtlActive, { toolsSystem, messages: messagesTtl })
      // 同层统一为 effective ttl（规范化）；ephemeralFor 只产 {type,ttl?} → scope 等子字段自动剥除。
      // handler 仅对有断点的 item 调用 → ttls[section] 必非 undefined（?? "5m" 仅防御性兜底）。
      walkCacheControl(wire, (_current, section) => ephemeralFor(ttls[section] ?? "5m"))
      break
    }
    case "proxied": {
      // Match GHC behavior: strip all client cache_control first, then inject our own.
      // GHC reconstructs content from scratch so client cache_control never passes through;
      // only proxy-controlled breakpoints exist in the final payload.
      walkCacheControl(wire, () => undefined)
      // Message-level breakpoints (GHC's primary strategy) before tools+system
      // fallback; the latter recomputes its budget from existing breakpoints, so
      // message breakpoints injected here automatically reduce its spare slots.
      addMessageCacheControl(wire.messages as Array<MessageParam> | undefined, messagesEphemeral)
      addToolsAndSystemCacheControl(wire, toolsSystemEphemeral)
      break
    }
    default: {
      // Exhaustive switch over CacheControlMode union; future modes added to the
      // type must update this switch — `default` is a safety net for runtime
      // values from configs that bypass type checking.
      break
    }
  }

  // Header mirrors body: emit the beta iff a 1h ttl actually landed in the wire (our write OR a
  // passthrough client breakpoint). Independent of `extendedTtlActive` so passthrough 1h is covered.
  ctx.wroteExtendedTtl = wireHasOneHourTtl(wire)
}

function addToolsAndSystemCacheControl(wire: Record<string, unknown>, ephemeral: EphemeralCacheControl): void {
  let remaining = CACHE_CONTROL_BREAKPOINT_LIMIT - countExistingCacheBreakpoints(wire)
  if (remaining <= 0) return

  const toolResult = addToolCacheControl(wire.tools as Array<Tool> | undefined, remaining, ephemeral)
  if (toolResult.changed) {
    wire.tools = toolResult.tools
    remaining = toolResult.remaining
  }

  if (remaining <= 0) return

  const systemResult = addSystemCacheControl(wire.system as MessagesPayload["system"], remaining, ephemeral)
  if (systemResult.changed) {
    wire.system = systemResult.system
  }
}

function countExistingCacheBreakpoints(wire: Record<string, unknown>): number {
  return countCacheControlOccurrences(wire.messages) + countCacheControlOccurrences(wire.system) + countCacheControlOccurrences(wire.tools)
}

function countCacheControlOccurrences(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count: number, item): number => count + countCacheControlOccurrences(item), 0)
  }

  if (!value || typeof value !== "object") {
    return 0
  }

  const record = value as Record<string, unknown>
  let count = record.cache_control ? 1 : 0

  for (const nested of Object.values(record)) {
    if (nested !== record.cache_control) {
      count += countCacheControlOccurrences(nested)
    }
  }

  return count
}

function addToolCacheControl(
  tools: Array<Tool> | undefined,
  remaining: number,
  ephemeral: EphemeralCacheControl,
): { tools: Array<Tool> | undefined; remaining: number; changed: boolean } {
  if (!tools || remaining <= 0) {
    return { tools, remaining, changed: false }
  }

  // Anchor on the last non-deferred FUNCTION tool. Server tools (those carrying a `type`, e.g.
  // `tool_search_tool_regex` or the rewritten `memory_20250818`) are excluded — they don't accept a
  // cache_control breakpoint and a 1h/5m marker on them would 400 upstream.
  const lastNonDeferredIndex = findLastIndex(tools, (tool) => tool.defer_loading !== true && (tool as { type?: unknown }).type === undefined)
  if (lastNonDeferredIndex < 0 || tools[lastNonDeferredIndex].cache_control) {
    return { tools, remaining, changed: false }
  }

  const updatedTools = [...tools]
  updatedTools[lastNonDeferredIndex] = {
    ...updatedTools[lastNonDeferredIndex],
    cache_control: ephemeral,
  }
  return { tools: updatedTools, remaining: remaining - 1, changed: true }
}

function addSystemCacheControl(
  system: MessagesPayload["system"] | undefined,
  remaining: number,
  ephemeral: EphemeralCacheControl,
): { system: MessagesPayload["system"] | undefined; changed: boolean } {
  if (!Array.isArray(system) || remaining <= 0) {
    return { system, changed: false }
  }

  const lastSystemIndex = system.length - 1
  if (lastSystemIndex < 0 || system[lastSystemIndex].cache_control) {
    return { system, changed: false }
  }

  const updatedSystem = [...system]
  updatedSystem[lastSystemIndex] = {
    ...updatedSystem[lastSystemIndex],
    cache_control: ephemeral,
  }
  return { system: updatedSystem, changed: true }
}

function findLastIndex<T>(items: Array<T>, predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return index
    }
  }

  return -1
}

// ============================================================================
// Message-level cache breakpoints (proxied mode)
// ============================================================================

/**
 * Inject cache_control breakpoints into the message history, porting GHC's
 * `addCacheBreakpoints` strategy (refs `cacheBreakpoints.ts`). Walks messages in
 * reverse placing ephemeral breakpoints on: the last tool_result of each round
 * below the current user message, the current (plain) user message, and terminal
 * assistant messages (no tool_use) above it — caching the growing conversation
 * prefix. Runs before `addToolsAndSystemCacheControl`, which then claims spare slots.
 *
 * GHC role → Anthropic block mapping: GHC's `Tool` role = a user message containing
 * tool_result blocks (`isToolResultMessage`); GHC's `User` role = a user message
 * WITHOUT tool_result (a real prompt); GHC's `Assistant` with no tool calls = an
 * assistant message with no tool_use block. Inline `role:"system"` messages (which
 * survive when `systemDefaultMode` is off) are skipped without flipping
 * `isBelowCurrentUserMessage`, mirroring GHC's first-pass handling of
 * `Raw.ChatRole.System`.
 *
 * Note: GHC runs on the pre-merge `Raw.ChatMessage[]` (one Tool message per result);
 * here the wire is post-merge, so a round's parallel tool_results already sit in one
 * user message — the per-round breakpoint count matches because merge collapses what
 * GHC's `isLastToolResultInRound` de-duplicates.
 */
function addMessageCacheControl(messages: Array<MessageParam> | undefined, ephemeral: EphemeralCacheControl): void {
  if (!Array.isArray(messages) || messages.length === 0) return
  let remaining = CACHE_CONTROL_BREAKPOINT_LIMIT - countCacheControlOccurrences(messages)
  if (remaining <= 0) return

  let isBelowCurrentUserMessage = true
  for (let index = messages.length - 1; index >= 0; index--) {
    if (remaining <= 0) break
    const message = messages[index]

    // Inline role:"system" message (non-standard, survives sanitize when off):
    // skip without placing or flipping isBelowCurrentUserMessage.
    if (message.role === "system") continue
    // Defensive: proxied already stripped all breakpoints, so this never trips;
    // kept to mirror GHC's `continue` on an already-marked message.
    if (messageHasCacheControl(message)) continue

    const isToolResultMsg = isToolResultMessage(message)
    // `later` (chronologically next) undefined at the tail → treated as non-tool-result.
    // GHC's `reversedMsgs.at(idx-1)` instead wraps to the FIRST (oldest) message at the
    // tail; the two diverge only when messages[0] is itself a tool_result message —
    // unreachable here because the Anthropic protocol requires messages[0] to be a real
    // user prompt (a tool_result must reference a preceding tool_use).
    const isLastToolResultInRound = isToolResultMsg && !isToolResultMessage(messages[index + 1])
    const isPlainUser = message.role === "user" && !isToolResultMsg
    const isAssistantWithoutToolUse = message.role === "assistant" && !messageHasToolUse(message)

    if (
      ((isBelowCurrentUserMessage && (isLastToolResultInRound || isPlainUser)) || isAssistantWithoutToolUse)
      && placeCacheControlOnLastBlock(message, ephemeral)
    )
      remaining -= 1

    if (isPlainUser) isBelowCurrentUserMessage = false
  }
}

/** True when a user message carries at least one tool_result block (GHC's `Tool` role). */
function isToolResultMessage(message: MessageParam | undefined): boolean {
  return message !== undefined && message.role === "user" && Array.isArray(message.content) && message.content.some((block) => isToolResultBlock(block))
}

/** True when an assistant message carries at least one tool_use block. */
function messageHasToolUse(message: MessageParam): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use")
}

/** True when any top-level content block already carries a cache_control breakpoint. */
function messageHasCacheControl(message: MessageParam): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => Boolean((block as { cache_control?: unknown }).cache_control))
}

/**
 * Place an ephemeral cache_control breakpoint on the last cache-control-supporting
 * block of a message. Returns true when one was placed (so the caller decrements its
 * budget). thinking / redacted_thinking blocks cannot carry cache_control (no field
 * in the SDK type), so they are skipped — mirrors GHC's `contentBlockSupportsCacheControl`.
 *
 * When no block can carry the breakpoint (e.g. an all-thinking message), this returns
 * false and the slot is reclaimed for an earlier message. GHC instead pushes a
 * `{text:" "}` placeholder block to host its CacheBreakpoint part; we deliberately skip
 * to avoid injecting whitespace noise (such messages are vanishingly rare in proxied).
 */
function placeCacheControlOnLastBlock(message: MessageParam, ephemeral: EphemeralCacheControl): boolean {
  // String content → a single text block carrying the breakpoint. GHC does the same
  // when merging (string → [{type:"text", text}]), so upstream treats them as equivalent.
  if (typeof message.content === "string") {
    if (message.content.length === 0) return false
    message.content = [{ type: "text", text: message.content, cache_control: ephemeral }]
    return true
  }
  if (!Array.isArray(message.content)) return false

  const index = findLastIndex(message.content, (block) => block.type !== "thinking" && block.type !== "redacted_thinking")
  if (index < 0) return false

  const block = message.content[index] as { cache_control?: EphemeralCacheControl }
  if (block.cache_control) return false
  block.cache_control = ephemeral
  return true
}

/**
 * Walk all cache_control occurrences in the wire payload (system, messages, tools)
 * and apply a handler. The handler receives the existing cache_control value AND the top-level
 * section it belongs to (so sanitize can pick a per-layer TTL — nested tool_result blocks under a
 * message stay in the "messages" section). It returns:
 * - undefined: delete the cache_control field
 * - an object: replace the cache_control field with this value
 */
type CacheControlSection = "system" | "messages" | "tools"

function walkCacheControl(wire: Record<string, unknown>, handler: (current: unknown, section: CacheControlSection) => { type: string } | undefined): void {
  for (const key of ["system", "messages", "tools"] as const) {
    if (Array.isArray(wire[key])) {
      walkCacheControlArray(wire[key] as Array<Record<string, unknown>>, handler, key)
    }
  }
}

function walkCacheControlArray(
  // Runtime data: items may include null / non-objects coming from JSON.parse
  // even though our internal type narrows them, so accept `unknown`-ish entries.
  items: Array<Record<string, unknown> | null | undefined>,
  handler: (current: unknown, section: CacheControlSection) => { type: string } | undefined,
  section: CacheControlSection,
): void {
  for (const item of items) {
    if (!item || typeof item !== "object") continue

    if ("cache_control" in item && item.cache_control) {
      const replacement = handler(item.cache_control, section)
      if (replacement === undefined) {
        delete item.cache_control
      } else {
        item.cache_control = replacement
      }
    }

    // Recurse into content arrays (message.content, tool_result.content). These stay in the SAME
    // section (a tool_result nested in a user message is still message-layer).
    if (Array.isArray(item.content)) {
      walkCacheControlArray(item.content as Array<Record<string, unknown>>, handler, section)
    }
  }
}
