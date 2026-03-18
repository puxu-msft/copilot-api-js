import { ref, computed, type Ref, type ComputedRef } from "vue"

import type { HistoryEntry, HistoryStats, Session, ContentBlock, MessageContent, EntrySummary, EndpointType } from "../types"

import { api } from "../api/http"
import { WSClient } from "../api/ws"

import { useToast } from "./useToast"

export interface HistoryStore {
  // Data
  entries: Ref<Array<EntrySummary>>
  selectedEntry: Ref<HistoryEntry | null>
  sessions: Ref<Array<Session>>
  stats: Ref<HistoryStats | null>

  // List filters
  searchQuery: Ref<string>
  filterEndpoint: Ref<string | null>
  filterSuccess: Ref<string | null>
  selectedSessionId: Ref<string | null>

  // Pagination
  page: Ref<number>
  totalPages: Ref<number>
  total: Ref<number>

  // UI state
  loading: Ref<boolean>
  error: Ref<string | null>
  wsConnected: Ref<boolean>

  // Detail panel state
  detailSearch: Ref<string>
  detailFilterRole: Ref<string>
  detailFilterType: Ref<string>
  aggregateTools: Ref<boolean>
  /** Global view mode for rewritten content: null = per-message control */
  detailViewMode: Ref<"original" | "rewritten" | "diff" | null>
  /** Filter to show only messages that were rewritten */
  showOnlyRewritten: Ref<boolean>

  // Computed
  hasSelection: ComputedRef<boolean>
  selectedIndex: ComputedRef<number>

  // Actions
  fetchEntries: () => Promise<void>
  fetchStats: () => Promise<void>
  fetchSessions: () => Promise<void>
  selectEntry: (id: string) => Promise<void>
  selectAdjacentEntry: (direction: "next" | "prev") => void
  clearSelection: () => void
  clearAll: () => Promise<void>
  refresh: () => Promise<void>
  setPage: (p: number) => void
  setSessionFilter: (id: string | null) => void
  setEndpointFilter: (ep: string | null) => void
  setSuccessFilter: (s: string | null) => void
  setSearch: (q: string) => void
  init: () => void
  destroy: () => void
}

