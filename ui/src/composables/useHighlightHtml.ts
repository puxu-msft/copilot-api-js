import {
  //
  computed,
  type Ref,
  unref,
} from "vue"

import {
  //
  escapeHtml,
  highlightSearch,
} from "@/utils/formatters"

export function useHighlightHtml(text: Ref<string> | (() => string), searchQuery: Ref<string> | (() => string)) {
  const displayHtml = computed(() => {
    const t = typeof text === "function" ? text() : unref(text)
    const q = typeof searchQuery === "function" ? searchQuery() : unref(searchQuery)
    return q ? highlightSearch(t, q) : escapeHtml(t)
  })

  return { displayHtml }
}
