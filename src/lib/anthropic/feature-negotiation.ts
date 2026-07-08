/**
 * Per-(endpoint, model) feature negotiation cache.
 *
 * Tracks runtime-discovered upstream incompatibilities so subsequent requests
 * pre-emptively work around them. Each learned entry carries lifecycle metadata
 * ({@link LearnedEntryMeta}: firstLearnedAt / lastConfirmedAt / pinned /
 * manuallyExpired / migrated) and expires per-category (default 30d, pinnable to
 * never) — the single expiry adjudicator lives in `negotiation-lifecycle.ts`
 * (`isEntryActive`). Every reader gates on it; snapshot/export read raw. To
 * re-test manually, expire/delete via `/api/negotiation` (or delete the file).
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
 *                    symptom, not a Vertex assertion. Stored as a flat model-key map.
 *   - effortUnsupported — models that support NO reasoning effort at all, learned
 *                    from a `does not support reasoning effort` 400 (no supported-
 *                    values list). Independent membership map, mutually exclusive
 *                    with `efforts`.
 *   - serverToolDowngrade — models whose upstream rejects prior-turn
 *                    server-tool blocks, learned from a `Tool '…' not found in
 *                    provided tools` 400. A flat model-key map; consumers downgrade
 *                    prior-turn server-tool blocks for these models.
 *   - toolFields   — custom-tool top-level field names (e.g. `eager_input_streaming`)
 *                    the upstream rejects as `tools.N.<variant>.<field>: Extra inputs
 *                    are not permitted`. Keyed model-AGNOSTICALLY (endpoint only) —
 *                    the field is an upstream-version property, not a per-model one.
 *
 * Persisted to `PATHS.NEGOTIATION_STATES` (v2 format; v1 arrays auto-migrate on load).
 */

import consola from "consola"
import fs from "node:fs/promises"

import {
  //
  entryExpiresAt,
  entryStatus,
  type EntryStatus,
  type LearnedEntryMeta,
  type NegotiationCategory,
  NEGOTIATION_CATEGORIES,
  categoryTtlMs,
  isEntryActive,
  nowMs,
} from "~/lib/anthropic/negotiation-lifecycle"
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

/** features[modelKey] = Map<fieldName, meta> */
const unsupportedFeatures = new Map<string, Map<string, LearnedEntryMeta>>()
/** betas[modelKey] = Map<betaToken, meta> */
const unsupportedBetas = new Map<string, Map<string, LearnedEntryMeta>>()
/** efforts[modelName] = { ordered supported list (low→max), meta } */
const supportedEfforts = new Map<string, { values: Array<string>; meta: LearnedEntryMeta }>()
/** Models that support NO reasoning effort at all — an INDEPENDENT membership map,
 *  keyed by `effortKey`, mutually exclusive with a `supportedEfforts` whitelist. */
const effortUnsupportedModels = new Map<string, LearnedEntryMeta>()
/** deferredTools[modelKey] = Map<toolName, meta> that must be un-deferred */
const stickyUndeferredTools = new Map<string, Map<string, LearnedEntryMeta>>()
/** serverTools[modelKey] = Map<serverToolType prefix, meta> the upstream rejects */
const unsupportedServerTools = new Map<string, Map<string, LearnedEntryMeta>>()
/** partnerFeatures[modelKey] = Map<partner feature name, meta> the upstream org policy disallows */
const unsupportedPartnerFeatures = new Map<string, Map<string, LearnedEntryMeta>>()
/** Models whose upstream rejects inline role:"system", LEARNED reactively (config
 *  twin = state.systemRejectModels; effective set = config ∪ this learned map). */
const learnedSystemRejectModels = new Map<string, LearnedEntryMeta>()
/** Models whose upstream rejects prior-turn server-tool blocks, LEARNED reactively
 *  from a `Tool '…' not found in provided tools` 400. 1-level membership map. */