export function useHistoryStore(): HistoryStore {
  const { show: showToast } = useToast()

  // ═══ Data ═══
  const entries = ref<Array<EntrySummary>>([])
  const selectedEntry = ref<HistoryEntry | null>(null)
  const sessions = ref<Array<Session>>([])
  const stats = ref<HistoryStats | null>(null)

  // ═══ Filters ═══
  const searchQuery = ref("")
  const filterEndpoint = ref<string | null>(null)
  const filterSuccess = ref<string | null>(null)
  const selectedSessionId = ref<string | null>(null)

  // ═══ Pagination ═══
  const page = ref(1)
  const totalPages = ref(1)
  const total = ref(0)
  const limit = 20

  // ═══ UI State ═══
  const loading = ref(false)
  const error = ref<string | null>(null)
  const wsConnected = ref(false)

  // ═══ Detail State ═══
  const detailSearch = ref("")
  const detailFilterRole = ref("")
  const detailFilterType = ref("")
  const aggregateTools = ref(true)
  const detailViewMode = ref<"original" | "rewritten" | "diff" | null>(null)
  const showOnlyRewritten = ref(false)

  // ═══ Computed ═══
  const hasSelection = computed(() => selectedEntry.value !== null)
  const selectedIndex = computed(() => {
    if (!selectedEntry.value) return -1
    return entries.value.findIndex((e) => e.id === selectedEntry.value?.id)
  })

  // ═══ WebSocket ═══
  let wsClient: WSClient | null = null

  // ═══ Actions ═══

  async function fetchEntries(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await api.fetchEntries({
        page: page.value,
        limit,
        endpoint: filterEndpoint.value as EndpointType | undefined,
        success: filterSuccess.value === null ? undefined : filterSuccess.value === "true",
        search: searchQuery.value || undefined,
        sessionId: selectedSessionId.value || undefined,
      })
      entries.value = result.entries
      totalPages.value = result.totalPages
      total.value = result.total

      // Auto-select first entry if nothing selected
      if (selectedEntry.value === null && entries.value.length > 0) {
        await selectEntry(entries.value[0].id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load entries"
      error.value = msg
      showToast(msg, "error")
    } finally {
      loading.value = false
    }
  }

  async function fetchStats(): Promise<void> {
    try {
      stats.value = await api.fetchStats()
    } catch {
      // Stats are non-critical, don't show error
    }
  }

  async function fetchSessions(): Promise<void> {
    try {
      const result = await api.fetchSessions()
      sessions.value = result.sessions
    } catch {
      // Sessions are non-critical
    }
  }

  async function selectEntry(id: string): Promise<void> {
    try {
      const entry = await api.fetchEntry(id)
      selectedEntry.value = entry
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load entry"
      showToast(msg, "error")
    }
  }

  function selectAdjacentEntry(direction: "next" | "prev"): void {
    const idx = selectedIndex.value
    if (entries.value.length === 0) return

    let newIdx: number
    if (idx === -1) {
      newIdx = 0
    } else if (direction === "next") {
      newIdx = Math.min(idx + 1, entries.value.length - 1)
    } else {
      newIdx = Math.max(idx - 1, 0)
    }

    const entry = entries.value[newIdx]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: array bounds
    if (entry) {
      void selectEntry(entry.id)
    }
  }

  function clearSelection(): void {
    selectedEntry.value = null
  }

  async function clearAll(): Promise<void> {
    try {
      await api.deleteEntries()
      entries.value = []
      selectedEntry.value = null
      stats.value = null
      total.value = 0
      totalPages.value = 1
      page.value = 1
      showToast("History cleared", "success")
      await fetchStats()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to clear history"
      showToast(msg, "error")
    }
  }

  async function refresh(): Promise<void> {
    const currentId = selectedEntry.value?.id
    await Promise.all([fetchEntries(), fetchStats(), fetchSessions()])
    // Reload current entry if it was selected (to get latest data)
    if (currentId) {
      await selectEntry(currentId)
    }
  }

  function setPage(p: number): void {
    if (p < 1 || p > totalPages.value) return
    page.value = p
    void fetchEntries()
  }

  function setSessionFilter(id: string | null): void {
    selectedSessionId.value = id
    page.value = 1
    void fetchEntries()
  }

  function setEndpointFilter(ep: string | null): void {
    filterEndpoint.value = ep
    page.value = 1
    void fetchEntries()
  }

  function setSuccessFilter(s: string | null): void {
    filterSuccess.value = s
    page.value = 1
    void fetchEntries()
  }

  function setSearch(q: string): void {
    searchQuery.value = q
    page.value = 1
    void fetchEntries()
  }

  // ═══ WebSocket Handlers ═══

  function handleEntryAdded(summary: EntrySummary): void {
    // If on first page, insert at the beginning
    if (page.value === 1) {
      entries.value.unshift(summary)
      // Keep list at limit size
      if (entries.value.length > limit) {
        entries.value.pop()
      }
      total.value++
      totalPages.value = Math.ceil(total.value / limit)
    }
  }

  function handleEntryUpdated(summary: EntrySummary): void {
    // Update summary in list
    const idx = entries.value.findIndex((e) => e.id === summary.id)
    if (idx !== -1) {
      entries.value[idx] = summary
    }
    // If the selected entry is the one being updated, re-fetch full entry
    // to keep the detail view current
    if (selectedEntry.value?.id === summary.id) {
      void selectEntry(summary.id)
    }
  }

  function handleStatsUpdated(newStats: HistoryStats): void {
    stats.value = newStats
  }

  // ═══ Init / Destroy ═══

  function init(): void {
    void refresh()

    wsClient = new WSClient({
      onEntryAdded: handleEntryAdded,
      onEntryUpdated: handleEntryUpdated,
      onStatsUpdated: handleStatsUpdated,
      onConnected: () => {},
      onHistoryCleared: () => void refresh(),
      onSessionDeleted: () => void refresh(),
      onStatusChange: (connected) => {
        wsConnected.value = connected
      },
    })
    wsClient.connect()
  }

  function destroy(): void {
    wsClient?.disconnect()
    wsClient = null
  }

  return {
    entries,
    selectedEntry,
    sessions,
    stats,
    searchQuery,
    filterEndpoint,
    filterSuccess,
    selectedSessionId,
    page,
    totalPages,
    total,
    loading,
    error,
    wsConnected,
    detailSearch,
    detailFilterRole,
    detailFilterType,
    aggregateTools,
    detailViewMode,
    showOnlyRewritten,
    hasSelection,
    selectedIndex,
    fetchEntries,
    fetchStats,
    fetchSessions,
    selectEntry,
    selectAdjacentEntry,
    clearSelection,
    clearAll,
    refresh,
    setPage,
    setSessionFilter,
    setEndpointFilter,
    setSuccessFilter,
    setSearch,
    init,
    destroy,
  }
}

// ═══ Helper: Extract preview text from entry ═══

export function getPreviewText(entry: HistoryEntry): string {
  const messages = entry.request.messages ?? []
  if (messages.length === 0) return ""

  // Walk backwards to find the last user message (skip OpenAI tool responses)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Skip OpenAI tool response messages
    if (msg.role === "tool") continue
    if (msg.role !== "user") continue

    // User message with only tool_result blocks — skip to previous messages
    if (Array.isArray(msg.content) && msg.content.every((b: ContentBlock) => b.type === "tool_result")) {
      continue
    }

    const text = extractText(msg.content)
    if (text) return text.slice(0, 100)
    break
  }

  // Fallback: if no user message, check for assistant tool_calls or tool responses
  const last = messages.at(-1)
  if (!last) return ""
  if (last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0) {
    const names = last.tool_calls.map((tc: { function: { name: string } }) => tc.function.name).join(", ")
    return `[tool_call: ${names}]`.slice(0, 100)
  }
  if (last.role === "tool") {
    return `[tool_result: ${last.tool_call_id ?? "unknown"}]`.slice(0, 100)
  }
  return extractText(last.content).slice(0, 100)
}

