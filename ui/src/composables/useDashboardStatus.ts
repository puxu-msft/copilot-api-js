import {
  //
  computed,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
} from "vue"

import { api } from "@/api/http"
import {
  //
  WSClient,
  type ActiveRequestChangedInfo,
  type ActiveRequestInfo,
  type RateLimiterChangeInfo,
} from "@/api/ws"
import {
  //
  parseRequestTelemetry,
  type RequestTelemetrySnapshot,
} from "@/composables/telemetry-parse"
import { usePolling } from "@/composables/usePolling"
import { formatNumber } from "@/utils/formatters"

export interface QuotaItem {
  label: string
  used: number
  total: number
}

export interface RateLimiterSnapshot {
  enabled: boolean
  mode: string | null
  queueLength: number
  consecutiveSuccesses: number
  rateLimitedAt: number | null
  config: Record<string, unknown> | null
}

const ACTIVE_REQUEST_REMOVE_DELAY_MS = 3000

export function useDashboardStatus() {
  const { data: status, loading: statusLoading } = usePolling(() => api.fetchStatus(), 5000)

  const activeRequests = ref<Array<ActiveRequestInfo>>([])
  const activeCount = shallowRef(0)
  const wsRateLimiterMode = shallowRef<string | null>(null)
  const wsRateLimiterQueue = shallowRef<number | null>(null)
  const wsShutdownPhase = shallowRef<string | null>(null)
  const wsConnected = shallowRef(false)

  let wsClient: WSClient | null = null
  const pendingRequestRemovals = new Map<string, ReturnType<typeof setTimeout>>()

  function cancelPendingRemoval(requestId: string): void {
    const timer = pendingRequestRemovals.get(requestId)
    if (!timer) return
    clearTimeout(timer)
    pendingRequestRemovals.delete(requestId)
  }

  function scheduleDelayedRemoval(requestId: string): void {
    cancelPendingRemoval(requestId)
    const timer = setTimeout(() => {
      activeRequests.value = activeRequests.value.filter((request) => request.id !== requestId)
      pendingRequestRemovals.delete(requestId)
    }, ACTIVE_REQUEST_REMOVE_DELAY_MS)
    pendingRequestRemovals.set(requestId, timer)
  }

  function upsertActiveRequest(request: ActiveRequestInfo): void {
    const existingIndex = activeRequests.value.findIndex((entry) => entry.id === request.id)
    if (existingIndex === -1) {
      activeRequests.value = [...activeRequests.value, request]
      return
    }

    activeRequests.value = activeRequests.value.map((entry, index) => (index === existingIndex ? request : entry))
  }

  function handleActiveRequestChanged(data: ActiveRequestChangedInfo): void {
    activeCount.value = data.activeCount
    if (data.action === "created" && data.request) {
      cancelPendingRemoval(data.request.id)
      upsertActiveRequest(data.request)
    } else if (data.action === "state_changed" && data.request) {
      const request = data.request
      cancelPendingRemoval(request.id)
      upsertActiveRequest(request)
    } else if ((data.action === "completed" || data.action === "failed") && data.requestId) {
      scheduleDelayedRemoval(data.requestId)
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
    for (const timer of pendingRequestRemovals.values()) {
      clearTimeout(timer)
    }
    pendingRequestRemovals.clear()
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
  const rateLimiter = computed<RateLimiterSnapshot | null>(() => {
    const source = (status.value?.rateLimiter as Record<string, unknown> | null) ?? null
    if (!source) return null

    return {
      enabled: source.enabled === true,
      mode: rateLimiterMode.value,
      queueLength: rateLimiterQueue.value ?? 0,
      consecutiveSuccesses: typeof source.consecutiveSuccesses === "number" ? source.consecutiveSuccesses : 0,
      rateLimitedAt: typeof source.rateLimitedAt === "number" ? source.rateLimitedAt : null,
      config: source.config && typeof source.config === "object" ? (source.config as Record<string, unknown>) : null,
    }
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
  const requestTelemetry = computed<RequestTelemetrySnapshot | null>(() => parseRequestTelemetry(status.value?.requestTelemetry))
  const quotaPlan = computed<string | null>(() => {
    const plan = quota.value?.plan
    return typeof plan === "string" ? plan : null
  })
  const totalEvictedCount = computed(() => Number(memory.value?.totalEvictedCount ?? 0))
  const copilotExpiresAt = computed(() => {
    if (!auth.value?.copilotTokenExpiresAt) return null
    return new Date(auth.value.copilotTokenExpiresAt as number).toLocaleTimeString()
  })

  const resolvedActiveCount = computed(() => activeCount.value || (status.value?.activeRequests as Record<string, number> | undefined)?.count || 0)

  const quotaItems = computed<Array<QuotaItem>>(() => {
    if (!quota.value) return []
    const items: Array<QuotaItem> = []
    for (const [key, label] of [
      ["premiumInteractions", "Premium"],
      ["chat", "Chat"],
      ["completions", "Completions"],
    ] as const) {
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
    const normalized = typeof value === "number" || value === null || value === undefined ? value : Number(value)
    return formatNumber(normalized)
  }

  return {
    activeRequests,
    auth,
    copilotExpiresAt,
    formatNumber: formatMetric,
    memory,
    quotaItems,
    quotaPlan,
    requestTelemetry,
    rateLimiter,
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

// Re-export the telemetry types (now owned by telemetry-parse.ts) so existing
// consumers importing them from "./useDashboardStatus" keep working.
export {
  type RequestTelemetryBucket,
  type RequestTelemetryModelBucket,
  type RequestTelemetryModelStats,
  type RequestTelemetrySnapshot,
} from "@/composables/telemetry-parse"
