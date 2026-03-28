<script setup lang="ts">
defineProps<{
  status: Record<string, unknown> | null | undefined
  uptime: string
  resolvedActiveCount: number
  shutdownPhase: string | null
  wsConnected: boolean
}>()
</script>

<template>
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
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.status-bar {
  background: rgb(var(--v-theme-surface-variant));
}
</style>
