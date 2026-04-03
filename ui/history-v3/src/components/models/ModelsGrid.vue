<script setup lang="ts">
import type { ModelData, PrimaryLimitMetric } from "@/composables/useModelsCatalog"

import ModelCard from "./ModelCard.vue"

defineProps<{
  filteredModels: Array<ModelData>
  vendorColor: (vendor: string | undefined) => string
  getLimits: (model: ModelData) => Array<[string, string]>
  getPrimaryLimits: (model: ModelData) => Array<PrimaryLimitMetric>
  getThinkingBudget: (model: ModelData) => string | null
  getCapabilities: (model: ModelData) => Array<string>
  getVision: (model: ModelData) => Array<[string, string]> | null
}>()
</script>

<template>
  <div class="models-grid">
      <ModelCard
        v-for="model in filteredModels"
        :key="model.id"
        :model="model"
        :vendor-color="vendorColor"
        :get-limits="getLimits"
        :get-primary-limits="getPrimaryLimits"
        :get-thinking-budget="getThinkingBudget"
        :get-capabilities="getCapabilities"
        :get-vision="getVision"
      />
  </div>
</template>

<style scoped>
.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

@media (max-width: 768px) {
  .models-grid {
    grid-template-columns: 1fr;
  }
}
</style>