const serverToolDowngradeModels = new Map<string, LearnedEntryMeta>()
/**
 * toolFields[endpointKey] = Map<custom-tool top-level field name, meta> the upstream
 * rejects as "Extra inputs are not permitted" (e.g. `eager_input_streaming`).
 * Keyed model-AGNOSTICALLY (endpoint only) — see {@link endpointKey}.
 */
const unsupportedToolFields = new Map<string, Map<string, LearnedEntryMeta>>()

function modelKey(modelId: string): string {
  return `${copilotBaseUrl(state)}|anthropic-messages|${normalizeForMatching(modelId)}`
}

/**
 * Endpoint-only key (NO model segment). Tool-field rejection is an UPSTREAM
 * (GHC-version) property, not a per-model one: the client attaches the field to
 * every tool regardless of model, and whether GHC rejects it depends only on the
 * upstream API version. Keying model-agnostically means one 400 on ANY model
 * immunizes every model on the same upstream endpoint — the most general
 * learning (unlike the per-(endpoint, model) server-tool / partner-feature cache,
 * whose rejections ARE model-specific).
 */
function endpointKey(): string {
  return `${copilotBaseUrl(state)}|anthropic-messages`
}

function effortKey(modelId: string): string {
  // Effort whitelists are model-only (independent of endpoint URL)
  return normalizeForMatching(modelId)
}

/**
 * Record a learned (key, value) entry, returning "whether the value did NOT
 * previously exist" (preserving the old `addToSetMap` boolean for strategies that
 * depend on it). Side effects: new entry gets first+last = now; a re-hit refreshes
 * `lastConfirmedAt` + clears `manuallyExpired` (lifecycle re-confirmation).
 */
function recordEntry(map: Map<string, Map<string, LearnedEntryMeta>>, key: string, value: string, now: number): boolean {
  let inner = map.get(key)
  if (!inner) {
    inner = new Map()
    map.set(key, inner)
  }
  const existing = inner.get(value)
  if (existing) {
    existing.lastConfirmedAt = now
    delete existing.manuallyExpired
    return false
  }
  inner.set(value, { firstLearnedAt: now, lastConfirmedAt: now })
  return true
}

/** Flat-map / efforts meta re-confirmation: refresh lastConfirmedAt + clear manuallyExpired. */
function touchFlagMeta(meta: LearnedEntryMeta, now: number): void {
  meta.lastConfirmedAt = now
  delete meta.manuallyExpired
}

// ============================================================================
// Body-field feature negotiation
// ============================================================================

export function markAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): void {
  recordEntry(unsupportedFeatures, modelKey(modelId), feature, nowMs())
  schedulePersist() // always persist: a re-hit refreshes meta (lastConfirmedAt / manuallyExpired)
}

export function isAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): boolean {
  const meta = unsupportedFeatures.get(modelKey(modelId))?.get(feature)
  return meta ? isEntryActive(meta, "features", nowMs()) : false
}

/** Return all feature names marked unsupported (and still active) for the given model. */
export function getUnsupportedFeatures(modelId: string): Array<string> {
  return activeKeys(unsupportedFeatures.get(modelKey(modelId)), "features")
}

// ============================================================================
// `anthropic-beta` header negotiation
// ============================================================================

export function markAnthropicBetaUnsupported(modelId: string, beta: string): void {
  const trimmed = beta.trim()
  if (!trimmed) return
  recordEntry(unsupportedBetas, modelKey(modelId), trimmed, nowMs())
  schedulePersist()
}

export function isAnthropicBetaUnsupported(modelId: string, beta: string): boolean {
  const trimmed = beta.trim()
  if (!trimmed) return false
  const meta = unsupportedBetas.get(modelKey(modelId))?.get(trimmed)
  return meta ? isEntryActive(meta, "betas", nowMs()) : false
}

// ============================================================================
// Effort whitelists
// ============================================================================

