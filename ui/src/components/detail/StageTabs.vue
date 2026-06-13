<script setup lang="ts">
import type { DetailStage } from "@/composables/useDetailStages"

defineProps<{ stages: Array<DetailStage> }>()
const active = defineModel<string>("active", { required: true })
</script>

<template>
  <v-tabs
    v-model="active"
    density="compact"
    color="primary"
    show-arrows
    class="stage-tabs"
  >
    <v-tab
      v-for="stage in stages"
      :key="stage.key"
      :value="stage.key"
      class="stage-tab"
    >
      <v-icon
        :icon="stage.icon"
        size="small"
        start
      />
      {{ stage.label }}
    </v-tab>
  </v-tabs>
</template>

<style scoped>
.stage-tabs {
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  margin-bottom: 12px;
}

.stage-tab {
  text-transform: none;
  letter-spacing: 0;
  font-size: 0.8rem;
  min-width: 0;
}
</style>
