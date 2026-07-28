/**
 * The upstream model catalog cache and the policy that turns it into the usable view on `state`.
 *
 * Division of labour with `state.ts`: the FIELDS are state (`state.models`, `modelIndex`,
 * `modelIds`, `disabledModels` — several unrelated subsystems read them), but everything that
 * DECIDES what goes in them is model knowledge and lives here: the raw upstream response, what
 * "disabled" removes, and the normalized id match that makes a config entry `claude-opus-4-8`
 * disable the catalog id `claude-opus-4.8`. Keeping that here is what lets `state.ts` drop its
 * import of `~/lib/models/model-name` on the way to becoming a leaf that depends on nothing but
 * language builtins (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md).
 *
 * The dependency runs one way only — this module imports `state`, never the reverse. That is also
 * why {@link setDisabledModels} stayed on `state` as a plain field setter and the re-filter is a
 * SEPARATE call: `state.resetConfigManagedState()` has to reset the disabled list like the other 18
 * config-managed domains, and if that reset had to re-filter, `state` would have to call into this
 * module and close a two-node cycle. Instead the config layer re-derives the view once, at the end
 * of `applyConfigToState()`, which covers both hot reload and the PUT /api/config reset.
 *
 * `rawModels` deliberately stays module-scoped rather than joining `State`: it is a cache that
 * exists so a config reload can re-filter without another network round-trip, not something a
 * consumer should read instead of `state.models`.
 */

import {
  //
  rebuildModelIndex,
  setFilteredModels,
  state,
} from "~/lib/state"

import type { ModelsResponse } from "./client"

import { getModels } from "./client"
import { normalizeForMatching } from "./model-name"

/** Last unfiltered models response from the upstream `/models` endpoint. */
let rawModels: ModelsResponse | undefined

/**
 * The currently disabled ids in normalized form, or `undefined` when nothing is disabled.
 *
 * Single site for the match rule: both the filter and the `/api/models` annotation read it, so a
 * spelling-tolerance change can never land in one and miss the other.
 */
function disabledIdSet(): Set<string> | undefined {
  const disabled = state.disabledModels
  if (disabled.length === 0) return undefined
  return new Set(disabled.map((id) => normalizeForMatching(id)))
}

function applyDisabledFilter(models: ModelsResponse | undefined): ModelsResponse | undefined {
  if (!models) return undefined
  const disabled = disabledIdSet()
  if (!disabled) return models
  return { ...models, data: models.data.filter((m) => !disabled.has(normalizeForMatching(m.id))) }
}

/**
 * Re-derive `state.models` and the two lookup indexes from the cached raw catalog and the CURRENT
 * `state.disabledModels`. Idempotent, and safe with no catalog cached yet.
 *
 * The three steps are ordered and all three are required: filter the raw response, publish the
 * filtered view, then rebuild the indexes FROM that view. Rebuilding before filtering would index
 * entries the operator disabled.
 */
export function refreshCatalogView(): void {
  setFilteredModels(applyDisabledFilter(rawModels))
  rebuildModelIndex()
}

/** Publish a fresh upstream catalog, filtered by the current disabled list. */
export function setModels(models: ModelsResponse | undefined): void {
  rawModels = models
  refreshCatalogView()
}

/**
 * Fetch the catalog from the Copilot API and publish it. Skips the publish on 304 Not Modified —
 * `getModels()` returns `undefined` there and the cached view is already correct.
 *
 * Lives here rather than in `client.ts` because storing IS this module's job, and having the HTTP
 * client reach back into the cache made `client.ts` and this file a two-node import cycle the SCC
 * ratchet caught. The dependency now runs one way: cache orchestrates, client only speaks HTTP.
 */
export async function cacheModels(): Promise<void> {
  const models = await getModels()
  if (models) setModels(models)
}

/** Last unfiltered upstream `/models` response (includes disabled entries). */
export function getRawModels(): ModelsResponse | undefined {
  return rawModels
}

/**
 * The upstream ids that `config.disabled_models` currently removes from the usable set — computed
 * from the cached raw catalog with the SAME normalized match as the filter (so config
 * `claude-opus-4-8` reports the actual catalog id `claude-opus-4.8`). Empty when nothing is disabled
 * or no catalog has arrived yet. Consumed by the internal `/api/models` route to annotate the full
 * catalog.
 */
export function getConfigDisabledIds(): Array<string> {
  const raw = rawModels
  if (!raw) return []
  const disabled = disabledIdSet()
  if (!disabled) return []
  return raw.data.filter((m) => disabled.has(normalizeForMatching(m.id))).map((m) => m.id)
}

/**
 * Reset the module-scoped `rawModels` cache (for tests). `rawModels` lives OUTSIDE `mutableState`,
 * so `snapshotStateForTests`/`restoreStateForTests` cannot reach it — without this, a `setModels()`
 * in one test leaks its raw response into the next (a later disabled-list change would re-filter
 * from the stale cache). The unified test fixture calls this in afterEach.
 */
export function resetRawModelsForTests(): void {
  rawModels = undefined
}