export function setSupportedEfforts(modelName: string, supported: Array<string>): boolean {
  const key = effortKey(modelName)
  const now = nowMs()
  effortUnsupportedModels.delete(key) // exclusivity: setting a whitelist revokes "unsupported" (+ its meta)
  const existing = supportedEfforts.get(key)
  if (existing) {
    const wasActive = isEntryActive(existing.meta, "efforts", now) // revival check BEFORE touchFlagMeta
    const same = existing.values.length === supported.length && existing.values.every((e, i) => e === supported[i])
    touchFlagMeta(existing.meta, now) // side effect: always refresh meta (re-hit / revival)
    if (same && wasActive) {
      schedulePersist()
      return false // true loop guard: still-active entry re-rejected with the same whitelist = no progress
    }
    // whitelist changed, OR the entry had already expired (revival) — re-preparation
    // will differ, so this is worth retrying.
    if (!same) existing.values = [...supported]
    schedulePersist()
    return true
  }
  supportedEfforts.set(key, { values: [...supported], meta: { firstLearnedAt: now, lastConfirmedAt: now } })
  schedulePersist()
  return true
}

export function getSupportedEfforts(modelName: string): Array<string> | undefined {
  const entry = supportedEfforts.get(effortKey(modelName))
  return entry && isEntryActive(entry.meta, "efforts", nowMs()) ? [...entry.values] : undefined
}

/** Snapshot of all learned effort whitelists (RAW — no expiry gating; for snapshot/export). Keys are normalized model names. */
export function getAllLearnedEfforts(): Record<string, Array<string>> {
  const out: Record<string, Array<string>> = {}
  for (const [key, value] of supportedEfforts) out[key] = [...value.values]
  return out
}

/**
 * Mark a model as supporting NO reasoning effort at all (learned from a
 * `does not support reasoning effort` 400, code invalid_reasoning_effort, WITHOUT
 * a `supported values:[...]` list). Stored as an INDEPENDENT membership map —
 * "known-unsupported" is membership, never an empty array — so snapshot/load is
 * symmetric and the 5 empty-set collision sites of `supportedEfforts` do NOT apply
 * (RFC §3.3 O5). Mutually exclusive with a supported whitelist for the same model.
 */
export function markEffortUnsupported(modelName: string): void {
  const key = effortKey(modelName)
  const now = nowMs()
  supportedEfforts.delete(key) // exclusivity: cannot be both unsupported and have a whitelist (+ its meta)
  const existing = effortUnsupportedModels.get(key)
  if (existing) touchFlagMeta(existing, now)
  else effortUnsupportedModels.set(key, { firstLearnedAt: now, lastConfirmedAt: now })
  schedulePersist()
}

export function isEffortUnsupported(modelName: string): boolean {
  const meta = effortUnsupportedModels.get(effortKey(modelName))
  return meta ? isEntryActive(meta, "effortUnsupported", nowMs()) : false
}

// ============================================================================
// Sticky deferred-tool overrides
// ============================================================================

export function markToolUndeferred(modelId: string, toolName: string): void {
  const trimmed = toolName.trim()
  if (!trimmed) return
  recordEntry(stickyUndeferredTools, modelKey(modelId), trimmed, nowMs())
  schedulePersist()
}

export function isToolStickyUndeferred(modelId: string, toolName: string): boolean {
  const meta = stickyUndeferredTools.get(modelKey(modelId))?.get(toolName)
  return meta ? isEntryActive(meta, "deferredTools", nowMs()) : false
}

/** Return all tools marked sticky-undeferred (and still active) for the given model. */
export function getStickyUndeferredTools(modelId: string): Array<string> {
  return activeKeys(stickyUndeferredTools.get(modelKey(modelId)), "deferredTools")
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
  recordEntry(unsupportedServerTools, modelKey(modelId), trimmed, nowMs())
  schedulePersist()
}

