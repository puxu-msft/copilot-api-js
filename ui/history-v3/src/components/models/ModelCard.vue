<script setup lang="ts">
import type { ModelData } from "@/composables/useModelsCatalog"

defineProps<{
  model: ModelData
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
  <v-card class="model-card">
    <div class="card-header pa-3 pb-2">
      <div class="d-flex align-start ga-2">
        <v-chip
          v-if="model.owned_by"
          :color="vendorColor(model.owned_by as string)"
          size="small"
          variant="flat"
          class="flex-shrink-0"
        >
          {{ model.owned_by }}
        </v-chip>
        <v-chip
          v-if="model.billing?.is_premium"
          color="warning"
          size="x-small"
          variant="flat"
        >
          premium
        </v-chip>
        <v-chip
          v-if="model.preview"
          size="x-small"
          variant="tonal"
          >preview</v-chip
        >
        <v-spacer />
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="toggleViewMode(model.id as string)"
        >
          <v-icon size="small">{{ getViewMode(model.id as string) === "parsed" ? "mdi-code-json" : "mdi-card-text" }}</v-icon>
          <v-tooltip
            activator="parent"
            location="top"
          >
            {{ getViewMode(model.id as string) === "parsed" ? "Show raw JSON" : "Show parsed" }}
          </v-tooltip>
        </v-btn>
      </div>
      <div class="model-id mt-2">{{ model.id }}</div>
      <div
        v-if="model.display_name"
        class="text-caption text-medium-emphasis mt-1"
      >
        {{ model.display_name }}
      </div>
    </div>

    <div
      v-if="getViewMode(model.id as string) === 'raw'"
      class="pa-3 pt-0 raw-wrap"
    >
      <pre class="text-caption mono raw-pre">{{ JSON.stringify(model, null, 2) }}</pre>
    </div>

    <div
      v-else
      class="card-body pa-3 pt-0"
    >
      <div
        v-if="getLimits(model).length > 0 || model.billing?.multiplier !== undefined"
        class="limits-section mb-3"
      >
        <v-table
          density="compact"
          class="limits-table"
        >
          <tbody>
            <tr
              v-for="[label, value] in getLimits(model)"
              :key="label"
            >
              <td class="text-caption text-medium-emphasis limit-label">{{ label }}</td>
              <td class="text-caption mono text-right limit-value">{{ value }}</td>
            </tr>
            <tr v-if="model.billing?.multiplier !== undefined">
              <td class="text-caption text-medium-emphasis limit-label">Billing</td>
              <td
                class="text-caption mono text-right limit-value"
                :class="{ 'text-warning': (model.billing?.multiplier as number) > 1 }"
              >
                {{ model.billing.multiplier }}x
              </td>
            </tr>
          </tbody>
        </v-table>
      </div>

      <div
        v-if="getThinkingBudget(model)"
        class="d-flex justify-space-between text-caption mb-3"
      >
        <span class="text-medium-emphasis">Thinking budget</span>
        <span class="mono">{{ getThinkingBudget(model) }}</span>
      </div>

      <div
        v-if="getCapabilities(model).length > 0"
        class="mb-3"
      >
        <div class="text-caption text-medium-emphasis mb-1">Capabilities</div>
        <div class="d-flex flex-wrap ga-1">
          <template
            v-for="capability in getCapabilities(model)"
            :key="capability"
          >
            <v-chip
              v-if="capability === 'vision' && getVision(model)"
              color="primary"
              size="x-small"
              variant="tonal"
            >
              {{ capability.replaceAll("_", " ") }}
              <v-tooltip
                activator="parent"
                location="top"
              >
                <div
                  v-for="[key, value] in getVision(model)!"
                  :key="key"
                  class="d-flex justify-space-between ga-4"
                >
                  <span>{{ key }}</span>
                  <span class="mono">{{ value }}</span>
                </div>
              </v-tooltip>
            </v-chip>
            <v-chip
              v-else
              color="primary"
              size="x-small"
              variant="tonal"
            >
              {{ capability.replaceAll("_", " ") }}
            </v-chip>
          </template>
        </div>
      </div>

      <div
        v-if="(model.supported_endpoints as Array<string> | undefined)?.length"
        class="mb-3"
      >
        <div class="text-caption text-medium-emphasis mb-1">Endpoints</div>
        <div class="d-flex flex-wrap ga-1">
          <v-chip
            v-for="endpoint in model.supported_endpoints as Array<string>"
            :key="endpoint"
            variant="outlined"
            size="x-small"
          >
            {{ endpoint }}
          </v-chip>
        </div>
      </div>

      <v-divider
        v-if="model.model_picker_category || model.version || model.capabilities?.family"
        class="mb-2"
      />
      <div
        v-if="model.model_picker_category || model.version || model.capabilities?.family"
        class="d-flex flex-wrap ga-2 text-caption text-disabled"
      >
        <span v-if="model.capabilities?.family">{{ model.capabilities.family }}</span>
        <span v-if="model.model_picker_category">{{ model.model_picker_category }}</span>
        <span
          v-if="model.version"
          class="mono"
          >{{ model.version }}</span
        >
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.model-card {
  display: flex;
  flex-direction: column;
}

.model-id {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
  line-height: 1.3;
}

.raw-wrap {
  max-height: 400px;
  overflow-y: auto;
}

.raw-pre {
  white-space: pre-wrap;
  word-break: break-all;
}

.limits-table {
  background: transparent !important;
}

.limit-label {
  padding: 2px 8px 2px 0 !important;
  white-space: nowrap;
}

.limit-value {
  padding: 2px 0 2px 8px !important;
  white-space: nowrap;
  font-weight: 600;
}
</style>
