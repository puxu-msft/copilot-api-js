<script setup lang="ts">
/** @deprecated Use VDashboardPage.vue (`/v/dashboard`) for ongoing UI work. */
import { ref, computed, onMounted, onUnmounted } from "vue"

import { api } from "@/api/http"
import { WSClient, type ActiveRequestChangedInfo, type ActiveRequestInfo, type RateLimiterChangeInfo } from "@/api/ws"
import DataCard from "@/components/ui/DataCard.vue"
import ProgressBar from "@/components/ui/ProgressBar.vue"
import { useFormatters } from "@/composables/useFormatters"
import { usePolling } from "@/composables/usePolling"

const { formatNumber } = useFormatters()

// HTTP polling for status (base data, WS overlays real-time fields)
const { data: status, loading: statusLoading } = usePolling(() => api.fetchStatus(), 5000)

const { data: config } = usePolling(() => api.fetchConfig(), 30000)

// WS real-time state for rapidly-changing fields
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

// Use WS value when available, fall back to HTTP polling value
const rateLimiterMode = computed(
  () => wsRateLimiterMode.value ?? (status.value?.rateLimiter as Record<string, unknown> | null)?.mode ?? null,
)
const rateLimiterQueue = computed(
  () => wsRateLimiterQueue.value ?? (status.value?.rateLimiter as Record<string, unknown> | null)?.queueLength ?? null,
)
const shutdownPhase = computed(
  () => wsShutdownPhase.value ?? (status.value?.shutdown as Record<string, unknown> | null)?.phase ?? "idle",
)

/** Server uptime formatted */
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
const resolvedActiveCount = computed(
  () => activeCount.value || (status.value?.activeRequests as Record<string, number> | undefined)?.count || 0,
)
const copilotExpiresAt = computed(() => {
  if (!auth.value?.copilotTokenExpiresAt) return null
  return new Date(auth.value.copilotTokenExpiresAt as number).toLocaleTimeString()
})
const quotaPlan = computed(() => quota.value?.plan ?? null)
const totalEvictedCount = computed(() => Number(memory.value?.totalEvictedCount ?? 0))

/** Config key-value pairs */
const configEntries = computed(() => {
  if (!config.value) return []
  return Object.entries(config.value).map(([key, value]) => ({
    key,
    value: typeof value === "object" ? JSON.stringify(value) : String(value),
  }))
})

/** Quota bar items */
interface QuotaItem {
  label: string
  used: number
  total: number
}

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
      items.push({
        label,
        used: q.entitlement - q.remaining,
        total: q.entitlement,
      })
    }
  }
  return items
})
</script>