/** Return all server tool type prefixes marked unsupported (and still active) for the given model. */
export function getUnsupportedServerToolTypes(modelId: string): Array<string> {
  return activeKeys(unsupportedServerTools.get(modelKey(modelId)), "serverTools")
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
  recordEntry(unsupportedPartnerFeatures, modelKey(modelId), trimmed, nowMs())
  schedulePersist()
}

/** Whether the given partner-model feature is disallowed (and still active) for the given model. */
export function isAnthropicPartnerFeatureUnsupported(modelId: string, feature: string): boolean {
  const trimmed = feature.trim()
  if (!trimmed) return false
  const meta = unsupportedPartnerFeatures.get(modelKey(modelId))?.get(trimmed)
  return meta ? isEntryActive(meta, "partnerFeatures", nowMs()) : false
}

// ============================================================================
// Learned inline role:"system" rejection set
// ============================================================================

/**
 * Mark a model whose upstream rejects inline `role:"system"` messages (learned
 * reactively from an `Unexpected role "system"` 400). A 1-level membership map —
 * the fact is a per-model boolean, no sub-dimension. Observed SYMPTOM, not a
 * Vertex assertion (Vertex is this account's known cause but is not asserted).
 * The config twin is `state.systemRejectModels`; the effective reject set unions
 * both (see resolveSystemSanitizeMode).
 */
export function markSystemRejectModel(modelId: string): void {
  const key = modelKey(modelId)
  const now = nowMs()
  const existing = learnedSystemRejectModels.get(key)
  if (existing) touchFlagMeta(existing, now)
  else learnedSystemRejectModels.set(key, { firstLearnedAt: now, lastConfirmedAt: now })
  schedulePersist()
}

/** Whether inline role:"system" was learned-rejected (and still active) for the given model. */
export function isSystemRejectModelLearned(modelId: string): boolean {
  const meta = learnedSystemRejectModels.get(modelKey(modelId))
  return meta ? isEntryActive(meta, "systemRejectModels", nowMs()) : false
}

// ============================================================================
// Learned server-tool downgrade set
// ============================================================================

/**
 * Mark a model whose upstream rejects prior-turn server-tool blocks (learned
 * reactively from a `Tool '…' not found in provided tools` 400). A 1-level
 * membership map — the fact is a per-model boolean, no sub-dimension. Consumers
 * downgrade prior-turn server-tool blocks for these models on subsequent requests.
 */
export function markServerToolDowngrade(modelId: string): void {
  const key = modelKey(modelId)
  const now = nowMs()
  const existing = serverToolDowngradeModels.get(key)
  if (existing) touchFlagMeta(existing, now)
  else serverToolDowngradeModels.set(key, { firstLearnedAt: now, lastConfirmedAt: now })
  schedulePersist()
}

/** Whether server-tool downgrade was learned (and still active) for the given model. */
export function isServerToolDowngradeLearned(modelId: string): boolean {
  const meta = serverToolDowngradeModels.get(modelKey(modelId))
  return meta ? isEntryActive(meta, "serverToolDowngrade", nowMs()) : false
}

// ============================================================================
// Unsupported custom-tool fields (endpoint-level, model-agnostic)
// ============================================================================

/**
 * Mark custom-tool top-level field names (e.g. `eager_input_streaming`) the
 * upstream rejects as `tools.N.<variant>.<field>: Extra inputs are not
 * permitted`. Learned reactively; keyed model-agnostically (see
 * {@link endpointKey}) so one 400 immunizes every model on this endpoint.
 * Accepts a batch because pydantic reports all offending fields in one response.
 */
export function markAnthropicUnsupportedToolFields(fields: ReadonlyArray<string>): void {
  const key = endpointKey()
  const now = nowMs()
  let touched = false
  for (const field of fields) {
    const trimmed = field.trim()
    if (trimmed) {
      recordEntry(unsupportedToolFields, key, trimmed, now) // new or re-hit refresh
      touched = true
    }
  }
  if (touched) schedulePersist()
}

