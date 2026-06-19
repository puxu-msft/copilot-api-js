/**
 * Per-(endpoint, model) feature negotiation cache.
 *
 * Tracks runtime-discovered upstream incompatibilities so subsequent requests
 * pre-emptively work around them. All entries are **permanent** — once an
 * incompatibility is observed it is bound to the specific model and assumed
 * stable. To re-test, delete `negotiation-states.json` (or its entries).
 *
 * Categories:
 *   - features     — body fields (e.g. `context_management`) the upstream
 *                    rejects as unknown/extra. Mapped from upstream error
 *                    `X: Extra inputs are not permitted`.
 *   - betas        — `anthropic-beta` header tokens the upstream rejects.
 *                    Mapped from `unsupported beta header(s): X`.
 *   - efforts      — per-model `output_config.effort` whitelist learned
 *                    from `invalid_reasoning_effort` errors. Value is the
 *                    full supported list (not a strip list).
 *   - deferredTools — per (model, toolName) sticky `defer_loading: false`
 *                    decisions, learned from `Tool reference 'X' not
 *                    found in available tools` errors.
 *   - serverTools  — per (model, serverToolType) native server tools the
 *                    upstream rejects, learned from `The use of the web
 *                    search tool is not supported.` (code unsupported_value).
 *                    Stored as type prefixes (e.g. `web_search_`) so prepare
 *                    can strip every dated variant.
 *
 * Persisted to `PATHS.NEGOTIATION_STATES`.
 */

import consola from "consola"
import fs from "node:fs/promises"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "~/lib/atomic-fs"
import { PATHS } from "~/lib/config/paths"
import { copilotBaseUrl } from "~/lib/copilot-api"
import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

/**
 * Body fields the upstream may reject as "Extra inputs are not permitted".
 * The historical canonical value is `"context_management"`; other field names
 * (e.g. `"inference_geo"`) are recorded the same way.
 */
export type AnthropicNegotiatedFeature = string

// ============================================================================
// In-memory state
// ============================================================================

/** features[modelKey] = Set<fieldName> */
const unsupportedFeatures = new Map<string, Set<string>>()
/** betas[modelKey] = Set<betaToken> */
const unsupportedBetas = new Map<string, Set<string>>()
/** efforts[modelName] = ordered list of supported effort values (low→max) */
const supportedEfforts = new Map<string, Array<string>>()
/** deferredTools[modelKey] = Set<toolName> that must be un-deferred */
const stickyUndeferredTools = new Map<string, Set<string>>()
/** serverTools[modelKey] = Set<serverToolType prefix> the upstream rejects */
const unsupportedServerTools = new Map<string, Set<string>>()

function modelKey(modelId: string): string {
  return `${copilotBaseUrl(state)}|anthropic-messages|${normalizeForMatching(modelId)}`
}

function effortKey(modelId: string): string {
  // Effort whitelists are model-only (independent of endpoint URL)
  return normalizeForMatching(modelId)
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): boolean {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  if (set.has(value)) return false
  set.add(value)
  return true
}

// ============================================================================
// Body-field feature negotiation
// ============================================================================

export function markAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): void {
  if (addToSetMap(unsupportedFeatures, modelKey(modelId), feature)) schedulePersist()
}

export function isAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): boolean {
  return unsupportedFeatures.get(modelKey(modelId))?.has(feature) ?? false
}

/** Return all feature names marked unsupported for the given model. */
export function getUnsupportedFeatures(modelId: string): Array<string> {
  const set = unsupportedFeatures.get(modelKey(modelId))
  return set ? [...set] : []
}

// ============================================================================
// `anthropic-beta` header negotiation
// ============================================================================

export function markAnthropicBetaUnsupported(modelId: string, beta: string): void {
  const trimmed = beta.trim()
  if (!trimmed) return
  if (addToSetMap(unsupportedBetas, modelKey(modelId), trimmed)) schedulePersist()
}

export function isAnthropicBetaUnsupported(modelId: string, beta: string): boolean {
  const trimmed = beta.trim()
  if (!trimmed) return false
  return unsupportedBetas.get(modelKey(modelId))?.has(trimmed) ?? false
}

// ============================================================================
// Effort whitelists
// ============================================================================

export function setSupportedEfforts(modelName: string, supported: Array<string>): boolean {
  const key = effortKey(modelName)
  const existing = supportedEfforts.get(key)
  if (existing && existing.length === supported.length && existing.every((e, i) => e === supported[i])) {
    return false
  }
  supportedEfforts.set(key, [...supported])
  schedulePersist()
  return true
}

export function getSupportedEfforts(modelName: string): Array<string> | undefined {
  return supportedEfforts.get(effortKey(modelName))
}

/** Snapshot of all learned effort whitelists. Keys are normalized model names. */
export function getAllLearnedEfforts(): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const [key, value] of supportedEfforts) out[key] = [...value]
  return out
}

// ============================================================================
// Sticky deferred-tool overrides
// ============================================================================

export function markToolUndeferred(modelId: string, toolName: string): void {
  const trimmed = toolName.trim()
  if (!trimmed) return
  if (addToSetMap(stickyUndeferredTools, modelKey(modelId), trimmed)) schedulePersist()
}

