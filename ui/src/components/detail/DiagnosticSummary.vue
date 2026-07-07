<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"

import {
  //
  resolveAttemptCount,
  resolveCurrentStrategy,
  resolveUpstreamResponse,
} from "@/composables/entry-legs"
import {
  //
  formatDuration,
  formatNumber,
} from "@/utils/formatters"
import { statusMeta } from "@/utils/status-meta"

const props = defineProps<{ entry: HistoryEntry }>()

// New legs ?? legacy top-level (P4c: drop the legacy arms in entry-legs).
const resp = computed(() => resolveUpstreamResponse(props.entry))
const usage = computed(() => resp.value?.usage)
const attempts = computed(() => resolveAttemptCount(props.entry))
const strategy = computed(() => resolveCurrentStrategy(props.entry))
// Terminal reason: surface aborted/interrupted/failed cause at a glance.
const reason = computed(() => {
  const e = props.entry
  if (e.state === "aborted") return "client disconnected"
  if (e.state === "interrupted") return e.process?.pid ? `process ${e.process.pid} died` : "process died"
  return resp.value?.error ?? resp.value?.stop_reason ?? undefined
})
</script>

<template>
  <div class="diag-band">
    <v-chip
      :color="statusMeta(entry.state).color"
      size="small"
      variant="flat"
      label
      class="diag-status"
      >{{ statusMeta(entry.state).label }}</v-chip
    >

    <div
      v-if="reason"
      class="diag-reason"
      :title="reason"
    >
      {{ reason }}
    </div>

    <v-spacer />

    <div class="diag-metrics">
      <div
        v-if="usage"
        class="diag-metric"
      >
        <span class="diag-label">tokens</span>
        <span class="diag-value font-mono"
          >{{ formatNumber(usage.input_tokens) }}<span class="diag-sep">/</span>{{ formatNumber(usage.output_tokens)
          }}<template v-if="usage.cache_read_input_tokens"
            ><span class="diag-sep">·</span><span class="diag-cache">{{ formatNumber(usage.cache_read_input_tokens) }}c</span></template
          ></span
        >
      </div>
      <div class="diag-metric">
        <span class="diag-label">dur</span>
        <span class="diag-value font-mono">{{ formatDuration(entry.durationMs) }}</span>
      </div>
      <div
        v-if="attempts && attempts > 1"
        class="diag-metric"
      >
        <span class="diag-label">attempts</span>
        <span class="diag-value font-mono"
          >{{ attempts }}<template v-if="strategy"> · {{ strategy }}</template></span
        >
      </div>
      <div
        v-if="entry.process?.pid"
        class="diag-metric"
      >
        <span class="diag-label">pid</span>
        <span class="diag-value font-mono">{{ entry.process.pid }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diag-band {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.diag-reason {
  font-size: 0.78rem;
  color: rgb(var(--v-theme-error));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.diag-metrics {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.diag-metric {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.diag-label {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(var(--v-theme-secondary));
}

.diag-value {
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}

.diag-sep {
  color: rgb(var(--v-theme-secondary));
  margin: 0 2px;
}

.diag-cache {
  color: rgb(var(--v-theme-success));
}
</style>
