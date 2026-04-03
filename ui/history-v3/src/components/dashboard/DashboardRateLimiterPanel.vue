<script setup lang="ts">
import { computed } from "vue"

import type { RateLimiterSnapshot } from "@/composables/useDashboardStatus"

const props = defineProps<{
  rateLimiter: RateLimiterSnapshot | null
  formatDate: (ts: number) => string
  formatNumber: (value: number | null | undefined) => string
  rateLimiterColor: (mode: unknown) => string
}>()

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

function formatSeconds(value: number | null): string {
  if (value === null) return "-"
  return `${value}s`
}

function formatMinutes(value: number | null): string {
  if (value === null) return "-"
  return `${value} min`
}

const limiterConfig = computed(() => props.rateLimiter?.config ?? null)
const retryBaseSeconds = computed(() => asNumber(limiterConfig.value?.baseRetryIntervalSeconds))
const retryMaxSeconds = computed(() => asNumber(limiterConfig.value?.maxRetryIntervalSeconds))
const requestIntervalSeconds = computed(() => asNumber(limiterConfig.value?.requestIntervalSeconds))
const recoveryTimeoutMinutes = computed(() => asNumber(limiterConfig.value?.recoveryTimeoutMinutes))
const recoverySuccessTarget = computed(() => asNumber(limiterConfig.value?.consecutiveSuccessesForRecovery))
const gradualRecoverySteps = computed(() => {
  const value = limiterConfig.value?.gradualRecoverySteps
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : []
})

const recoveryProgress = computed(() => {
  if (!props.rateLimiter?.enabled || !recoverySuccessTarget.value || recoverySuccessTarget.value <= 0) return 0
  return Math.min((props.rateLimiter.consecutiveSuccesses / recoverySuccessTarget.value) * 100, 100)
})

const lastLimitedAtLabel = computed(() => {
  if (!props.rateLimiter?.enabled || !props.rateLimiter.rateLimitedAt) return "No recent upstream 429 recorded"
  return props.formatDate(props.rateLimiter.rateLimitedAt)
})

const runtimeStatEntries = computed(() => {
  if (!props.rateLimiter?.enabled) return []

  return [
    {
      label: "Queue Depth",
      value: props.formatNumber(props.rateLimiter.queueLength),
      foot:
        props.rateLimiter.queueLength > 0 ?
          "Queued requests are waiting for their next release slot."
        : "No requests are waiting in the limiter queue.",
    },
    {
      label: "Recovery threshold",
      value:
        recoverySuccessTarget.value ?
          `${props.formatNumber(props.rateLimiter.consecutiveSuccesses)} / ${props.formatNumber(recoverySuccessTarget.value)}`
        : props.formatNumber(props.rateLimiter.consecutiveSuccesses),
      foot:
        recoverySuccessTarget.value ?
          `${props.formatNumber(recoverySuccessTarget.value)} clean responses are needed to exit recovery pressure.`
        : "No explicit recovery-success threshold is exposed.",
      progress: recoveryProgress.value,
      progressFoot:
        `Timeout fallback: ${formatMinutes(recoveryTimeoutMinutes.value)}. `
        + `Gradual release: ${gradualRecoverySteps.value.length > 0 ? gradualRecoverySteps.value.map((step) => `${step}s`).join(" -> ") : "-"}.`,
    },
    {
      label: "Last Rate Limit",
      value: lastLimitedAtLabel.value,
      foot:
        props.rateLimiter.rateLimitedAt ?
          "Timestamp of the most recent upstream rate-limit transition."
        : "This process has not recorded a recent rate-limit transition.",
    },
  ]
})

const configEntries = computed(() => {
  if (!props.rateLimiter?.enabled) return []

  return [
    { label: "Request Cadence", value: formatSeconds(requestIntervalSeconds.value) },
    {
      label: "Retry Backoff",
      value:
        retryBaseSeconds.value !== null || retryMaxSeconds.value !== null ?
          `${formatSeconds(retryBaseSeconds.value)} -> ${formatSeconds(retryMaxSeconds.value)}`
        : "-",
    },
    { label: "Recovery Timeout", value: formatMinutes(recoveryTimeoutMinutes.value) },
    {
      label: "Gradual Recovery",
      value: gradualRecoverySteps.value.length > 0 ? gradualRecoverySteps.value.map((step) => `${step}s`).join(" -> ") : "-",
    },
  ]
})
</script>

