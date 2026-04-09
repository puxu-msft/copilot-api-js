import { ref, type Ref } from "vue"

export interface DetailViewState {
  detailSearch: Ref<string>
  detailFilterRole: Ref<string>
  detailFilterType: Ref<string>
  aggregateTools: Ref<boolean>
  detailViewMode: Ref<"original" | "rewritten" | "diff" | null>
  showOnlyRewritten: Ref<boolean>
}

/** Detail panel view state: search, filters, and display mode */
export function useDetailViewState(): DetailViewState {
  return {
    detailSearch: ref(""),
    detailFilterRole: ref(""),
    detailFilterType: ref(""),
    aggregateTools: ref(true),
    detailViewMode: ref<"original" | "rewritten" | "diff" | null>(null),
    showOnlyRewritten: ref(false),
  }
}
