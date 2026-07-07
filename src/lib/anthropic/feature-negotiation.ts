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
 *   - partnerFeatures — per (model, featureName) partner-model features the
 *                    upstream org policy disallows, learned from Vertex's
 *                    `constraints/vertexai.allowedPartnerModelFeatures violated
 *                    ... disallowed feature X` 400. Currently only
 *                    `structured_outputs` (→ strip `output_config.format`).
 *   - systemRejectModels — models whose upstream rejects inline `role:"system"`,
 *                    learned from an `Unexpected role "system"` 400. An observed
 *                    symptom, not a Vertex assertion. Stored as a flat model-key set.
 *   - effortUnsupported — models that support NO reasoning effort at all, learned
 *                    from a `does not support reasoning effort` 400 (no supported-
 *                    values list). Independent membership set, mutually exclusive
 *                    with `efforts`.
 *   - serverToolHistoryDowngrade — models whose upstream rejects prior-turn
 *                    server-tool history, learned from a `Tool '…' not found in
 *                    provided tools` 400. A flat model-key set; consumers downgrade
 *                    server-tool history for these models.
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
/** Models that support NO reasoning effort at all — an INDEPENDENT membership set,
 *  keyed by `effortKey`, mutually exclusive with a `supportedEfforts` whitelist. */
const effortUnsupportedModels = new Set<string>()
/** deferredTools[modelKey] = Set<toolName> that must be un-deferred */
const stickyUndeferredTools = new Map<string, Set<string>>()
/** serverTools[modelKey] = Set<serverToolType prefix> the upstream rejects */
const unsupportedServerTools = new Map<string, Set<string>>()
/** partnerFeatures[modelKey] = Set<partner feature name> the upstream org policy disallows */
const unsupportedPartnerFeatures = new Map<string, Set<string>>()
/** Models whose upstream rejects inline role:"system", LEARNED reactively (config
 *  twin = state.systemRejectModels; effective set = config ∪ this learned set). */
const learnedSystemRejectModels = new Set<string>()
/** Models whose upstream rejects prior-turn server-tool history, LEARNED reactively
 *  from a `Tool '…' not found in provided tools` 400. 1-level membership set. */
const serverToolHistoryDowngradeModels = new Set<string>()

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
  effortUnsupportedModels.delete(key) // exclusivity: setting a whitelist revokes "unsupported"
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

/**
 * Mark a model as supporting NO reasoning effort at all (learned from a
 * `does not support reasoning effort` 400, code invalid_reasoning_effort, WITHOUT
 * a `supported values:[...]` list). Stored as an INDEPENDENT membership set —
 * "known-unsupported" is membership, never an empty array — so snapshot/load is
 * symmetric and the 5 empty-set collision sites of `supportedEfforts` do NOT apply
 * (RFC §3.3 O5). Mutually exclusive with a supported whitelist for the same model.
 */
export function markEffortUnsupported(modelName: string): void {
  const key = effortKey(modelName)
  supportedEfforts.delete(key) // exclusivity: cannot be both unsupported and have a whitelist
  if (!effortUnsupportedModels.has(key)) {
    effortUnsupportedModels.add(key)
    schedulePersist()
  }
}

