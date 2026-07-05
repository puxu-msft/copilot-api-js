<script setup lang="ts">
import type { UnmatchedTelemetryRow } from "@/composables/model-telemetry-join"

defineProps<{ rows: Array<UnmatchedTelemetryRow> }>()
</script>

<template>
  <v-sheet
    v-if="rows.length > 0"
    class="unmatched-shell"
    color="surface"
    border
  >
    <div class="unmatched-head">
      <span class="unmatched-title">Unmatched telemetry</span>
      <span class="unmatched-note text-caption text-medium-emphasis">
        Traffic recorded under a model key that maps to no catalog id — usually pure-alias failed requests.
      </span>
    </div>
    <v-table
      density="compact"
      class="bg-transparent"
    >
      <thead>
        <tr>
          <th>Model key</th>
          <th class="num">Req 7d</th>
          <th class="num">Fail 7d</th>
          <th class="num">Req since start</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.normalizedKey"
        >
          <td class="font-mono">{{ r.model }}</td>
          <td class="num font-mono">{{ r.last7d?.requestCount ?? "-" }}</td>
          <td class="num font-mono">{{ r.last7d?.failureCount ?? "-" }}</td>
          <td class="num font-mono">{{ r.sinceStart?.requestCount ?? "-" }}</td>
        </tr>
      </tbody>
    </v-table>
  </v-sheet>
</template>

<style scoped>
.unmatched-shell {
  padding: 12px 14px;
  background: rgb(var(--v-theme-surface));
  border-color: rgb(var(--v-theme-surface-variant));
}

.unmatched-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.unmatched-title {
  font-size: 0.9rem;
  font-weight: 700;
}

.num {
  text-align: right;
}
</style>
