<script setup lang="ts">
/** @deprecated Use VModelsPage.vue (`/v/models`) for ongoing UI work. */
import { ref, computed, onMounted } from "vue"

import { api } from "@/api/http"
import BaseBadge from "@/components/ui/BaseBadge.vue"
import BaseInput from "@/components/ui/BaseInput.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import RawJsonModal from "@/components/ui/RawJsonModal.vue"

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

/** Global raw modal */
const showGlobalRaw = ref(false)
const rawApiResponse = ref<unknown>(null)

/** Cards / Raw switch */
const viewSwitch = ref<"cards" | "raw">("cards")

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

// ─── Filter options (dynamic from data) ───

const vendorOptions = computed(() =>
  [...new Set(models.value.map((m) => m.owned_by as string).filter(Boolean))]
    .sort()
    .map((v) => ({ value: v, label: v })),
)

const endpointOptions = computed(() => {
  const set = new Set<string>()
  for (const m of models.value) for (const ep of (m.supported_endpoints as Array<string> | undefined) ?? []) set.add(ep)
  return [...set].sort().map((ep) => ({ value: ep, label: ep }))
})

const featureOptions = computed(() => {
  const set = new Set<string>()
  for (const m of models.value) {
    const supports = m.capabilities?.supports as Record<string, unknown> | undefined
    if (!supports) continue
    for (const [k, v] of Object.entries(supports)) if (v === true) set.add(k)
  }
  return [...set].sort().map((f) => ({ value: f, label: f.replaceAll("_", " ") }))
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

// ─── Helpers ───

function vendorColor(vendor: string | undefined): "purple" | "cyan" | "success" | "pink" {
  if (!vendor) return "cyan"
  const v = vendor.toLowerCase()
  if (v.includes("anthropic")) return "purple"
  if (v.includes("openai") || v.includes("azure")) return "cyan"
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
  return `${fmtNum(supports.min_thinking_budget)} – ${fmtNum(supports.max_thinking_budget)}`
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
  <div class="models-page">
    <div class="models-header">
      <h2 class="models-title">Models</h2>
      <span class="models-count">{{ filteredModels.length }} models</span>
      <div class="view-switch">
        <button
          class="switch-option"
          :class="{ active: viewSwitch === 'cards' }"
          @click="viewSwitch = 'cards'"
        >
          Cards
        </button>
        <button
          class="switch-option"
          :class="{ active: viewSwitch === 'raw' }"
          @click="viewSwitch = 'raw'"
        >
          Raw
        </button>
      </div>
    </div>

    <div class="models-toolbar">
      <BaseInput
        v-model="searchQuery"
        placeholder="Search models..."
        icon="search"
      />
      <BaseSelect
        v-model="vendorFilter"
        :options="vendorOptions"
        placeholder="All vendors"
      />
      <BaseSelect
        v-model="endpointFilter"
        :options="endpointOptions"
        placeholder="All endpoints"
      />
      <BaseSelect
        v-model="featureFilter"
        :options="featureOptions"
        placeholder="All features"
      />
    </div>

    <div
      v-if="loading"
      class="models-empty"
    >
      Loading models...
    </div>
    <div
      v-else-if="filteredModels.length === 0"
      class="models-empty"
    >
      No models found
    </div>

    <!-- Global raw JSON modal -->
    <RawJsonModal
      v-model:visible="showGlobalRaw"
      title="Models API Response"
      :data="rawApiResponse"
    />

    <!-- Raw view: full JSON inline -->
    <div
      v-if="viewSwitch === 'raw' && !loading && filteredModels.length > 0"
      class="global-raw"
    >
      <pre>{{ JSON.stringify(rawApiResponse, null, 2) }}</pre>
    </div>

    <!-- Cards view -->
    <div
      v-else-if="viewSwitch === 'cards' && !loading && filteredModels.length > 0"
      class="models-grid"
    >
      <div
        v-for="model in filteredModels"
        :key="model.id"
        class="model-card"
      >
        <!-- Card top: ID + badges + per-card toggle -->
        <div class="card-top">
          <div class="card-header">
            <span class="model-id">{{ model.id }}</span>
            <div class="card-badges">
              <BaseBadge
                v-if="model.owned_by"
                :color="vendorColor(model.owned_by as string)"
              >
                {{ model.owned_by }}
              </BaseBadge>
              <BaseBadge
                v-if="model.billing?.is_premium"
                color="warning"
                >premium</BaseBadge
              >
              <BaseBadge v-if="model.preview">preview</BaseBadge>
            </div>
          </div>
          <button
            class="card-toggle"
            @click.stop="toggleViewMode(model.id as string)"
          >
            {{ getViewMode(model.id as string) === "parsed" ? "RAW" : "PARSED" }}
          </button>
        </div>

        <!-- Per-card RAW mode -->
        <div
          v-if="getViewMode(model.id as string) === 'raw'"
          class="card-raw"
        >
          <pre>{{ JSON.stringify(model, null, 2) }}</pre>
        </div>

        <!-- Per-card PARSED mode -->
        <template v-else>
          <!-- Display name + family + tokenizer -->
          <div
            v-if="model.display_name || model.capabilities?.family"
            class="card-meta"
          >
            <span
              v-if="model.display_name"
              class="meta-name"
              >{{ model.display_name }}</span
            >
            <span
              v-if="model.capabilities?.family"
              class="meta-dim"
              >{{ model.capabilities.family }}</span
            >
            <span
              v-if="model.capabilities?.tokenizer"
              class="meta-dim"
              >{{ model.capabilities.tokenizer }}</span
            >
          </div>

          <!-- Token limits -->
          <div
            v-if="getLimits(model).length > 0 || model.billing?.multiplier !== undefined"
            class="card-limits"
          >
            <div
              v-for="[label, val] in getLimits(model)"
              :key="label"
              class="limit-item"
            >
              <span class="limit-label">{{ label }}</span>
              <span class="limit-value">{{ val }}</span>
            </div>
            <div
              v-if="model.billing?.multiplier !== undefined"
              class="limit-item"
            >
              <span class="limit-label">Billing</span>
              <span
                class="limit-value"
                :class="{
                  'text-warning': (model.billing?.multiplier as number) > 1,
                }"
              >
                {{ model.billing.multiplier }}x
              </span>
            </div>
          </div>

          <!-- Thinking budget -->
          <div
            v-if="getThinkingBudget(model)"
            class="card-row"
          >
            <span class="row-label">Thinking budget</span>
            <span class="row-value">{{ getThinkingBudget(model) }}</span>
          </div>

          <!-- Capabilities as badges (vision has tooltip) -->
          <div
            v-if="getCapabilities(model).length > 0"
            class="card-tags"
          >
            <template
              v-for="cap in getCapabilities(model)"
              :key="cap"
            >
              <span
                v-if="cap === 'vision' && getVision(model)"
                class="cap-with-tooltip"
              >
                <BaseBadge color="primary">{{ cap.replaceAll("_", " ") }}</BaseBadge>
                <span class="cap-tooltip">
                  <span
                    v-for="[k, v] in getVision(model)!"
                    :key="k"
                    class="tooltip-row"
                  >
                    <span class="tooltip-key">{{ k }}</span>
                    <span class="tooltip-val">{{ v }}</span>
                  </span>
                </span>
              </span>
              <BaseBadge
                v-else
                color="primary"
                >{{ cap.replaceAll("_", " ") }}</BaseBadge
              >
            </template>
          </div>

          <!-- Supported endpoints -->
          <div
            v-if="(model.supported_endpoints as Array<string> | undefined)?.length"
            class="card-tags"
          >
            <BaseBadge
              v-for="ep in model.supported_endpoints as Array<string>"
              :key="ep"
              >{{ ep }}</BaseBadge
            >
          </div>

          <!-- Footer: category + version -->
          <div
            v-if="model.model_picker_category || model.version"
            class="card-footer"
          >
            <span
              v-if="model.model_picker_category"
              class="footer-dim"
              >{{ model.model_picker_category }}</span
            >
            <span
              v-if="model.version"
              class="footer-dim mono"
              >{{ model.version }}</span
            >
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.models-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
}

.models-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.models-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.models-count {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  margin-right: auto;
}

.view-switch {
  display: flex;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.switch-option {
  font-size: var(--font-size-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--bg-tertiary);
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.switch-option + .switch-option {
  border-left: 1px solid var(--border);
}
.switch-option.active {
  background: var(--primary-muted);
  color: var(--primary);
}

.models-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.models-toolbar > :first-child {
  flex: 1;
  min-width: 150px;
}

.models-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

/* Global raw */
.global-raw {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-lg);
}

.global-raw pre {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

/* Grid */
.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
}

/* Card */
.model-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-sm);
}

