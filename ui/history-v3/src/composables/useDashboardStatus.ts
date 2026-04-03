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

export interface RequestTelemetryBucket {
  timestamp: number
  count: number
}

export interface RequestTelemetryModelBucket {
  timestamp: number
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    reasoningTokens: number
  }
}

export interface RequestTelemetryModelStats {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    reasoningTokens: number
  }
}

export interface RequestTelemetrySnapshot {
  acceptedSinceStart: number
  bucketSizeMinutes: number
  windowDays: number
  totalLast7d: number
  buckets: Array<RequestTelemetryBucket>
  modelsSinceStart: Array<RequestTelemetryModelStats>
  modelsLast7d: Array<RequestTelemetryModelStats & { buckets: Array<RequestTelemetryModelBucket> }>
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
  const { formatNumber } = useFormatters()
  const { data: status, loading: statusLoading } = usePolling(() => api.fetchStatus(), 5000)

  const activeRequests = ref<Array<ActiveRequestInfo>>([])
  const activeCount = ref(0)
  const wsRateLimiterMode = ref<string | null>(null)
  const wsRateLimiterQueue = ref<number | null>(null)
  const wsShutdownPhase = ref<string | null>(null)
  const wsConnected = ref(false)

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
    } else if (data.action === "completed" || data.action === "failed") {
      if (data.requestId) {
        scheduleDelayedRemoval(data.requestId)
      }
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
  const requestTelemetry = computed<RequestTelemetrySnapshot | null>(() => {
    const source = (status.value?.requestTelemetry as Record<string, unknown> | null) ?? null
    if (!source) return null

    const rawBuckets = Array.isArray(source.buckets) ? source.buckets : []
    const buckets = rawBuckets
      .filter((bucket): bucket is Record<string, unknown> => Boolean(bucket) && typeof bucket === "object")
      .map((bucket) => ({
        timestamp: typeof bucket.timestamp === "number" ? bucket.timestamp : 0,
        count: typeof bucket.count === "number" ? bucket.count : 0,
      }))
    const parseUsage = (rawValue: unknown) => {
      const usage = (rawValue && typeof rawValue === "object" ? rawValue : {}) as Record<string, unknown>
      return {
        inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
        outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
        totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
        cacheReadInputTokens: typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : 0,
        cacheCreationInputTokens: typeof usage.cacheCreationInputTokens === "number" ? usage.cacheCreationInputTokens : 0,
        reasoningTokens: typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : 0,
      }
    }
    const parseModelStats = (entry: Record<string, unknown>) => {
      return {
        model: typeof entry.model === "string" ? entry.model : "unknown",
        requestCount: typeof entry.requestCount === "number" ? entry.requestCount : 0,
        successCount: typeof entry.successCount === "number" ? entry.successCount : 0,
        failureCount: typeof entry.failureCount === "number" ? entry.failureCount : 0,
        totalDurationMs: typeof entry.totalDurationMs === "number" ? entry.totalDurationMs : 0,
        averageDurationMs: typeof entry.averageDurationMs === "number" ? entry.averageDurationMs : 0,
        usage: parseUsage(entry.usage),
      }
    }
    const parseModels = (rawValue: unknown) =>
      (Array.isArray(rawValue) ? rawValue : [])
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => parseModelStats(entry))
    const parseModelSeries = (rawValue: unknown) =>
      (Array.isArray(rawValue) ? rawValue : [])
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => {
          const stats = parseModelStats(entry)
          const buckets = (Array.isArray(entry.buckets) ? entry.buckets : [])
            .filter((bucket): bucket is Record<string, unknown> => Boolean(bucket) && typeof bucket === "object")
            .map((bucket) => ({
              timestamp: typeof bucket.timestamp === "number" ? bucket.timestamp : 0,
              requestCount: typeof bucket.requestCount === "number" ? bucket.requestCount : 0,
              successCount: typeof bucket.successCount === "number" ? bucket.successCount : 0,
              failureCount: typeof bucket.failureCount === "number" ? bucket.failureCount : 0,
              totalDurationMs: typeof bucket.totalDurationMs === "number" ? bucket.totalDurationMs : 0,
              averageDurationMs: typeof bucket.averageDurationMs === "number" ? bucket.averageDurationMs : 0,
              usage: parseUsage(bucket.usage),
            }))

          return {
            ...stats,
            buckets,
          }
        })
    const modelsSinceStart = parseModels(source.modelsSinceStart)
    const modelsLast7d = parseModelSeries(source.modelsLast7d)

    return {
      acceptedSinceStart: typeof source.acceptedSinceStart === "number" ? source.acceptedSinceStart : 0,
      bucketSizeMinutes: typeof source.bucketSizeMinutes === "number" ? source.bucketSizeMinutes : 5,
      windowDays: typeof source.windowDays === "number" ? source.windowDays : 7,
      totalLast7d: typeof source.totalLast7d === "number" ? source.totalLast7d : 0,
      buckets,
      modelsSinceStart,
      modelsLast7d,
    }
  })
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
