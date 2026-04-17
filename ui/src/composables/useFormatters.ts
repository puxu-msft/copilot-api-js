import { escapeHtml, formatDate, formatDuration, formatNumber, formatTime, highlightSearch } from "@/utils/formatters"

/** @deprecated Import functions directly from "@/utils/formatters" instead */
export function useFormatters() {
  return { formatTime, formatDate, formatNumber, formatDuration, escapeHtml, highlightSearch }
}