/** Return all custom-tool field names marked unsupported (and still active) for the current endpoint. */
export function getUnsupportedToolFields(): Array<string> {
  return activeKeys(unsupportedToolFields.get(endpointKey()), "toolFields")
}

/** Filter a record-map inner Map to the keys whose meta is still active. */
function activeKeys(inner: Map<string, LearnedEntryMeta> | undefined, category: NegotiationCategory): Array<string> {
  if (!inner) return []
  const now = nowMs()
  const out: Array<string> = []
  for (const [value, meta] of inner) {
    if (isEntryActive(meta, category, now)) out.push(value)
  }
  return out
}

// ============================================================================
// Persistence
// ============================================================================

type MetaRecordMap = Record<string, Record<string, LearnedEntryMeta>>
type MetaFlatMap = Record<string, LearnedEntryMeta>

interface NegotiationStateFileV2 {
  version: 2
  features: MetaRecordMap
  betas: MetaRecordMap
  efforts: Record<string, { values: Array<string>; meta: LearnedEntryMeta }>
  effortUnsupported: MetaFlatMap
  deferredTools: MetaRecordMap
  serverTools: MetaRecordMap
  partnerFeatures: MetaRecordMap
  systemRejectModels: MetaFlatMap
  serverToolDowngrade: MetaFlatMap
  toolFields: MetaRecordMap
}

function snapshotRecordMap(map: Map<string, Map<string, LearnedEntryMeta>>): MetaRecordMap {
  const out: MetaRecordMap = {}
  for (const [key, inner] of map) {
    if (inner.size === 0) continue
    const o: Record<string, LearnedEntryMeta> = {}
    for (const [v, meta] of inner) o[v] = meta
    out[key] = o
  }
  return out
}

function snapshotFlatMap(map: Map<string, LearnedEntryMeta>): MetaFlatMap {
  const out: MetaFlatMap = {}
  for (const [key, meta] of map) out[key] = meta
  return out
}

/** Build the full v2 on-disk / export snapshot (RAW — no expiry gating). Shared by persist + exportAll. */
function buildV2Snapshot(): NegotiationStateFileV2 {
  return {
    version: 2,
    features: snapshotRecordMap(unsupportedFeatures),
    betas: snapshotRecordMap(unsupportedBetas),
    efforts: Object.fromEntries([...supportedEfforts].map(([k, { values, meta }]) => [k, { values: [...values], meta }])),
    effortUnsupported: snapshotFlatMap(effortUnsupportedModels),
    deferredTools: snapshotRecordMap(stickyUndeferredTools),
    serverTools: snapshotRecordMap(unsupportedServerTools),
    partnerFeatures: snapshotRecordMap(unsupportedPartnerFeatures),
    systemRejectModels: snapshotFlatMap(learnedSystemRejectModels),
    serverToolDowngrade: snapshotFlatMap(serverToolDowngradeModels),
    toolFields: snapshotRecordMap(unsupportedToolFields),
  }
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
  const data = buildV2Snapshot()
  try {
    await atomicWriteJson(PATHS.NEGOTIATION_STATES, data)
  } catch (err) {
    consola.debug("[FeatureNegotiation] persist failed:", err)
  }
})

function toMeta(now: number, migrated: boolean): LearnedEntryMeta {
  return migrated ? { firstLearnedAt: now, lastConfirmedAt: now, migrated: true } : { firstLearnedAt: now, lastConfirmedAt: now }
}

/** Coerce an on-disk value into a LearnedEntryMeta: a valid v2 meta object is kept; anything else is stamped migrated. */
function coerceMeta(m: unknown, now: number): LearnedEntryMeta {
  if (m && typeof m === "object" && typeof (m as LearnedEntryMeta).lastConfirmedAt === "number") {
    return m as LearnedEntryMeta
  }
  return toMeta(now, true)
}

