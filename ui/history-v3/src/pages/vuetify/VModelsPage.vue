<script setup lang="ts">
import { ref, computed, onMounted } from "vue"

import { api } from "@/api/http"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelData = Record<string, any>

const models = ref<Array<ModelData>>([])
const loading = ref(true)
const searchQuery = ref("")
const vendorFilter = ref<string | null>(null)
const endpointFilter = ref<string | null>(null)
const featureFilter = ref<string | null>(null)

/** Per-card view mode */
const viewModes = ref<Record<string, "parsed" | "raw">>({})
function getViewMode(id: string): "parsed" | "raw" {
  return viewModes.value[id] ?? "parsed"
}
function toggleViewMode(id: string): void {
  viewModes.value = {
    ...viewModes.value,
    [id]: getViewMode(id) === "parsed" ? "raw" : "parsed",
  }
}

/** Global raw API response */
const rawApiResponse = ref<unknown>(null)

/** Cards / Raw switch */
const viewSwitch = ref(0) // 0 = Cards, 1 = Raw

onMounted(async () => {
  try {
    const result = await api.fetchModels(true)
    rawApiResponse.value = result
    models.value = (result.data ?? []) as Array<ModelData>
  } catch {
    // Non-critical
  } finally {
    loading.value = false
  }
})

// --- Filter options (dynamic from data) ---

const vendorOptions = computed(() => [...new Set(models.value.map((m) => m.owned_by as string).filter(Boolean))].sort())

const endpointOptions = computed(() => {
  const set = new Set<string>()
  for (const m of models.value) for (const ep of (m.supported_endpoints as Array<string> | undefined) ?? []) set.add(ep)
  return [...set].sort()
})

const featureOptions = computed(() => {
  const set = new Set<string>()
  for (const m of models.value) {
    const supports = m.capabilities?.supports as Record<string, unknown> | undefined
    if (!supports) continue
    for (const [k, v] of Object.entries(supports)) if (v === true) set.add(k)
  }
  return [...set].sort().map((f) => ({ title: f.replaceAll("_", " "), value: f }))
})

const filteredModels = computed(() => {
  let result = models.value
  if (vendorFilter.value) result = result.filter((m) => m.owned_by === vendorFilter.value)
  if (endpointFilter.value)
    result = result.filter((m) =>
      ((m.supported_endpoints as Array<string> | undefined) ?? []).includes(endpointFilter.value!),
    )
  if (featureFilter.value)
    result = result.filter(
      (m) => (m.capabilities?.supports as Record<string, unknown> | undefined)?.[featureFilter.value!] === true,
    )
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(
      (m) =>
        (m.id as string).toLowerCase().includes(q) || (m.display_name as string | undefined)?.toLowerCase().includes(q),
    )
  }
  return result
})

// --- Helpers ---

function vendorColor(vendor: string | undefined): string {
  if (!vendor) return "secondary"
  const v = vendor.toLowerCase()
  if (v.includes("anthropic")) return "purple"
  if (v.includes("openai") || v.includes("azure")) return "info"
  if (v.includes("google")) return "success"
  return "pink"
}

function fmtNum(n: unknown): string {
  if (typeof n !== "number" || !n) return "-"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K"
  return String(n)
}

function getCapabilities(m: ModelData): Array<string> {
  const supports = m.capabilities?.supports as Record<string, unknown> | undefined
  if (!supports) return []
  return Object.entries(supports)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
}

function getLimits(m: ModelData): Array<[string, string]> {
  const limits = m.capabilities?.limits as Record<string, unknown> | undefined
  if (!limits) return []
  const result: Array<[string, string]> = []
  if (limits.max_context_window_tokens) result.push(["Context", fmtNum(limits.max_context_window_tokens)])
  if (limits.max_prompt_tokens) result.push(["Prompt", fmtNum(limits.max_prompt_tokens)])
  if (limits.max_output_tokens) result.push(["Output", fmtNum(limits.max_output_tokens)])
  if (limits.max_non_streaming_output_tokens)
    result.push(["Non-stream", fmtNum(limits.max_non_streaming_output_tokens)])
  return result
}

function getThinkingBudget(m: ModelData): string | null {
  const supports = m.capabilities?.supports as Record<string, unknown> | undefined
  if (!supports?.max_thinking_budget) return null
  return `${fmtNum(supports.min_thinking_budget)} - ${fmtNum(supports.max_thinking_budget)}`
}

