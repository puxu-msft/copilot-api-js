import { computed, onMounted, onUnmounted, ref } from "vue"

import { api } from "@/api/http"
import { WSClient, type ActiveRequestChangedInfo, type ActiveRequestInfo, type RateLimiterChangeInfo } from "@/api/ws"
import { useFormatters } from "@/composables/useFormatters"
import { usePolling } from "@/composables/usePolling"

export interface QuotaItem {
  label: string
  used: number
  total: number
}

export function useDashboardStatus() {
  const { formatNumber } = useFormatters()
  const { data: status, loading: statusLoading } = usePolling(() => api.fetchStatus(), 5000)

  const activeRequests = ref<Array<ActiveRequestInfo>>([])
  const activeCount = ref(0)
  const wsRateLimiterMode = ref<string | null>(null)
  const wsRateLimiterQueue = ref<number | null>(null)
  const wsShutdownPhase = ref<string | null>(null)
  const wsConnected = ref(false)

  let wsClient: WSClient | null = null

  function handleActiveRequestChanged(data: ActiveRequestChangedInfo): void {
    activeCount.value = data.activeCount
    if (data.action === "created" && data.request) {
      activeRequests.value = [...activeRequests.value, data.request]
    } else if (data.action === "state_changed" && data.request) {
      const request = data.request
      activeRequests.value = activeRequests.value.map((r) => (r.id === request.id ? request : r))
    } else if (data.action === "completed" || data.action === "failed") {
      activeRequests.value = activeRequests.value.filter((r) => r.id !== data.requestId)
    }
  }

  function handleRateLimiterChanged(data: RateLimiterChangeInfo): void {
    wsRateLimiterMode.value = data.mode
    wsRateLimiterQueue.value = data.queueLength
  }

  onMounted(() => {
    wsClient = new WSClient({
      topics: ["requests", "status"],
      onActiveRequestChanged: handleActiveRequestChanged,
      onRateLimiterChanged: handleRateLimiterChanged,
      onShutdownPhaseChanged: (data) => {
        wsShutdownPhase.value = data.phase
      },
      onStatusChange: (connected) => {
        wsConnected.value = connected
      },
    })
    wsClient.connect()
  })

  onUnmounted(() => {
    wsClient?.disconnect()
    wsClient = null
  })

  const rateLimiterMode = computed<string | null>(() => {
    const fallback = (status.value?.rateLimiter as Record<string, unknown> | null)?.mode
    return wsRateLimiterMode.value ?? (typeof fallback === "string" ? fallback : null)
  })
  const rateLimiterQueue = computed<number | null>(() => {
    const fallback = (status.value?.rateLimiter as Record<string, unknown> | null)?.queueLength
    return wsRateLimiterQueue.value ?? (typeof fallback === "number" ? fallback : null)
  })
  const shutdownPhase = computed<string>(() => {
    const fallback = (status.value?.shutdown as Record<string, unknown> | null)?.phase
    return wsShutdownPhase.value ?? (typeof fallback === "string" ? fallback : "idle")
  })

  const uptime = computed(() => {
    const secs = status.value?.uptime as number | undefined
    if (!secs) return "-"
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  })

  const auth = computed(() => (status.value?.auth as Record<string, unknown> | null) ?? null)
  const quota = computed(() => (status.value?.quota as Record<string, unknown> | null) ?? null)
  const memory = computed(() => (status.value?.memory as Record<string, unknown> | null) ?? null)
  const quotaPlan = computed<string | null>(() => {
    const plan = quota.value?.plan
    return typeof plan === "string" ? plan : null
  })
  const totalEvictedCount = computed(() => Number(memory.value?.totalEvictedCount ?? 0))
  const copilotExpiresAt = computed(() => {
    if (!auth.value?.copilotTokenExpiresAt) return null
    return new Date(auth.value.copilotTokenExpiresAt as number).toLocaleTimeString()
  })

  const resolvedActiveCount = computed(
    () => activeCount.value || (status.value?.activeRequests as Record<string, number> | undefined)?.count || 0,
  )

  const quotaItems = computed<Array<QuotaItem>>(() => {
    if (!quota.value) return []
    const items: Array<QuotaItem> = []
    for (const [key, label] of [["premiumInteractions", "Premium"], ["chat", "Chat"], ["completions", "Completions"]] as const) {
      const q = quota.value[key] as Record<string, number> | undefined
      if (q) {
        items.push({ label, used: q.entitlement - q.remaining, total: q.entitlement })
      }
    }
    return items
  })

  function rateLimiterColor(mode: unknown): string {
    if (mode === "normal") return "success"
    if (mode === "recovering") return "warning"
    if (mode === "rate-limited") return "error"
    return "secondary"
  }

  function requestStateColor(state: string): string {
    if (state === "executing") return "primary"
    if (state === "streaming") return "success"
    return "secondary"
  }

  function formatMetric(value: unknown): string {
    return formatNumber(typeof value === "number" || value == null ? value : Number(value))
  }

  return {
    activeRequests,
    auth,
    copilotExpiresAt,
    formatNumber: formatMetric,
    memory,
    quotaItems,
    quotaPlan,
    rateLimiterColor,
    rateLimiterMode,
    rateLimiterQueue,
    requestStateColor,
    resolvedActiveCount,
    shutdownPhase,
    status,
    statusLoading,
    totalEvictedCount,
    uptime,
    wsConnected,
  }
}