/** v1 array OR v2 {value:meta} → Map<value, meta>. */
function loadRecordInner(source: unknown, now: number): Map<string, LearnedEntryMeta> {
  const inner = new Map<string, LearnedEntryMeta>()
  if (Array.isArray(source)) {
    for (const v of source) if (typeof v === "string" && v) inner.set(v, toMeta(now, true))
  } else if (source && typeof source === "object") {
    for (const [v, m] of Object.entries(source as Record<string, unknown>)) {
      inner.set(v, coerceMeta(m, now))
    }
  }
  return inner
}

function loadRecordMap(target: Map<string, Map<string, LearnedEntryMeta>>, source: Record<string, unknown> | undefined, now: number): void {
  if (!source) return
  for (const [key, values] of Object.entries(source)) {
    const inner = loadRecordInner(values, now)
    if (inner.size > 0) target.set(key, inner)
  }
}

function loadFlatMap(target: Map<string, LearnedEntryMeta>, source: unknown, now: number): void {
  if (Array.isArray(source)) {
    for (const v of source) if (typeof v === "string" && v) target.set(v, toMeta(now, true))
  } else if (source && typeof source === "object") {
    for (const [k, m] of Object.entries(source as Record<string, unknown>)) target.set(k, coerceMeta(m, now))
  }
}

/** Sum entry counts across a record-map (for the load log). */
function countRecordMap(map: Map<string, Map<string, LearnedEntryMeta>>): number {
  let n = 0
  for (const inner of map.values()) n += inner.size
  return n
}

export async function loadPersistedFeatureNegotiation(): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8")
    const data = JSON.parse(raw) as Record<string, unknown>
    if (data.version !== 1 && data.version !== 2) return
    const now = nowMs()
    loadRecordMap(unsupportedFeatures, data.features as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedBetas, data.betas as Record<string, unknown> | undefined, now)
    // efforts: v1 = model→string[]; v2 = model→{values, meta}
    if (data.efforts && typeof data.efforts === "object") {
      for (const [model, val] of Object.entries(data.efforts as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          const clean = val.filter((v): v is string => typeof v === "string" && v.length > 0)
          if (clean.length > 0) supportedEfforts.set(model, { values: clean, meta: toMeta(now, true) })
        } else if (val && typeof val === "object" && Array.isArray((val as { values?: unknown }).values)) {
          const vv = val as { values: Array<string>; meta?: unknown }
          supportedEfforts.set(model, { values: [...vv.values], meta: coerceMeta(vv.meta, now) })
        }
      }
    }
    loadFlatMap(effortUnsupportedModels, data.effortUnsupported, now)
    loadRecordMap(stickyUndeferredTools, data.deferredTools as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedServerTools, data.serverTools as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedPartnerFeatures, data.partnerFeatures as Record<string, unknown> | undefined, now)
    loadFlatMap(learnedSystemRejectModels, data.systemRejectModels, now)
    loadFlatMap(serverToolDowngradeModels, data.serverToolDowngrade ?? data.serverToolHistoryDowngrade, now)
    loadRecordMap(unsupportedToolFields, data.toolFields as Record<string, unknown> | undefined, now)
    const total =
      countRecordMap(unsupportedFeatures)
      + countRecordMap(unsupportedBetas)
      + supportedEfforts.size
      + effortUnsupportedModels.size
      + countRecordMap(stickyUndeferredTools)
      + countRecordMap(unsupportedServerTools)
      + countRecordMap(unsupportedPartnerFeatures)
      + learnedSystemRejectModels.size
      + serverToolDowngradeModels.size
      + countRecordMap(unsupportedToolFields)
    if (total > 0) {
      consola.info(`[FeatureNegotiation] Loaded ${total} negotiated entries from ${PATHS.NEGOTIATION_STATES}`)
    }
  } catch {
    // File doesn't exist or is unreadable — start fresh
  }
}

// ============================================================================
// Management: resolver + mutations + grouped snapshot / export
// ============================================================================

