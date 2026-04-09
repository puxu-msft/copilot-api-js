<script setup lang="ts">
import { computed, ref } from "vue"

import ModelsFilterBar from "@/components/models/ModelsFilterBar.vue"
import ModelsGrid from "@/components/models/ModelsGrid.vue"
import ModelsToolbar from "@/components/models/ModelsToolbar.vue"
import { useModelsCatalog } from "@/composables/useModelsCatalog"
import { useCopyToClipboard } from "@/composables/useCopyToClipboard"
import JsonViewerSurface from "@/components/ui/JsonViewerSurface.vue"

const {
  billingBounds,
  billingRange,
  endpointFilter,
  endpointOptions,
  featureFilter,
  featureOptions,
  filteredModels,
  getCapabilities,
  getLimits,
  getPrimaryLimits,
  getThinkingBudget,
  getVision,
  loading,
  rawApiResponse,
  searchQuery,
  typeFilter,
  typeOptions,
  vendorColor,
  vendorFilter,
  vendorOptions,
  models,
} = useModelsCatalog()
const isRawJsonOpen = ref(false)
const { copy } = useCopyToClipboard()

const activeFilterCount = computed(() => {
  let count = 0
  if (searchQuery.value.trim()) count += 1
  if (vendorFilter.value) count += 1
  if (endpointFilter.value) count += 1
  if (featureFilter.value) count += 1
  if (typeFilter.value) count += 1
  if (billingRange.value[0] > billingBounds.value.min || billingRange.value[1] < billingBounds.value.max) count += 1
  return count
})

function copyModelsJson(): void {
  void copy(JSON.stringify(rawApiResponse.value, null, 2), "Models JSON copied")
}
</script>

<template>
  <div class="models-page v-page-root">
    <div class="v-page-scroll">
      <section class="page-shell px-4 px-md-6 pt-4 pb-6">
        <ModelsToolbar
          :filtered-count="filteredModels.length"
          :total-count="models.length"
          :vendor-count="vendorOptions.length"
          :endpoint-count="endpointOptions.length"
          @open-raw-json="isRawJsonOpen = true"
        />

        <v-sheet
          class="filter-shell"
          color="surface"
          border
        >
          <ModelsFilterBar
            v-model:search-query="searchQuery"
            v-model:vendor-filter="vendorFilter"
            v-model:endpoint-filter="endpointFilter"
            v-model:feature-filter="featureFilter"
            v-model:type-filter="typeFilter"
            v-model:billing-range="billingRange"
            :vendor-options="vendorOptions"
            :endpoint-options="endpointOptions"
            :feature-options="featureOptions"
            :type-options="typeOptions"
            :billing-bounds="billingBounds"
            :active-filter-count="activeFilterCount"
          />
        </v-sheet>

        <section class="results-column">
          <div
            v-if="loading"
            class="state-shell"
          >
            <v-progress-circular
              indeterminate
              color="primary"
            />
          </div>

          <div
            v-else-if="filteredModels.length === 0"
            class="empty-shell"
          >
            <div class="empty-title">No models match the current filters.</div>
            <div class="text-caption text-medium-emphasis">
              Broaden the search or clear one of the vendor, endpoint, type, capability, or billing-rate filters.
            </div>
          </div>

          <ModelsGrid
            v-else
            :filtered-models="filteredModels"
            :vendor-color="vendorColor"
            :get-limits="getLimits"
            :get-primary-limits="getPrimaryLimits"
            :get-thinking-budget="getThinkingBudget"
            :get-capabilities="getCapabilities"
            :get-vision="getVision"
          />
        </section>
      </section>
    </div>

    <v-dialog
      v-model="isRawJsonOpen"
      max-width="1180"
    >
      <v-card class="models-json-dialog">
        <div class="models-json-header">
          <div class="models-json-title-wrap">
            <div class="models-json-eyebrow">Full Models Raw JSON</div>
            <div class="models-json-title">Models API response</div>
          </div>

          <div class="models-json-actions">
            <v-btn
              size="small"
              variant="outlined"
              @click="copyModelsJson"
            >
              Copy JSON
            </v-btn>

            <v-btn
              icon
              variant="text"
              aria-label="Close"
              @click="isRawJsonOpen = false"
            >
              <v-icon icon="mdi-close" />
            </v-btn>
          </div>
        </div>

        <div class="models-json-body">
          <JsonViewerSurface
            :data="rawApiResponse"
            fill-height
            :show-toolbar="false"
            class="models-json-panel"
          />
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.models-page {
  background: rgb(var(--v-theme-background));
}

.page-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.filter-shell {
  padding: 14px;
  background: rgb(var(--v-theme-surface));
  border-color: rgb(var(--v-theme-surface-variant));
}

.state-shell,
.empty-shell {
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.empty-title {
  font-size: 1.05rem;
  font-weight: 700;
  margin-bottom: 6px;
}

.models-json-dialog {
  display: flex;
  flex-direction: column;
  min-height: min(760px, calc(100vh - 40px));
  max-height: calc(100vh - 40px);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  overflow: hidden;
}

.models-json-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.models-json-title-wrap {
  min-width: 0;
}

.models-json-eyebrow {
  font-size: 0.72rem;
  line-height: 1.2;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
  margin-bottom: 4px;
}

.models-json-title {
  font-size: 0.96rem;
  line-height: 1.2;
  font-weight: 700;
}

.models-json-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.models-json-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 0;
}

.models-json-panel {
  flex: 1;
  min-height: 0;
}

.models-json-panel:deep(.json-viewer-shell) {
  height: 100%;
  border: 0;
  border-radius: 0;
  background: rgb(var(--v-theme-surface));
}

.models-json-panel:deep(.json-viewer-frame) {
  max-height: none;
}

@media (max-width: 700px) {
  .models-json-header {
    padding-left: 14px;
    padding-right: 14px;
  }

  .models-json-actions {
    gap: 4px;
  }
}
</style>