function getVision(m: ModelData): Array<[string, string]> | null {
  const vision = m.capabilities?.limits?.vision as Record<string, unknown> | undefined
  if (!vision) return null
  const result: Array<[string, string]> = []
  if (vision.max_prompt_images) result.push(["Max images", String(vision.max_prompt_images)])
  if (vision.max_prompt_image_size) result.push(["Max size", fmtNum(vision.max_prompt_image_size)])
  if (vision.supported_media_types) result.push(["Formats", (vision.supported_media_types as Array<string>).join(", ")])
  return result.length > 0 ? result : null
}
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <!-- Toolbar -->
    <v-toolbar
      flat
      density="compact"
      color="surface"
    >
      <v-toolbar-title class="text-body-1 font-weight-bold">
        Models
        <span class="text-caption text-medium-emphasis ml-2">{{ filteredModels.length }}</span>
      </v-toolbar-title>
      <v-spacer />
      <v-btn-toggle
        v-model="viewSwitch"
        mandatory
        density="compact"
        variant="outlined"
        class="mr-2"
      >
        <v-btn
          :value="0"
          size="small"
          >Cards</v-btn
        >
        <v-btn
          :value="1"
          size="small"
          >Raw</v-btn
        >
      </v-btn-toggle>
    </v-toolbar>

    <!-- Filter bar -->
    <div class="filter-bar d-flex align-center flex-wrap ga-2 px-4 py-2">
      <v-text-field
        v-model="searchQuery"
        placeholder="Search models..."
        prepend-inner-icon="mdi-magnify"
        clearable
        style="max-width: 280px; min-width: 180px"
      />
      <v-select
        v-model="vendorFilter"
        :items="vendorOptions"
        placeholder="All vendors"
        clearable
        style="max-width: 180px; min-width: 140px"
      />
      <v-select
        v-model="endpointFilter"
        :items="endpointOptions"
        placeholder="All endpoints"
        clearable
        style="max-width: 220px; min-width: 160px"
      />
      <v-select
        v-model="featureFilter"
        :items="featureOptions"
        placeholder="All features"
        clearable
        style="max-width: 200px; min-width: 140px"
      />
    </div>

    <!-- Loading state -->
    <div
      v-if="loading"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="filteredModels.length === 0"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <span class="text-medium-emphasis">No models found</span>
    </div>

    <!-- Raw view: full API response JSON -->
    <div
      v-else-if="viewSwitch === 1"
      class="flex-grow-1 overflow-y-auto pa-4"
    >
      <pre
        class="text-caption mono"
        style="white-space: pre-wrap; word-break: break-all"
        >{{ JSON.stringify(rawApiResponse, null, 2) }}</pre
      >
    </div>

    <!-- Cards view -->
    <div
      v-else
      class="flex-grow-1 overflow-y-auto pa-4"
    >
      <div class="models-grid">
        <v-card
          v-for="model in filteredModels"
          :key="model.id"
          class="model-card"
        >
          <!-- Card header: vendor chip + ID + toggle -->
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
                <v-icon size="small">{{
                  getViewMode(model.id as string) === "parsed" ? "mdi-code-json" : "mdi-card-text"
                }}</v-icon>
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

          <!-- Per-card RAW mode -->
          <div
            v-if="getViewMode(model.id as string) === 'raw'"
            class="pa-3 pt-0"
            style="max-height: 400px; overflow-y: auto"
          >
            <pre
              class="text-caption mono"
              style="white-space: pre-wrap; word-break: break-all"
              >{{ JSON.stringify(model, null, 2) }}</pre
            >
          </div>

          <!-- Per-card PARSED mode -->
          <div
            v-else
            class="card-body pa-3 pt-0"
          >
            <!-- Token limits mini-table -->
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
                    v-for="[label, val] in getLimits(model)"
                    :key="label"
                  >
                    <td class="text-caption text-medium-emphasis limit-label">
                      {{ label }}
                    </td>
                    <td class="text-caption mono text-right limit-value">
                      {{ val }}
                    </td>
                  </tr>
                  <tr v-if="model.billing?.multiplier !== undefined">
                    <td class="text-caption text-medium-emphasis limit-label">Billing</td>
                    <td
                      class="text-caption mono text-right limit-value"
                      :class="{
                        'text-warning': (model.billing?.multiplier as number) > 1,
                      }"
                    >
                      {{ model.billing.multiplier }}x
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>

            <!-- Thinking budget -->
            <div
              v-if="getThinkingBudget(model)"
              class="d-flex justify-space-between text-caption mb-3"
            >
              <span class="text-medium-emphasis">Thinking budget</span>
              <span class="mono">{{ getThinkingBudget(model) }}</span>
            </div>

            <!-- Capabilities chips -->
            <div
              v-if="getCapabilities(model).length > 0"
              class="mb-3"
            >
              <div class="text-caption text-medium-emphasis mb-1">Capabilities</div>
              <div class="d-flex flex-wrap ga-1">
                <template
                  v-for="cap in getCapabilities(model)"
                  :key="cap"
                >
                  <v-chip
                    v-if="cap === 'vision' && getVision(model)"
                    color="primary"
                    size="x-small"
                    variant="tonal"
                  >
                    {{ cap.replaceAll("_", " ") }}
                    <v-tooltip
                      activator="parent"
                      location="top"
                    >
                      <div
                        v-for="[k, v] in getVision(model)!"
                        :key="k"
                        class="d-flex justify-space-between ga-4"
                      >
                        <span>{{ k }}</span>
                        <span class="mono">{{ v }}</span>
                      </div>
                    </v-tooltip>
                  </v-chip>
                  <v-chip
                    v-else
                    color="primary"
                    size="x-small"
                    variant="tonal"
                  >
                    {{ cap.replaceAll("_", " ") }}
                  </v-chip>
                </template>
              </div>
            </div>

            <!-- Supported endpoints -->
            <div
              v-if="(model.supported_endpoints as Array<string> | undefined)?.length"
              class="mb-3"
            >
              <div class="text-caption text-medium-emphasis mb-1">Endpoints</div>
              <div class="d-flex flex-wrap ga-1">
                <v-chip
                  v-for="ep in model.supported_endpoints as Array<string>"
                  :key="ep"
                  variant="outlined"
                  size="x-small"
                >
                  {{ ep }}
                </v-chip>
              </div>
            </div>

            <!-- Footer: category + version + family -->
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.filter-bar {
  background: rgb(var(--v-theme-surface-variant));
}

.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 16px;
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

@media (max-width: 768px) {
  .models-grid {
    grid-template-columns: 1fr;
  }
}
</style>
