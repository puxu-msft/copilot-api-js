<script setup lang="ts">
import ModelsFilterBar from "@/components/models/ModelsFilterBar.vue"
import ModelsGrid from "@/components/models/ModelsGrid.vue"
import ModelsRawView from "@/components/models/ModelsRawView.vue"
import ModelsToolbar from "@/components/models/ModelsToolbar.vue"
import { useModelsCatalog } from "@/composables/useModelsCatalog"

const {
  endpointFilter,
  endpointOptions,
  featureFilter,
  featureOptions,
  filteredModels,
  getCapabilities,
  getLimits,
  getThinkingBudget,
  getViewMode,
  getVision,
  loading,
  rawApiResponse,
  searchQuery,
  toggleViewMode,
  vendorColor,
  vendorFilter,
  vendorOptions,
  viewSwitch,
} = useModelsCatalog()
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <ModelsToolbar
      v-model:view-switch="viewSwitch"
      :filtered-count="filteredModels.length"
    />

    <ModelsFilterBar
      v-model:search-query="searchQuery"
      v-model:vendor-filter="vendorFilter"
      v-model:endpoint-filter="endpointFilter"
      v-model:feature-filter="featureFilter"
      :vendor-options="vendorOptions"
      :endpoint-options="endpointOptions"
      :feature-options="featureOptions"
    />

    <div
      v-if="loading"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else-if="filteredModels.length === 0"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <span class="text-medium-emphasis">No models found</span>
    </div>

    <ModelsRawView
      v-else-if="viewSwitch === 1"
      :raw-api-response="rawApiResponse"
    />

    <ModelsGrid
      v-else
      :filtered-models="filteredModels"
      :get-view-mode="getViewMode"
      :toggle-view-mode="toggleViewMode"
      :vendor-color="vendorColor"
      :get-limits="getLimits"
      :get-thinking-budget="getThinkingBudget"
      :get-capabilities="getCapabilities"
      :get-vision="getVision"
    />
  </div>
</template>
