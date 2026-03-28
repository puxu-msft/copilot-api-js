<script setup lang="ts">
import type { ConfigGroup } from "@/composables/useDashboardStatus"

defineProps<{
  configGroups: Array<ConfigGroup>
}>()
</script>

<template>
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
              v-for="entry in group.entries"
              :key="entry.key"
            >
              <td class="config-key text-caption text-medium-emphasis">
                {{ entry.key }}
              </td>
              <td class="config-val text-caption mono">
                <pre
                  v-if="entry.isComplex"
                  class="config-pre"
                  >{{ entry.value }}</pre
                >
                <span
                  v-else
                  :class="{
                    'text-success': entry.value === 'true',
                    'text-disabled': entry.value === 'false' || entry.value === 'null' || entry.value === 'off',
                    'text-warning': !isNaN(Number(entry.value)) && Number(entry.value) > 0,
                  }"
                  >{{ entry.value }}</span
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
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
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
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 12px;
  overflow: hidden;
}

.config-table {
  background: transparent !important;
}

.config-key {
  width: 38%;
  white-space: nowrap;
  vertical-align: top;
}

.config-val {
  width: 62%;
  vertical-align: top;
}

.config-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: inherit;
  line-height: 1.35;
}
</style>