<template>
  <div class="dashboard-page">
    <div class="dashboard-header">
      <h2 class="dashboard-title">Dashboard</h2>
      <span
        v-if="wsConnected"
        class="ws-badge ws-live"
        >WS Live</span
      >
      <span
        v-else
        class="ws-badge ws-offline"
        >WS Offline</span
      >
    </div>

    <div
      v-if="statusLoading && !status"
      class="dashboard-loading"
    >
      Loading server status...
    </div>

    <div
      v-else
      class="dashboard-grid"
    >
      <!-- Status Card -->
      <DataCard title="Status">
        <div class="kv-list">
          <div class="kv-row">
            <span class="kv-key">Health</span>
            <span
              class="kv-value"
              :class="status?.status === 'healthy' ? 'text-success' : 'text-error'"
            >
              {{ status?.status ?? "-" }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Uptime</span>
            <span class="kv-value">{{ uptime }}</span>
          </div>
          <div
            v-if="status?.version"
            class="kv-row"
          >
            <span class="kv-key">Version</span>
            <span class="kv-value mono">{{ status.version }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Shutdown</span>
            <span
              class="kv-value"
              :class="shutdownPhase !== 'idle' ? 'text-warning' : ''"
            >
              {{ shutdownPhase }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Active Reqs</span>
            <span class="kv-value mono">{{ resolvedActiveCount }}</span>
          </div>
        </div>
      </DataCard>

      <!-- Auth Card -->
      <DataCard title="Authentication">
        <div
          v-if="auth"
          class="kv-list"
        >
          <div class="kv-row">
            <span class="kv-key">Account</span>
            <span class="kv-value">{{ auth.accountType }}</span>
          </div>
          <div
            v-if="auth.tokenSource"
            class="kv-row"
          >
            <span class="kv-key">Token Source</span>
            <span class="kv-value">{{ auth.tokenSource }}</span>
          </div>
          <div
            v-if="copilotExpiresAt"
            class="kv-row"
          >
            <span class="kv-key">Copilot Expires</span>
            <span class="kv-value mono">{{ copilotExpiresAt }}</span>
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No auth info
        </div>
      </DataCard>

      <!-- Quota Card -->
      <DataCard title="Quota">
        <div
          v-if="quotaItems.length > 0"
          class="quota-list"
        >
          <div
            v-if="quotaPlan"
            class="kv-row"
            style="margin-bottom: 8px"
          >
            <span class="kv-key">Plan</span>
            <span class="kv-value">{{ quotaPlan }}</span>
          </div>
          <div
            v-for="item in quotaItems"
            :key="item.label"
            class="quota-item"
          >
            <div class="quota-header">
              <span class="quota-label">{{ item.label }}</span>
              <span class="quota-numbers">{{ formatNumber(item.used) }} / {{ formatNumber(item.total) }}</span>
            </div>
            <ProgressBar
              :value="item.used"
              :max="item.total"
            />
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No quota data
        </div>
      </DataCard>

      <!-- Rate Limiter Card -->
      <DataCard title="Rate Limiter">
        <div class="kv-list">
          <div class="kv-row">
            <span class="kv-key">Mode</span>
            <span
              class="kv-value"
              :class="{
                'text-success': rateLimiterMode === 'normal',
                'text-warning': rateLimiterMode === 'recovering',
                'text-error': rateLimiterMode === 'rate-limited',
              }"
            >
              {{ rateLimiterMode ?? "N/A" }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Queue</span>
            <span class="kv-value mono">{{ rateLimiterQueue ?? 0 }}</span>
          </div>
        </div>
      </DataCard>

      <!-- Memory Card -->
      <DataCard title="Memory">
        <div
          v-if="memory"
          class="kv-list"
        >
          <div class="kv-row">
            <span class="kv-key">Heap</span>
            <span class="kv-value mono"
              >{{ memory.heapUsedMB }} MB{{ memory.heapLimitMB ? ` / ${memory.heapLimitMB} MB` : "" }}</span
            >
          </div>
          <div
            v-if="memory.heapLimitMB"
            class="kv-row"
          >
            <span class="kv-key"></span>
            <span
              class="kv-value"
              style="flex: 1"
            >
              <ProgressBar
                :value="Number(memory.heapUsedMB)"
                :max="Number(memory.heapLimitMB)"
              />
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">History</span>
            <span class="kv-value mono">{{ memory.historyEntryCount }} / {{ memory.historyMaxEntries }} entries</span>
          </div>
          <div
            v-if="totalEvictedCount > 0"
            class="kv-row"
          >
            <span class="kv-key">Evicted</span>
            <span class="kv-value mono">{{ totalEvictedCount }}</span>
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No memory info
        </div>
      </DataCard>

      <!-- Active Requests Card (WS real-time) -->
      <DataCard
        v-if="activeRequests.length > 0"
        title="Active Requests"
      >
        <div class="active-list">
          <div
            v-for="req in activeRequests"
            :key="req.id"
            class="active-item"
          >
            <span
              class="active-dot"
              :class="{
                'dot-executing': req.state === 'executing',
                'dot-streaming': req.state === 'streaming',
                'dot-pending': req.state === 'pending',
              }"
            ></span>
            <span class="active-model">{{ req.model ?? "?" }}</span>
            <span class="active-state">{{ req.state }}</span>
            <span class="active-duration mono">{{ Math.round(req.durationMs / 1000) }}s</span>
          </div>
        </div>
      </DataCard>

      <!-- Config Card -->
      <DataCard title="Configuration">
        <div
          v-if="configEntries.length > 0"
          class="kv-list config-list"
        >
          <div
            v-for="item in configEntries"
            :key="item.key"
            class="kv-row"
          >
            <span class="kv-key">{{ item.key }}</span>
            <span class="kv-value mono">{{ item.value }}</span>
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No config available
        </div>
      </DataCard>
    </div>
  </div>
</template>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
}

.dashboard-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.dashboard-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.ws-badge {
  font-size: var(--font-size-xs);
  padding: 1px 6px;
}

.ws-live {
  color: var(--success);
}
.ws-offline {
  color: var(--text-dim);
}

.dashboard-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--spacing-lg);
  padding: var(--spacing-lg);
}

.kv-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
.kv-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}
.kv-key {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  min-width: 100px;
  flex-shrink: 0;
}
.kv-value {
  font-size: var(--font-size-xs);
  color: var(--text);
}
.kv-value.mono {
  font-family: var(--font-mono);
  word-break: break-all;
}

.text-success {
  color: var(--success);
}
.text-error {
  color: var(--error);
}
.text-warning {
  color: var(--warning);
}

.card-empty {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: var(--spacing-sm) 0;
}

.quota-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
.quota-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
.quota-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.quota-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.quota-numbers {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.config-list {
  max-height: 300px;
  overflow-y: auto;
}

.active-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
.active-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-xs);
}
.active-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-executing {
  background: var(--primary);
}
.dot-streaming {
  background: var(--success);
}
.dot-pending {
  background: var(--text-dim);
}
.active-model {
  color: var(--text);
  min-width: 120px;
}
.active-state {
  color: var(--text-dim);
  min-width: 70px;
}
.active-duration {
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
</style>
