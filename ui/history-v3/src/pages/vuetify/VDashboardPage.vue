<script setup lang="ts">
import DashboardActiveRequestsTable from "@/components/dashboard/DashboardActiveRequestsTable.vue"
import DashboardOverviewPanel from "@/components/dashboard/DashboardOverviewPanel.vue"
import DashboardStatusBar from "@/components/dashboard/DashboardStatusBar.vue"
import { useDashboardStatus } from "@/composables/useDashboardStatus"

const {
  activeRequests,
  auth,
  copilotExpiresAt,
  formatNumber,
  memory,
  quotaItems,
  quotaPlan,
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
} = useDashboardStatus()
</script>

<template>
  <div class="d-flex flex-column fill-height">
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
      <DashboardStatusBar
        :status="status"
        :uptime="uptime"
        :resolved-active-count="resolvedActiveCount"
        :shutdown-phase="shutdownPhase"
        :ws-connected="wsConnected"
      />

      <v-divider />

      <DashboardOverviewPanel
        :auth="auth"
        :copilot-expires-at="copilotExpiresAt"
        :memory="memory"
        :quota-items="quotaItems"
        :quota-plan="quotaPlan"
        :rate-limiter-mode="rateLimiterMode"
        :rate-limiter-queue="rateLimiterQueue"
        :total-evicted-count="totalEvictedCount"
        :format-number="formatNumber"
        :rate-limiter-color="rateLimiterColor"
      />

      <v-divider />

      <DashboardActiveRequestsTable
        :active-requests="activeRequests"
        :request-state-color="requestStateColor"
      />
    </div>
  </div>
</template>