<template>
  <v-sheet
    class="panel panel-rate-limiter"
    color="surface"
    border
  >
    <div class="panel-head">
      <div>
        <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Flow Control</div>
        <div class="panel-title">Rate Limiter</div>
      </div>

      <v-chip
        :color="rateLimiter?.enabled ? rateLimiterColor(rateLimiter.mode) : 'secondary'"
        variant="tonal"
        size="small"
      >
        {{ rateLimiter?.enabled ? rateLimiter?.mode ?? "unknown" : "disabled" }}
      </v-chip>
    </div>

    <div
      v-if="rateLimiter?.enabled"
      class="limiter-layout"
    >
      <div class="runtime-column">
        <div class="runtime-metric-grid">
          <div
            v-for="entry in runtimeStatEntries"
            :key="entry.label"
            class="runtime-metric-card"
          >
            <div class="runtime-metric-label">{{ entry.label }}</div>
            <div class="runtime-metric-value">{{ entry.value }}</div>
            <v-progress-linear
              v-if="'progress' in entry"
              :model-value="entry.progress"
              :color="rateLimiterColor(rateLimiter.mode)"
              bg-color="surface-variant"
              height="10"
              rounded
              class="runtime-metric-progress"
            />
            <div class="runtime-metric-foot">{{ entry.foot }}</div>
            <div
              v-if="'progressFoot' in entry"
              class="progress-foot text-caption text-medium-emphasis"
            >
              {{ entry.progressFoot }}
            </div>
          </div>
        </div>
      </div>

      <div class="config-column">
        <div class="config-title">Limiter policy</div>
        <div class="config-copy text-caption text-medium-emphasis">
          This is the effective limiter configuration for the current process. Config changes only apply here after a restart.
        </div>

        <div class="config-stack">
          <div
            v-for="entry in configEntries"
            :key="entry.label"
            class="config-row"
          >
            <span class="config-label">{{ entry.label }}</span>
            <span class="config-value">{{ entry.value }}</span>
          </div>
        </div>
      </div>
    </div>

    <div
      v-else
      class="empty-panel text-body-2 text-medium-emphasis"
    >
      Adaptive rate limiting is not enabled at startup, so no queue, recovery, or policy telemetry is available here.
    </div>
  </v-sheet>
</template>

<style scoped>
.panel {
  padding: 18px;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.panel-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.panel-eyebrow {
  letter-spacing: 0.08em;
}

.panel-title {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.limiter-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.95fr);
  gap: 18px;
}

.runtime-column,
.config-column {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.runtime-metric-card,
.config-stack {
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.runtime-metric-card {
  padding: 14px;
}

.config-title {
  font-size: 0.82rem;
  line-height: 1.2;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.runtime-metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.runtime-metric-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 150px;
}

.runtime-metric-progress {
  margin-top: 2px;
}

.runtime-metric-label,
.config-label,
.progress-label {
  font-size: 0.74rem;
  line-height: 1.2;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.runtime-metric-value {
  font-size: 1.1rem;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

.runtime-metric-foot {
  margin-top: auto;
  font-size: 0.78rem;
  line-height: 1.45;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.progress-head,
.config-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.progress-value,
.config-value {
  font-size: 0.92rem;
  line-height: 1.2;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.progress-foot {
  line-height: 1.45;
}

.config-copy {
  margin-top: -4px;
}

.config-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.config-row {
  padding-bottom: 10px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.config-row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.empty-panel {
  padding-top: 4px;
}

@media (max-width: 1100px) {
  .limiter-layout {
    grid-template-columns: 1fr;
  }

  .runtime-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .runtime-metric-card {
    min-height: 0;
  }
}

@media (max-width: 760px) {
  .runtime-metric-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .progress-head,
  .config-row {
    flex-direction: column;
    align-items: start;
  }

  .progress-value,
  .config-value {
    text-align: left;
  }
}
</style>