export function isEffortUnsupported(modelName: string): boolean {
  return effortUnsupportedModels.has(effortKey(modelName))
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
// Unsupported partner-model features (Vertex org policy)
// ============================================================================

/**
 * Canonical name (as the upstream reports it) for the structured-outputs
 * partner feature — the only currently-strippable one. Maps to stripping the
 * client's `output_config.format` from the wire payload.
 */
export const STRUCTURED_OUTPUTS_PARTNER_FEATURE = "structured_outputs"

/**
 * Mark a partner-model feature (e.g. `structured_outputs`) as disallowed for the
 * given model. Learned reactively from a Vertex org-policy 400
 * (`constraints/vertexai.allowedPartnerModelFeatures violated`).
 */
export function markAnthropicPartnerFeatureUnsupported(modelId: string, feature: string): void {
  const trimmed = feature.trim()
  if (!trimmed) return
  if (addToSetMap(unsupportedPartnerFeatures, modelKey(modelId), trimmed)) schedulePersist()
}

/** Whether the given partner-model feature is disallowed for the given model. */
export function isAnthropicPartnerFeatureUnsupported(modelId: string, feature: string): boolean {
  const trimmed = feature.trim()
  if (!trimmed) return false
  return unsupportedPartnerFeatures.get(modelKey(modelId))?.has(trimmed) ?? false
}

// ============================================================================
// Learned inline role:"system" rejection set
// ============================================================================

/**
 * Mark a model whose upstream rejects inline `role:"system"` messages (learned
 * reactively from an `Unexpected role "system"` 400). A 1-level membership set —
 * the fact is a per-model boolean, no sub-dimension. Observed SYMPTOM, not a
 * Vertex assertion (Vertex is this account's known cause but is not asserted).
 * The config twin is `state.systemRejectModels`; the effective reject set unions
 * both (see resolveSystemSanitizeMode).
 */
export function markSystemRejectModel(modelId: string): void {
  if (!learnedSystemRejectModels.has(modelKey(modelId))) {
    learnedSystemRejectModels.add(modelKey(modelId))
    schedulePersist()
  }
}

/** Whether inline role:"system" was learned-rejected for the given model. */
export function isSystemRejectModelLearned(modelId: string): boolean {
  return learnedSystemRejectModels.has(modelKey(modelId))
}

// ============================================================================
// Learned server-tool history downgrade set
// ============================================================================

/**
 * Mark a model whose upstream rejects prior-turn server-tool history (learned
 * reactively from a `Tool '…' not found in provided tools` 400). A 1-level
 * membership set — the fact is a per-model boolean, no sub-dimension. Consumers
 * downgrade server-tool history for these models on subsequent requests.
 */
export function markServerToolHistoryDowngrade(modelId: string): void {
  if (!serverToolHistoryDowngradeModels.has(modelKey(modelId))) {
    serverToolHistoryDowngradeModels.add(modelKey(modelId))
    schedulePersist()
  }
}

/** Whether server-tool history downgrade was learned for the given model. */
export function isServerToolHistoryDowngradeLearned(modelId: string): boolean {
  return serverToolHistoryDowngradeModels.has(modelKey(modelId))
}

// ============================================================================
// Persistence
// ============================================================================

interface NegotiationStateFile {
  version: 1
  features: Record<string, Array<string>>
  betas: Record<string, Array<string>>
  efforts: Record<string, Array<string>>
  effortUnsupported: Array<string>
  deferredTools: Record<string, Array<string>>
  serverTools: Record<string, Array<string>>
  partnerFeatures: Record<string, Array<string>>
  systemRejectModels: Array<string>
  serverToolHistoryDowngrade: Array<string>
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
    effortUnsupported: [...effortUnsupportedModels],
    deferredTools: snapshotSetMap(stickyUndeferredTools),
    serverTools: snapshotSetMap(unsupportedServerTools),
    partnerFeatures: snapshotSetMap(unsupportedPartnerFeatures),
    systemRejectModels: [...learnedSystemRejectModels],
    serverToolHistoryDowngrade: [...serverToolHistoryDowngradeModels],
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

/** Load a flat Array<string> into a Set (1-level set persistence — mirrors loadSetMap but for a single set). */
function loadStringSet(target: Set<string>, source: Array<string> | undefined): number {
  if (!Array.isArray(source)) return 0
  let n = 0
  for (const v of source) {
    if (typeof v === "string" && v.length > 0) {
      target.add(v)
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
      + loadStringSet(effortUnsupportedModels, data.effortUnsupported)
      + loadSetMap(stickyUndeferredTools, data.deferredTools)
      + loadSetMap(unsupportedServerTools, data.serverTools)
      + loadSetMap(unsupportedPartnerFeatures, data.partnerFeatures)
      + loadStringSet(learnedSystemRejectModels, data.systemRejectModels)
      + loadStringSet(serverToolHistoryDowngradeModels, data.serverToolHistoryDowngrade)
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
function clearNegotiationMaps(): void {
  unsupportedFeatures.clear()
  unsupportedBetas.clear()
  supportedEfforts.clear()
  effortUnsupportedModels.clear()
  stickyUndeferredTools.clear()
  unsupportedServerTools.clear()
  unsupportedPartnerFeatures.clear()
  learnedSystemRejectModels.clear()
  serverToolHistoryDowngradeModels.clear()
}

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
  clearNegotiationMaps()
}

/**
 * Synchronous, no-disk reset for per-test isolation (the unified fixture calls
 * this in afterEach). Unlike `resetAnthropicFeatureNegotiationForTesting`, it
 * does NOT drain/persist — a per-test afterEach should not incur sandbox disk
 * I/O on every test, and there is nothing worth flushing (the maps are about to
 * be wiped). Cancels the debounce timer so no enqueued persist fires after the
 * next test starts, then clears the 9 collections. Use the async drain-reset only when
 * a caller explicitly needs the cleared state flushed to disk.
 */
export function clearAnthropicFeatureNegotiationForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  clearNegotiationMaps()
}
