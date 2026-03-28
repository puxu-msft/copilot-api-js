<script setup lang="ts">
import type { ModelData } from "@/composables/useModelsCatalog"

import ModelCard from "./ModelCard.vue"

defineProps<{
  filteredModels: Array<ModelData>
  getViewMode: (id: string) => "parsed" | "raw"
  toggleViewMode: (id: string) => void
  vendorColor: (vendor: string | undefined) => string
  getLimits: (model: ModelData) => Array<[string, string]>
  getThinkingBudget: (model: ModelData) => string | null
  getCapabilities: (model: ModelData) => Array<string>
  getVision: (model: ModelData) => Array<[string, string]> | null
}>()
</script>

<template>
  <div class="flex-grow-1 overflow-y-auto pa-4">
    <div class="models-grid">
      <ModelCard
        v-for="model in filteredModels"
        :key="model.id"
        :model="model"
        :get-view-mode="getViewMode"
        :toggle-view-mode="toggleViewMode"
        :vendor-color="vendorColor"
        :get-limits="getLimits"
        :get-thinking-budget="getThinkingBudget"
        :get-capabilities="getCapabilities"
        :get-vision="getVision"
      />
    </div>
  </div>
</template>

<style scoped>
.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 16px;
}

@media (max-width: 768px) {
  .models-grid {
    grid-template-columns: 1fr;
  }
}
</style>
