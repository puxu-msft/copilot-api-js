<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue"

import { api } from "@/api/http"
import { WSClient, type ActiveRequestChangedInfo, type ActiveRequestInfo, type RateLimiterChangeInfo } from "@/api/ws"
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
const quotaPlan = computed(() => quota.value?.plan ?? null)
const totalEvictedCount = computed(() => Number(memory.value?.totalEvictedCount ?? 0))
const copilotExpiresAt = computed(() => {
  if (!auth.value?.copilotTokenExpiresAt) return null
  return new Date(auth.value.copilotTokenExpiresAt as number).toLocaleTimeString()
})

/** Resolved active request count — WS overrides HTTP polling */
const resolvedActiveCount = computed(
  () => activeCount.value || (status.value?.activeRequests as Record<string, number> | undefined)?.count || 0,
)

/** Config entries — group by category, render complex values properly */
interface ConfigEntry {
  key: string
  value: string
  isComplex: boolean
}
interface ConfigGroup {
  label: string
  entries: Array<ConfigEntry>
}

const configGroups = computed<Array<ConfigGroup>>(() => {
  if (!config.value) return []
  const raw = config.value

  function fmt(v: unknown): ConfigEntry["value"] {
    if (v === null || v === undefined) return "null"
    if (typeof v === "boolean") return v ? "true" : "false"
    if (typeof v === "number") return String(v)
    if (typeof v === "string") return v || '""'
    return JSON.stringify(v, null, 2)
  }

  function isComplex(v: unknown): boolean {
    return typeof v === "object" && v !== null
  }

  function entry(key: string): ConfigEntry {
    return { key, value: fmt(raw[key]), isComplex: isComplex(raw[key]) }
  }

  return [
    {
      label: "Anthropic Pipeline",
      entries: [
        entry("autoTruncate"),
        entry("compressToolResultsBeforeTruncate"),
        entry("stripServerTools"),
        entry("immutableThinkingMessages"),
        entry("dedupToolCalls"),
        entry("contextEditingMode"),
        entry("rewriteSystemReminders"),
        entry("stripReadToolResultTags"),
        entry("systemPromptOverridesCount"),
      ],
    },
    {
      label: "OpenAI",
      entries: [entry("normalizeResponsesCallIds")],
    },
    {
      label: "Timeouts",
      entries: [entry("fetchTimeout"), entry("streamIdleTimeout"), entry("staleRequestMaxAge")],
    },
    {
      label: "Shutdown",
      entries: [entry("shutdownGracefulWait"), entry("shutdownAbortWait")],
    },
    {
      label: "History",
      entries: [entry("historyLimit"), entry("historyMinEntries")],
    },
    {
      label: "Model Overrides",
      entries:
        raw.modelOverrides ?
          Object.entries(raw.modelOverrides as Record<string, string>).map(([from, to]) => ({
            key: from,
            value: to,
            isComplex: false,
          }))
        : [],
    },
    {
      label: "Rate Limiter",
      entries: [entry("rateLimiter")],
    },
  ].filter((g) => g.entries.length > 0)
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

/** Rate limiter mode color */
function rateLimiterColor(mode: unknown): string {
  if (mode === "normal") return "success"
  if (mode === "recovering") return "warning"
  if (mode === "rate-limited") return "error"
  return "secondary"
}

/** Active request state color */
function requestStateColor(state: string): string {
  if (state === "executing") return "primary"
  if (state === "streaming") return "success"
  return "secondary"
}
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <!-- Loading state -->
    <div
      v-if="statusLoading && !status"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else
      class="flex-grow-1 overflow-y-auto"
    >
      <!-- Top status bar — compact inline row -->
      <div class="status-bar px-4 py-3 d-flex align-center flex-wrap ga-4">
        <v-chip
          :color="status?.status === 'healthy' ? 'success' : 'error'"
          size="small"
          variant="flat"
        >
          <v-icon
            start
            size="x-small"
          >
            {{ status?.status === "healthy" ? "mdi-check-circle" : "mdi-alert-circle" }}
          </v-icon>
          {{ status?.status ?? "unknown" }}
        </v-chip>

        <div class="d-flex align-center ga-1">
          <span class="text-caption text-medium-emphasis">Uptime</span>
          <span class="text-caption mono">{{ uptime }}</span>
        </div>

        <div
          v-if="status?.version"
          class="d-flex align-center ga-1"
        >
          <span class="text-caption text-medium-emphasis">Version</span>
          <span class="text-caption mono">{{ status.version }}</span>
        </div>

        <div class="d-flex align-center ga-1">
          <span class="text-caption text-medium-emphasis">Active</span>
          <span class="text-caption mono">{{ resolvedActiveCount }}</span>
        </div>

        <v-chip
          v-if="shutdownPhase !== 'idle'"
          color="warning"
          size="small"
          variant="flat"
        >
          <v-icon
            start
            size="x-small"
            >mdi-power</v-icon
          >
          {{ shutdownPhase }}
        </v-chip>

        <v-spacer />

        <v-chip
          :color="wsConnected ? 'success' : 'error'"
          size="small"
          variant="tonal"
        >
          {{ wsConnected ? "WS Live" : "WS Offline" }}
        </v-chip>
      </div>

      <v-divider />

      <!-- Two-column layout: Left (Auth + Rate Limiter + Memory) | Right (Quota) -->
      <div class="two-col pa-4">
        <!-- Left column: Auth, Rate Limiter, Memory -->
        <div class="d-flex flex-column ga-1">
          <!-- Auth section -->
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase px-2 pt-2">
            Authentication
          </div>
          <v-list
            density="compact"
            class="bg-transparent py-0"
          >
            <template v-if="auth">
              <v-list-item
                class="px-2"
                style="min-height: 32px"
              >
                <template #prepend>
                  <span class="kv-label text-caption text-medium-emphasis">Account</span>
                </template>
                <v-list-item-title class="text-caption">{{ auth.accountType }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                v-if="auth.tokenSource"
                class="px-2"
                style="min-height: 32px"
              >
                <template #prepend>
                  <span class="kv-label text-caption text-medium-emphasis">Token Source</span>
                </template>
                <v-list-item-title class="text-caption">{{ auth.tokenSource }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                v-if="copilotExpiresAt"
                class="px-2"
                style="min-height: 32px"
              >
                <template #prepend>
                  <span class="kv-label text-caption text-medium-emphasis">Expires</span>
                </template>
                <v-list-item-title class="text-caption mono">
                  {{ copilotExpiresAt }}
                </v-list-item-title>
              </v-list-item>
            </template>
            <v-list-item
              v-else
              class="px-2"
              style="min-height: 32px"
            >
              <v-list-item-title class="text-caption text-disabled">No auth info</v-list-item-title>
            </v-list-item>
          </v-list>

          <v-divider class="my-1" />

          <!-- Rate Limiter section -->
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase px-2 pt-1">
            Rate Limiter
          </div>
          <v-list
            density="compact"
            class="bg-transparent py-0"
          >
            <v-list-item
              class="px-2"
              style="min-height: 32px"
            >
              <template #prepend>
                <span class="kv-label text-caption text-medium-emphasis">Mode</span>
              </template>
              <v-list-item-title>
                <v-chip
                  :color="rateLimiterColor(rateLimiterMode)"
                  size="x-small"
                >
                  {{ rateLimiterMode ?? "N/A" }}
                </v-chip>
              </v-list-item-title>
            </v-list-item>
            <v-list-item
              class="px-2"
              style="min-height: 32px"
            >
              <template #prepend>
                <span class="kv-label text-caption text-medium-emphasis">Queue</span>
              </template>
              <v-list-item-title class="text-caption mono">{{ rateLimiterQueue ?? 0 }}</v-list-item-title>
            </v-list-item>
          </v-list>

          <v-divider class="my-1" />

          <!-- Memory section -->
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase px-2 pt-1">
            Memory
          </div>
          <div
            v-if="memory"
            class="px-2 pb-2"
          >
            <div class="d-flex justify-space-between text-caption mb-1">
              <span class="text-medium-emphasis">Heap</span>
              <span class="mono">
                {{ memory.heapUsedMB }} MB{{ memory.heapLimitMB ? ` / ${memory.heapLimitMB} MB` : "" }}
              </span>
            </div>
            <v-progress-linear
              v-if="memory.heapLimitMB"
              :model-value="(Number(memory.heapUsedMB) / Number(memory.heapLimitMB)) * 100"
              color="primary"
              rounded
              height="4"
              class="mb-2"
            />
            <div class="d-flex justify-space-between text-caption">
              <span class="text-medium-emphasis">History</span>
              <span class="mono"> {{ memory.historyEntryCount }} / {{ memory.historyMaxEntries }} entries </span>
            </div>
            <div
              v-if="totalEvictedCount > 0"
              class="d-flex justify-space-between text-caption mt-1"
            >
              <span class="text-medium-emphasis">Evicted</span>
              <span class="mono">{{ totalEvictedCount }}</span>
            </div>
          </div>
          <div
            v-else
            class="text-caption text-disabled px-2 pb-2"
          >
            No memory info
          </div>
        </div>

        <!-- Right column: Quota -->
        <div class="d-flex flex-column ga-1">
          <!-- Quota section -->
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase px-2 pt-2">
            Quota
          </div>
          <div
            v-if="quotaItems.length > 0"
            class="px-2 pb-2"
          >
            <div
              v-if="quotaPlan"
              class="text-caption mb-2"
            >
              <span class="text-medium-emphasis">Plan: </span>
              <span class="font-weight-bold">{{ quotaPlan }}</span>
            </div>
            <div
              v-for="item in quotaItems"
              :key="item.label"
              class="mb-3"
            >
              <div class="d-flex justify-space-between text-caption mb-1">
                <span>{{ item.label }}</span>
                <span class="mono">{{ formatNumber(item.used) }} / {{ formatNumber(item.total) }}</span>
              </div>
              <v-progress-linear
                :model-value="item.total > 0 ? (item.used / item.total) * 100 : 0"
                :color="item.total > 0 && item.used / item.total > 0.9 ? 'error' : 'primary'"
                rounded
                height="6"
              />
            </div>
          </div>
          <div
            v-else
            class="text-caption text-disabled px-2 pb-2"
          >
            No quota data
          </div>
        </div>
      </div>

      <!-- Configuration — full width, grouped by category -->
      <v-divider />
      <div class="pa-4">
        <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase mb-3">
          Configuration
        </div>
        <div
          v-if="configGroups.length > 0"
          class="config-grid"
        >
          <div
            v-for="group in configGroups"
            :key="group.label"
            class="config-group"
          >
            <div class="config-group-label text-caption text-medium-emphasis mb-1">
              {{ group.label }}
            </div>
            <v-table
              density="compact"
              class="config-table"
            >
              <tbody>
                <tr
                  v-for="e in group.entries"
                  :key="e.key"
                >
                  <td class="config-key text-caption text-medium-emphasis">
                    {{ e.key }}
                  </td>
                  <td class="config-val text-caption mono">
                    <pre
                      v-if="e.isComplex"
                      class="config-pre"
                      >{{ e.value }}</pre
                    >
                    <span
                      v-else
                      :class="{
                        'text-success': e.value === 'true',
                        'text-disabled': e.value === 'false' || e.value === 'null' || e.value === 'off',
                        'text-warning': !isNaN(Number(e.value)) && Number(e.value) > 0,
                      }"
                      >{{ e.value }}</span
                    >
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </div>
        <div
          v-else
          class="text-caption text-disabled"
        >
          No config available
        </div>
      </div>

      <!-- Active Requests — shown below when present -->
      <div
        v-if="activeRequests.length > 0"
        class="px-4 pb-4"
      >
        <v-divider class="mb-3" />
        <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase mb-2">
          Active Requests ({{ activeRequests.length }})
        </div>
        <v-table
          density="compact"
          class="active-req-table"
        >
          <thead>
            <tr>
              <th
                class="text-caption"
                style="width: 32px"
              ></th>
              <th class="text-caption">Model</th>
              <th class="text-caption">State</th>
              <th class="text-caption">Strategy</th>
              <th class="text-caption text-right">Duration</th>
              <th class="text-caption text-right">Attempts</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="req in activeRequests"
              :key="req.id"
            >
              <td>
                <v-icon
                  :color="requestStateColor(req.state)"
                  size="x-small"
                  >mdi-circle</v-icon
                >
              </td>
              <td class="text-caption mono">{{ req.model ?? "?" }}</td>
              <td class="text-caption">{{ req.state }}</td>
              <td class="text-caption text-medium-emphasis">
                {{ req.currentStrategy ?? "-" }}
              </td>
              <td class="text-caption mono text-right">{{ Math.round(req.durationMs / 1000) }}s</td>
              <td class="text-caption mono text-right">
                {{ req.attemptCount ?? 1 }}
              </td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.status-bar {
  background: rgb(var(--v-theme-surface-variant));
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

.kv-label {
  min-width: 100px;
  display: inline-block;
}

.section-header {
  letter-spacing: 0.05em;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 16px;
}

.config-group {
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 8px;
}

.config-group-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 4px;
}

.config-table {
  background: transparent !important;
}

.config-key {
  width: 200px;
  white-space: nowrap;
  padding: 3px 8px !important;
}

.config-val {
  padding: 3px 8px !important;
}

.config-pre {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
}

.active-req-table {
  background: transparent !important;
}

@media (max-width: 960px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