export interface LearnedEntryView {
  category: NegotiationCategory
  key: string
  value: string
  detail?: unknown
  firstLearnedAt: number
  lastConfirmedAt: number
  expiresAt: number | null
  status: EntryStatus
  pinned: boolean
  migrated: boolean
}

export interface LearnedSnapshot {
  categories: Array<{ category: NegotiationCategory; ttlMs: number | null; entries: Array<LearnedEntryView> }>
}

/**
 * Category → meta locator. Record categories address by (key, value);
 * flat/efforts categories address by value=model (key ignored). Returns the
 * meta or undefined. `satisfies never` exhaustiveness guard on the default.
 */
function locateMeta(category: NegotiationCategory, key: string, value: string): LearnedEntryMeta | undefined {
  switch (category) {
    case "features": {
      return unsupportedFeatures.get(key)?.get(value)
    }
    case "betas": {
      return unsupportedBetas.get(key)?.get(value)
    }
    case "deferredTools": {
      return stickyUndeferredTools.get(key)?.get(value)
    }
    case "serverTools": {
      return unsupportedServerTools.get(key)?.get(value)
    }
    case "partnerFeatures": {
      return unsupportedPartnerFeatures.get(key)?.get(value)
    }
    case "toolFields": {
      return unsupportedToolFields.get(key)?.get(value)
    }
    case "efforts": {
      return supportedEfforts.get(value)?.meta
    }
    case "effortUnsupported": {
      return effortUnsupportedModels.get(value)
    }
    case "systemRejectModels": {
      return learnedSystemRejectModels.get(value)
    }
    case "serverToolDowngrade": {
      return serverToolDowngradeModels.get(value)
    }
    default: {
      const _exhaustive: never = category // L1: compile-time exhaustiveness guard
      return _exhaustive
    }
  }
}

/** efforts detail (the supported values list) for the view; other categories have no detail. */
function locateDetail(category: NegotiationCategory, value: string): unknown {
  return category === "efforts" ? supportedEfforts.get(value)?.values : undefined
}

function deleteLocated(category: NegotiationCategory, key: string, value: string): boolean {
  switch (category) {
    case "features": {
      return unsupportedFeatures.get(key)?.delete(value) ?? false
    }
    case "betas": {
      return unsupportedBetas.get(key)?.delete(value) ?? false
    }
    case "deferredTools": {
      return stickyUndeferredTools.get(key)?.delete(value) ?? false
    }
    case "serverTools": {
      return unsupportedServerTools.get(key)?.delete(value) ?? false
    }
    case "partnerFeatures": {
      return unsupportedPartnerFeatures.get(key)?.delete(value) ?? false
    }
    case "toolFields": {
      return unsupportedToolFields.get(key)?.delete(value) ?? false
    }
    case "efforts": {
      return supportedEfforts.delete(value)
    }
    case "effortUnsupported": {
      return effortUnsupportedModels.delete(value)
    }
    case "systemRejectModels": {
      return learnedSystemRejectModels.delete(value)
    }
    case "serverToolDowngrade": {
      return serverToolDowngradeModels.delete(value)
    }
    default: {
      const _exhaustive: never = category // L1: compile-time exhaustiveness guard
      return _exhaustive
    }
  }
}

function ttlOrNull(category: NegotiationCategory): number | null {
  const ttl = categoryTtlMs(category)
  return ttl === Number.POSITIVE_INFINITY ? null : ttl
}

function viewOf(category: NegotiationCategory, key: string, value: string, meta: LearnedEntryMeta, now: number, detail?: unknown): LearnedEntryView {
  return {
    category,
    key,
    value,
    detail,
    firstLearnedAt: meta.firstLearnedAt,
    lastConfirmedAt: meta.lastConfirmedAt,
    expiresAt: entryExpiresAt(meta, category),
    status: entryStatus(meta, category, now),
    pinned: Boolean(meta.pinned),
    migrated: Boolean(meta.migrated),
  }
}

