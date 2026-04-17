import { shallowRef } from "vue"
import { defineStore } from "pinia"

/** Detail panel view state: search, filters, and display mode */
export const useDetailViewState = defineStore("detailView", () => {
  return {
    detailSearch: shallowRef(""),
    detailFilterRole: shallowRef(""),
    detailFilterType: shallowRef(""),
    aggregateTools: shallowRef(true),
    detailViewMode: shallowRef<"original" | "rewritten" | "diff" | null>(null),
    showOnlyRewritten: shallowRef(false),
  }
})

/** Store type for consumers that need explicit typing */
export type DetailViewState = ReturnType<typeof useDetailViewState>
