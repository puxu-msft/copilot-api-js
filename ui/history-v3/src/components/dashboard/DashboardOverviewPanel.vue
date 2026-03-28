<script setup lang="ts">
import type { QuotaItem } from "@/composables/useDashboardStatus"

defineProps<{
  auth: Record<string, unknown> | null
  copilotExpiresAt: string | null
  memory: Record<string, unknown> | null
  quotaItems: Array<QuotaItem>
  quotaPlan: string | null
  rateLimiterMode: unknown
  rateLimiterQueue: unknown
  totalEvictedCount: number
  formatNumber: (value: unknown) => string
  rateLimiterColor: (mode: unknown) => string
}>()
</script>

<template>
  <div class="two-col pa-4">
    <div class="d-flex flex-column ga-1">
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
            <v-list-item-title class="text-caption mono">{{ copilotExpiresAt }}</v-list-item-title>
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
          <span class="mono">{{ memory.historyEntryCount }} / {{ memory.historyMaxEntries }} entries</span>
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

    <div class="d-flex flex-column ga-1">
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
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
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
</style>