/** Build the updated view for a hit (renew/expire/pin fulfil the {ok, entry} contract). */
function viewFor(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  return viewOf(category, key, value, meta, nowMs(), locateDetail(category, value))
}

/** Renew (extend expiry): refresh lastConfirmedAt + clear manuallyExpired. Miss → null (→ 404). */
export function renewEntry(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  meta.lastConfirmedAt = nowMs()
  delete meta.manuallyExpired
  schedulePersist()
  return viewFor(category, key, value)
}

/** Expire now (keep the row): manuallyExpired = true. Miss → null (→ 404). */
export function expireEntry(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  meta.manuallyExpired = true
  schedulePersist()
  return viewFor(category, key, value)
}

/** Pin / unpin (never expire). Miss → null (→ 404). */
export function setPinned(category: NegotiationCategory, key: string, value: string, pinned: boolean): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  if (pinned) meta.pinned = true
  else delete meta.pinned
  schedulePersist()
  return viewFor(category, key, value)
}

/** Delete the row entirely. Returns whether it existed. */
export function deleteEntry(category: NegotiationCategory, key: string, value: string): boolean {
  const hit = deleteLocated(category, key, value)
  if (hit) schedulePersist()
  return hit
}

/**
 * Grouped snapshot of all learned records (RAW — reads original maps, computes
 * status per entry). Shows expired/manually-expired rows (unlike gated readers),
 * so the management UI can see and revive them.
 */
export function getGroupedSnapshot(): LearnedSnapshot {
  const now = nowMs()
  const recordMaps: Array<[NegotiationCategory, Map<string, Map<string, LearnedEntryMeta>>]> = [
    ["features", unsupportedFeatures],
    ["betas", unsupportedBetas],
    ["deferredTools", stickyUndeferredTools],
    ["serverTools", unsupportedServerTools],
    ["partnerFeatures", unsupportedPartnerFeatures],
    ["toolFields", unsupportedToolFields],
  ]
  const flatMaps: Array<[NegotiationCategory, Map<string, LearnedEntryMeta>]> = [
    ["effortUnsupported", effortUnsupportedModels],
    ["systemRejectModels", learnedSystemRejectModels],
    ["serverToolDowngrade", serverToolDowngradeModels],
  ]
  const byCategory = new Map<NegotiationCategory, Array<LearnedEntryView>>()
  for (const [cat, map] of recordMaps) {
    const entries: Array<LearnedEntryView> = []
    for (const [key, inner] of map) for (const [value, meta] of inner) entries.push(viewOf(cat, key, value, meta, now))
    byCategory.set(cat, entries)
  }
  for (const [cat, map] of flatMaps) {
    const entries: Array<LearnedEntryView> = []
    for (const [value, meta] of map) entries.push(viewOf(cat, "", value, meta, now))
    byCategory.set(cat, entries)
  }
  const effortEntries: Array<LearnedEntryView> = []
  for (const [model, { values, meta }] of supportedEfforts) effortEntries.push(viewOf("efforts", "", model, meta, now, values))
  byCategory.set("efforts", effortEntries)

  return {
    categories: NEGOTIATION_CATEGORIES.map((category) => ({
      category,
      ttlMs: ttlOrNull(category),
      entries: byCategory.get(category) ?? [],
    })),
  }
}

/** Full v2 dataset (RAW — same shape as persist). Re-importable as negotiation-states.json. */
export function exportAll(): NegotiationStateFileV2 {
  return buildV2Snapshot()
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
  serverToolDowngradeModels.clear()
  unsupportedToolFields.clear()
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
 * next test starts, then clears the 10 collections. Use the async drain-reset only when
 * a caller explicitly needs the cleared state flushed to disk.
 */
export function clearAnthropicFeatureNegotiationForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  clearNegotiationMaps()
}