.card-header {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.model-id {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-mono);
  word-break: break-all;
}

.card-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.card-toggle {
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  padding: 2px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.card-toggle:hover {
  color: var(--primary);
  border-color: var(--primary);
}

/* Parsed sections */
.card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.meta-name {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.meta-dim {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.card-limits {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm) var(--spacing-xl);
}

.limit-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.limit-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
}
.limit-value {
  font-size: var(--font-size-md);
  color: var(--text);
  font-family: var(--font-mono);
  font-weight: 600;
}
.text-warning {
  color: var(--warning);
}

.card-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}
.row-label {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}
.row-value {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

/* Vision tooltip on hover */
.cap-with-tooltip {
  position: relative;
  cursor: default;
}

.cap-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  padding: var(--spacing-sm) var(--spacing-md);
  min-width: 220px;
  z-index: 10;
  box-shadow: var(--shadow-md);
  flex-direction: column;
  gap: var(--spacing-xs);
}

.cap-with-tooltip:hover .cap-tooltip {
  display: flex;
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing-md);
}
.tooltip-key {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  white-space: nowrap;
}
.tooltip-val {
  font-size: var(--font-size-sm);
  color: var(--text);
  font-family: var(--font-mono);
}

.card-footer {
  display: flex;
  gap: var(--spacing-sm);
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--border-light);
}

.footer-dim {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}
.footer-dim.mono {
  font-family: var(--font-mono);
}

/* Per-card raw */
.card-raw {
  max-height: 400px;
  overflow-y: auto;
}

.card-raw pre {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

@media (max-width: 768px) {
  .models-grid {
    grid-template-columns: 1fr;
  }
  .models-toolbar {
    flex-direction: column;
  }
}

/* Scale up component library elements within this page */
.models-toolbar :deep(.base-input input),
.models-toolbar :deep(.base-select) {
  font-size: var(--font-size-sm);
  padding: 5px 10px;
}

.model-card :deep(.base-badge) {
  font-size: var(--font-size-sm);
  padding: 2px 8px;
}
</style>