export function extractText(content: string | Array<ContentBlock> | null): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (b.type === "text" && "text" in b) return b.text
      if (b.type === "thinking" && "thinking" in b) return b.thinking
      if (b.type === "tool_use" && "name" in b) return `[Tool: ${String(b.name)}]`
      if (b.type === "tool_result") return "[Tool Result]"
      return ""
    })
    .filter(Boolean)
    .join(" ")
}

export function getStatusClass(entry: HistoryEntry | EntrySummary): "success" | "error" | "pending" {
  // Discriminate by a required field unique to EntrySummary
  if ("previewText" in entry) {
    // EntrySummary — has flat responseSuccess field
    if (entry.responseSuccess === undefined) return "pending"
    if (entry.responseSuccess) return "success"
    return "error"
  }
  // Full HistoryEntry — has nested response object
  if (!entry.response) return "pending"
  if (entry.response.success) return "success"
  return "error"
}

export function getMessageSummary(entry: HistoryEntry): string {
  const messages = entry.request.messages ?? []
  const msgCount = messages.length
  // Count messages with tool usage (Anthropic tool_use blocks OR OpenAI tool_calls)
  const toolCount = messages.filter((m: MessageContent) => {
    // OpenAI-style: assistant message with tool_calls array
    if (m.tool_calls && m.tool_calls.length > 0) return true
    // Anthropic-style: content array with tool_use blocks
    if (typeof m.content === "string") return false
    return Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === "tool_use")
  }).length
  let summary = `${msgCount} msg`
  if (toolCount > 0) summary += `, ${toolCount} tool`
  return summary
}
