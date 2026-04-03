<script setup lang="ts">
import type { ActiveRequestInfo } from "@/api/ws"

defineProps<{
  activeRequests: Array<ActiveRequestInfo>
  requestStateColor: (state: string) => string
}>()
</script>

<template>
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
          <th class="text-caption col-status"></th>
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
          <td class="text-caption font-mono">{{ req.model ?? "?" }}</td>
          <td class="text-caption">{{ req.state }}</td>
          <td class="text-caption text-medium-emphasis">{{ req.currentStrategy ?? "-" }}</td>
          <td class="text-caption font-mono text-right">{{ Math.round(req.durationMs / 1000) }}s</td>
          <td class="text-caption font-mono text-right">{{ req.attemptCount ?? 1 }}</td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>

<style scoped>
.section-header {
  letter-spacing: 0.05em;
}

.col-status {
  width: 32px;
}
</style>
