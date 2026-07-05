<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"
import type { JoinedModelTelemetry } from "@/composables/model-telemetry-join"
import type { RequestTelemetryModelStats } from "@/composables/telemetry-parse"

import { computed } from "vue"

import { formatDuration, formatNumber } from "@/utils/formatters"

import DetailKeyValueList from "../DetailKeyValueList.vue"
import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities; telemetry: JoinedModelTelemetry | null }>()

const last7d = computed(() => props.telemetry?.last7d ?? null)
const sinceStart = computed(() => props.telemetry?.sinceStart ?? null)
const hasTraffic = computed(() => Boolean(last7d.value || sinceStart.value))

function statRows(stats: RequestTelemetryModelStats): Array<[string, string | null]> {
  return [
    ["Requests", formatNumber(stats.requestCount)],
    ["Success", formatNumber(stats.successCount)],
    ["Failure", formatNumber(stats.failureCount)],
    ["Avg duration", formatDuration(stats.averageDurationMs)],
    ["Input tokens", formatNumber(stats.usage.inputTokens)],
    ["Output tokens", formatNumber(stats.usage.outputTokens)],
    ["Total tokens", formatNumber(stats.usage.totalTokens)],
    ["Cache read tokens", formatNumber(stats.usage.cacheReadInputTokens)],
    ["Cache creation tokens", formatNumber(stats.usage.cacheCreationInputTokens)],
    ["Reasoning tokens", formatNumber(stats.usage.reasoningTokens)],
  ]
}

const last7dRows = computed(() => (last7d.value ? statRows(last7d.value) : []))
const sinceStartRows = computed(() => (sinceStart.value ? statRows(sinceStart.value) : []))
</script>

<template>
  <div>
    <div
      v-if="!hasTraffic"
      class="no-traffic text-medium-emphasis"
    >
      No traffic recorded for this model.
    </div>
    <template v-else>
      <DetailSection
        v-if="last7d"
        title="Last 7 days"
      >
        <DetailKeyValueList :rows="last7dRows" />
      </DetailSection>
      <DetailSection
        v-if="sinceStart"
        title="Since start"
      >
        <DetailKeyValueList :rows="sinceStartRows" />
      </DetailSection>
    </template>
    <div class="telemetry-note text-caption text-medium-emphasis">
      Failure counts are aggregated by upstream canonical name; pure-alias failed requests appear in the "Unmatched telemetry" section.
    </div>
  </div>
</template>

<style scoped>
.no-traffic {
  padding: 16px 0;
  font-size: 0.9rem;
}

.telemetry-note {
  margin-top: 10px;
  line-height: 1.4;
}
</style>
