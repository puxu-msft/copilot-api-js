import { computed, type Ref, unref } from "vue"

import { useFormatters } from "./useFormatters"

export function useHighlightHtml(text: Ref<string> | (() => string), searchQuery: Ref<string> | (() => string)) {
  const { highlightSearch, escapeHtml } = useFormatters()

  const displayHtml = computed(() => {
    const t = typeof text === "function" ? text() : unref(text)
    const q = typeof searchQuery === "function" ? searchQuery() : unref(searchQuery)
    return q ? highlightSearch(t, q) : escapeHtml(t)
  })

  return { displayHtml }
}
