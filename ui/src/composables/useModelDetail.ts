import type { Model } from "~backend/lib/models/client"

import { normalizeModelId } from "~backend/lib/models/resolver"
import {
  //
  computed,
  ref,
  type ComputedRef,
  type Ref,
} from "vue"

import type { RequestTelemetrySnapshot } from "./telemetry-parse"

import {
  //
  buildModelTelemetryIndex,
  type JoinedModelTelemetry,
  type ModelTelemetryIndex,
} from "./model-telemetry-join"

export interface UseModelDetailReturn {
  /** Currently-selected model id, or null when the drawer is closed. Stores the
   *  id (string), NEVER a copied model object — the drawer looks the model up in
   *  the page's single `models` instance so the shared `caps()` WeakMap stays hot. */
  selectedId: Ref<string | null>
  isOpen: ComputedRef<boolean>
  telemetryIndex: ComputedRef<ModelTelemetryIndex>
  open: (id: string) => void
  close: () => void
  telemetryFor: (id: string) => JoinedModelTelemetry | null
}

/**
 * Page-scoped detail state for the Models page: which model is selected (drawer
 * open) + the joined telemetry index. Instantiate ONCE in VModelsPage and pass
 * data down via props; child components must not call this again.
 */
export function useModelDetail(models: Ref<Array<Model>>, snapshot: Ref<RequestTelemetrySnapshot | null>): UseModelDetailReturn {
  const selectedId = ref<string | null>(null)
  const isOpen = computed(() => selectedId.value !== null)
  const telemetryIndex = computed(() => buildModelTelemetryIndex(snapshot.value, models.value))

  function open(id: string): void {
    selectedId.value = id
  }
  function close(): void {
    selectedId.value = null
  }
  function telemetryFor(id: string): JoinedModelTelemetry | null {
    return telemetryIndex.value.byId.get(normalizeModelId(id)) ?? null
  }

  return { selectedId, isOpen, telemetryIndex, open, close, telemetryFor }
}
