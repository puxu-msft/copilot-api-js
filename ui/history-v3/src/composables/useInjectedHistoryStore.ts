import { inject } from "vue"

import type { HistoryStore } from "@/composables/useHistoryStore"

export function useInjectedHistoryStore(): HistoryStore {
  const store = inject<HistoryStore>("historyStore")

  if (!store) {
    throw new Error("historyStore injection missing")
  }

  return store
}
