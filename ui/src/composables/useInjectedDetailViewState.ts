import { inject } from "vue"

import type { DetailViewState } from "@/composables/useDetailViewState"

export function useInjectedDetailViewState(): DetailViewState {
  const state = inject<DetailViewState>("detailViewState")

  if (!state) {
    throw new Error("detailViewState injection missing")
  }

  return state
}
