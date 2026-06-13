import { defineStore } from "pinia"
import { shallowRef } from "vue"

/** Detail panel view state: search, filters, display mode, and active stage. */
export const useDetailViewState = defineStore("detailView", () => {
  return {
    detailSearch: shallowRef(""),
    detailFilterRole: shallowRef(""),
    detailFilterType: shallowRef(""),
    aggregateTools: shallowRef(true),
    showOnlyRewritten: shallowRef(false),
    /** First-level pipeline-stage filter (inbound | effective | wire | upstream | forwarded | attempts | meta). */
    activeStage: shallowRef<string>("inbound"),
  }
})

/** Store type for consumers that need explicit typing */
export type DetailViewState = ReturnType<typeof useDetailViewState>
