export function useFormatters() {
  function formatTime(ts: number): string {
    const d = new Date(ts)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
  }

  function formatDate(ts: number): string {
    const d = new Date(ts)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) {
      return formatTime(ts)
    }
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day} ${formatTime(ts)}`
  }

  function formatNumber(n: number | undefined | null): string {
    if (n === undefined || n === null) return '-'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return n.toString()
  }

  function formatDuration(ms: number | undefined | null): string {
    if (!ms) return '-'
    if (ms < 1000) return ms + 'ms'
    return (ms / 1000).toFixed(1) + 's'
  }

  function escapeHtml(text: string): string {
    if (!text) return ''
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function highlightSearch(text: string, query: string): string {
    if (!query || !text) return escapeHtml(text)
    const escaped = escapeHtml(text)
    const queryEscaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp('(' + escapeHtml(queryEscaped) + ')', 'gi')
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>')
  }

  return { formatTime, formatDate, formatNumber, formatDuration, escapeHtml, highlightSearch }
}