export function isToolStickyUndeferred(modelId: string, toolName: string): boolean {
  return stickyUndeferredTools.get(modelKey(modelId))?.has(toolName) ?? false
}

/** Return all tools marked sticky-undeferred for the given model. */
export function getStickyUndeferredTools(modelId: string): Array<string> {
  const set = stickyUndeferredTools.get(modelKey(modelId))
  return set ? [...set] : []
}

// ============================================================================
// Unsupported native server tools
// ============================================================================

/**
 * Mark a native server tool type (by prefix, e.g. `web_search_`) as unsupported
 * for the given model. Learned reactively from upstream 400 rejections.
 */
export function markAnthropicServerToolUnsupported(modelId: string, toolType: string): void {
  const trimmed = toolType.trim()
  if (!trimmed) return
  if (addToSetMap(unsupportedServerTools, modelKey(modelId), trimmed)) schedulePersist()
}

/** Return all server tool type prefixes marked unsupported for the given model. */
export function getUnsupportedServerToolTypes(modelId: string): Array<string> {
  const set = unsupportedServerTools.get(modelKey(modelId))
  return set ? [...set] : []
}

// ============================================================================
// Persistence
// ============================================================================

interface NegotiationStateFile {
  version: 1
  features: Record<string, Array<string>>
  betas: Record<string, Array<string>>
  efforts: Record<string, Array<string>>
  deferredTools: Record<string, Array<string>>
  serverTools: Record<string, Array<string>>
}

function snapshotSetMap(map: Map<string, Set<string>>): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const [key, set] of map) {
    if (set.size > 0) out[key] = [...set]
  }
  return out
}

function snapshotEffortMap(map: Map<string, Array<string>>): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const [key, value] of map) {
    if (value.length > 0) out[key] = [...value]
  }
  return out
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 1000

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistFeatureNegotiation()
  }, PERSIST_DEBOUNCE_MS)
}

/**
 * Persist current negotiation state to disk. Serialized + atomic — see
 * `~/lib/atomic-fs`. Without serialization, debounce-fired writes can race
 * a shutdown-fired write and the older snapshot can rename last, losing the
 * newer learnings. Without atomicity, a crash mid-write leaves truncated
 * JSON and the loader's `catch{}` silently zeroes ALL learned upstream
 * compatibility (features, betas, efforts, deferred tools).
 */
export const persistFeatureNegotiation = createSerializedAsyncFn(async () => {
  const data: NegotiationStateFile = {
    version: 1,
    features: snapshotSetMap(unsupportedFeatures),
    betas: snapshotSetMap(unsupportedBetas),
    efforts: snapshotEffortMap(supportedEfforts),
    deferredTools: snapshotSetMap(stickyUndeferredTools),
    serverTools: snapshotSetMap(unsupportedServerTools),
  }
  try {
    await atomicWriteJson(PATHS.NEGOTIATION_STATES, data)
  } catch (err) {
    consola.debug("[FeatureNegotiation] persist failed:", err)
  }
})

function loadSetMap(target: Map<string, Set<string>>, source: Record<string, Array<string>> | undefined): number {
  if (!source) return 0
  let n = 0
  for (const [key, values] of Object.entries(source)) {
    if (!Array.isArray(values) || values.length === 0) continue
    target.set(key, new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)))
    n += values.length
  }
  return n
}

function loadEffortMap(target: Map<string, Array<string>>, source: Record<string, Array<string>> | undefined): number {
  if (!source) return 0
  let n = 0
  for (const [key, values] of Object.entries(source)) {
    if (!Array.isArray(values) || values.length === 0) continue
    const clean = values.filter((v): v is string => typeof v === "string" && v.length > 0)
    if (clean.length > 0) {
      target.set(key, clean)
      n++
    }
  }
  return n
}

export async function loadPersistedFeatureNegotiation(): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8")
    const data = JSON.parse(raw) as Partial<NegotiationStateFile>
    if (data.version !== 1) return
    const total =
      loadSetMap(unsupportedFeatures, data.features)
      + loadSetMap(unsupportedBetas, data.betas)
      + loadEffortMap(supportedEfforts, data.efforts)
      + loadSetMap(stickyUndeferredTools, data.deferredTools)
      + loadSetMap(unsupportedServerTools, data.serverTools)
    if (total > 0) {
      consola.info(`[FeatureNegotiation] Loaded ${total} negotiated entries from ${PATHS.NEGOTIATION_STATES}`)
    }
  } catch {
    // File doesn't exist or is unreadable — start fresh
  }
}

/**
 * Reset all in-memory negotiation state for tests. Returns a promise that
 * resolves once any debounced / in-flight persist on the serialized chain has
 * drained — otherwise an enqueued persist would race the reset and write
 * cleared state to disk after the test starts inspecting the file.
 */
export async function resetAnthropicFeatureNegotiationForTesting(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  // Drain the serialized chain: any persist already queued runs to completion,
  // capturing the still-populated state, before we wipe in-memory maps below.
  // A trailing empty persist after the wipe is unnecessary — caller can
  // explicitly persist if they need the cleared state on disk.
  await persistFeatureNegotiation()
  unsupportedFeatures.clear()
  unsupportedBetas.clear()
  supportedEfforts.clear()
  stickyUndeferredTools.clear()
  unsupportedServerTools.clear()
}
