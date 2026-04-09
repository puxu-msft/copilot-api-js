<script setup lang="ts">
import { computed, ref } from "vue"

import JsonViewerSurface from "@/components/ui/JsonViewerSurface.vue"
import type { ModelData, PrimaryLimitMetric } from "@/composables/useModelsCatalog"
import { useCopyToClipboard } from "@/composables/useCopyToClipboard"
import { getEffectiveEndpoints } from "@/utils/model-endpoints"

interface HeaderChipEntry {
  key: string
  label: string
  value: string
  variant: "tonal" | "outlined"
  color?: string
}

interface MetadataEntry {
  label: string
  value: string
  tone: "default" | "technical" | "numeric"
}

const props = defineProps<{
  model: ModelData
  vendorColor: (vendor: string | undefined) => string
  getLimits: (model: ModelData) => Array<[string, string]>
  getPrimaryLimits: (model: ModelData) => Array<PrimaryLimitMetric>
  getThinkingBudget: (model: ModelData) => string | null
  getCapabilities: (model: ModelData) => Array<string>
  getVision: (model: ModelData) => Array<[string, string]> | null
}>()

const isJsonOpen = ref(false)
const { copy } = useCopyToClipboard()

const capabilityEntries = computed(() => props.getCapabilities(props.model))
const primaryLimitEntries = computed(() => props.getPrimaryLimits(props.model))
const limitEntries = computed(() => props.getLimits(props.model))
const thinkingBudget = computed(() => props.getThinkingBudget(props.model))
const visionEntries = computed(() => props.getVision(props.model))
const endpointEntries = computed(() => getEffectiveEndpoints(props.model))
const nonStreamLimit = computed(() => limitEntries.value.find(([label]) => label === "Non-stream Output")?.[1] ?? null)
const billingMultiplier = computed(() =>
  props.model.billing?.multiplier !== undefined ? `${props.model.billing.multiplier}x` : null,
)
const displayName = computed(() => {
  if (!props.model.name) return null
  const value = String(props.model.name)
  return value === String(props.model.id) ? null : value
})
const jsonText = computed(() => JSON.stringify(props.model, null, 2))

const headerChipEntries = computed<Array<HeaderChipEntry>>(() =>
  [
    props.model.vendor
      ? {
          key: "vendor",
          label: "Vendor",
          value: String(props.model.vendor),
          color: props.vendorColor(String(props.model.vendor)),
          variant: "tonal",
        }
      : null,
    props.model.capabilities?.type
      ? {
          key: "type",
          label: "Type",
          value: String(props.model.capabilities.type),
          variant: "outlined",
        }
      : null,
    props.model.billing?.is_premium
      ? {
          key: "premium",
          label: "Tier",
          value: "Premium",
          color: "warning",
          variant: "tonal",
        }
      : null,
    props.model.preview
      ? {
          key: "preview",
          label: "Stage",
          value: "Preview",
          color: "secondary",
          variant: "tonal",
        }
      : null,
  ].filter((entry): entry is HeaderChipEntry => entry !== null),
)

const metadataEntries = computed<Array<MetadataEntry>>(() =>
  [
    props.model.capabilities?.family
      ? { label: "Family", value: String(props.model.capabilities.family), tone: "default" as const }
      : null,
    props.model.model_picker_category
      ? { label: "Category", value: String(props.model.model_picker_category), tone: "default" as const }
      : null,
    thinkingBudget.value
      ? { label: "Thinking Budget", value: thinkingBudget.value, tone: "numeric" as const }
      : null,
    nonStreamLimit.value
      ? { label: "Non-stream Output", value: nonStreamLimit.value, tone: "numeric" as const }
      : null,
    props.model.capabilities?.tokenizer
      ? { label: "Tokenizer", value: String(props.model.capabilities.tokenizer), tone: "technical" as const }
      : null,
  ].filter((entry): entry is MetadataEntry => entry !== null),
)

const jsonTitle = computed(() => String(props.model.id))

function getMetricColor(key: PrimaryLimitMetric["key"]): string {
  if (key === "inputs") return "primary"
  if (key === "context") return "info"
  if (key === "prompt") return "primary"
  return "success"
}

function copyModelJson(): void {
  void copy(jsonText.value, "Model JSON copied")
}
</script>

<template>
  <v-sheet
    class="model-card"
    color="surface"
    border
  >
    <div class="card-header">
        <div class="header-top">
          <div class="header-copy">
          <div class="model-id">{{ model.id }}</div>
          <div
            v-if="displayName"
            class="display-name"
          >
            {{ displayName }}
          </div>
        </div>

        <div class="header-actions">
          <v-btn
            size="small"
            variant="outlined"
            class="json-button"
            @click="isJsonOpen = true"
          >
            JSON
          </v-btn>
          <v-tooltip
            v-if="billingMultiplier"
            location="top"
          >
            <template #activator="{ props: tooltipProps }">
              <div
                v-bind="tooltipProps"
                class="billing-note"
              >
                <span class="billing-note-value">
                  <span class="billing-note-number">{{ props.model.billing?.multiplier }}</span>
                  <span class="billing-note-suffix">x</span>
                </span>
              </div>
            </template>
            <div class="billing-tooltip-copy">Billing multiplier (x base rate)</div>
          </v-tooltip>
        </div>
      </div>

      <div
        v-if="headerChipEntries.length > 0"
        class="chip-cluster chip-cluster-header"
      >
        <v-chip
          v-for="entry in headerChipEntries"
          :key="entry.key"
          :color="entry.color"
          size="x-small"
          :variant="entry.variant"
          class="meta-chip"
          :class="{ 'meta-chip-accent': entry.variant === 'tonal' }"
        >
          <span class="meta-chip-label">{{ entry.label }}</span>
          <span class="meta-chip-value">{{ entry.value }}</span>
        </v-chip>
      </div>

      <div
        v-if="primaryLimitEntries.length > 0"
        class="primary-metrics"
      >
        <div
          v-for="entry in primaryLimitEntries"
          :key="entry.key"
          class="primary-metric"
        >
          <div class="primary-metric-head">
            <span class="primary-metric-label">{{ entry.label }}</span>
            <span class="primary-metric-value">{{ entry.value }}</span>
          </div>
          <v-progress-linear
            :model-value="entry.progress"
            :color="getMetricColor(entry.key)"
            bg-color="surface-variant"
            height="7"
            rounded
          />
        </div>
      </div>
    </div>

    <div class="card-body">
      <div
        v-if="capabilityEntries.length > 0"
        class="card-section"
      >
        <div class="section-title">Capabilities</div>
        <div class="chip-cluster">
          <template
            v-for="capability in capabilityEntries"
            :key="capability"
          >
            <v-tooltip
              v-if="capability === 'vision' && visionEntries"
              location="top"
              open-delay="80"
            >
              <template #activator="{ props: tooltipProps }">
                <v-chip
                  v-bind="tooltipProps"
                  color="primary"
                  size="small"
                  variant="tonal"
                  class="capability-chip"
                >
                  {{ capability.replaceAll("_", " ") }}
                </v-chip>
              </template>
              <div class="vision-tooltip">
                <div
                  v-for="[key, value] in visionEntries"
                  :key="key"
                  class="vision-tooltip-row"
                >
                  <span class="vision-tooltip-key">{{ key }}</span>
                  <span class="vision-tooltip-value font-mono">{{ value }}</span>
                </div>
              </div>
            </v-tooltip>
            <v-chip
              v-else
              color="primary"
              size="small"
              variant="tonal"
              class="capability-chip"
            >
              {{ capability.replaceAll("_", " ") }}
            </v-chip>
          </template>
        </div>
      </div>

      <div
        v-if="endpointEntries.length > 0"
        class="card-section"
      >
        <div class="section-title">Endpoints</div>
        <div class="chip-cluster">
          <v-chip
            v-for="endpoint in endpointEntries"
            :key="endpoint"
            variant="outlined"
            size="small"
            class="endpoint-chip"
          >
            {{ endpoint }}
          </v-chip>
        </div>
      </div>

      <div
        v-if="metadataEntries.length > 0"
        class="card-section"
      >
        <div class="section-title">Metadata</div>
        <div class="metadata-list">
          <div
            v-for="entry in metadataEntries"
            :key="entry.label"
            class="metadata-row"
          >
            <span class="metadata-label">{{ entry.label }}</span>
            <span
              class="metadata-value"
              :class="{
                'metadata-value-technical': entry.tone === 'technical',
                'metadata-value-numeric': entry.tone === 'numeric',
              }"
            >
              {{ entry.value }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </v-sheet>

  <v-dialog
    v-model="isJsonOpen"
    max-width="1100"
  >
    <v-card class="json-dialog">
      <div class="dialog-header">
        <div class="dialog-title-wrap">
          <div class="dialog-eyebrow">Model JSON</div>
          <div class="dialog-title">{{ jsonTitle }}</div>
        </div>

        <div class="dialog-actions">
          <v-btn
            size="small"
            variant="outlined"
            @click="copyModelJson"
          >
            Copy JSON
          </v-btn>

          <v-btn
            icon
            variant="text"
            aria-label="Close"
            @click="isJsonOpen = false"
          >
            <v-icon icon="mdi-close" />
          </v-btn>
        </div>
      </div>

      <div class="dialog-body">
        <JsonViewerSurface
          :data="model"
          fill-height
          :show-toolbar="false"
          class="dialog-json-panel"
        />
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.model-card {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.card-header {
  padding: 16px 16px 14px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header-copy {
  min-width: 0;
}

.header-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  flex-shrink: 0;
}

.model-id {
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  word-break: break-all;
  line-height: 1.25;
  color: rgb(var(--v-theme-on-surface));
}

.display-name {
  margin-top: 6px;
  font-size: 0.81rem;
  line-height: 1.3;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.json-button {
  flex-shrink: 0;
}

.billing-note {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  cursor: help;
  min-height: 24px;
}

.chip-cluster {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip-cluster-header {
  margin-top: 12px;
}

.billing-note-value {
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  line-height: 1;
  color: rgb(var(--v-theme-warning));
  font-variant-numeric: tabular-nums;
}

.billing-note-number {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.billing-note-suffix {
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  text-transform: uppercase;
  opacity: 0.9;
}

.meta-chip {
  gap: 8px;
  padding-inline: 10px;
  min-height: 24px;
}

.meta-chip-label {
  font-size: 0.73rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.72;
  line-height: 1.2;
  margin-right: 4px;
}

.meta-chip-value {
  font-size: 0.79rem;
  font-weight: 600;
  line-height: 1.2;
}

.meta-chip-accent .meta-chip-value {
  font-weight: 700;
}

.primary-metrics {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.primary-metric {
  display: grid;
  gap: 8px;
}

.primary-metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.primary-metric-label {
  font-size: 0.83rem;
  line-height: 1.2;
  color: rgb(var(--v-theme-secondary));
}

.primary-metric-value {
  font-size: 1rem;
  line-height: 1.2;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.card-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-title {
  display: block;
  font-size: 0.73rem;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.capability-chip {
  font-size: 0.83rem;
}

.endpoint-chip {
  font-size: 0.83rem;
}

.metadata-list {
  display: grid;
  gap: 8px;
}

.metadata-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.metadata-label {
  font-size: 0.76rem;
  line-height: 1.25;
  color: rgb(var(--v-theme-secondary));
  flex: 1 1 auto;
  min-width: 0;
}

.metadata-value {
  font-size: 0.8rem;
  line-height: 1.25;
  font-weight: 600;
  flex: 0 0 auto;
  text-align: right;
  color: rgb(var(--v-theme-on-surface));
}

.metadata-value-technical {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
  font-size: 0.78rem;
}

.metadata-value-numeric {
  font-variant-numeric: tabular-nums;
}

.vision-tooltip {
  display: grid;
  gap: 8px;
  min-width: 220px;
}

.vision-tooltip-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
}

.vision-tooltip-key {
  font-size: 0.76rem;
  line-height: 1.3;
  color: rgba(var(--v-theme-on-surface-variant), 0.82);
}

.vision-tooltip-value {
  font-size: 0.78rem;
  line-height: 1.3;
  color: rgb(var(--v-theme-on-surface));
  font-variant-numeric: tabular-nums;
}

.billing-tooltip-copy {
  font-size: 0.78rem;
  line-height: 1.3;
  color: rgb(var(--v-theme-on-surface));
}

.json-dialog {
  display: flex;
  flex-direction: column;
  min-height: min(720px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.dialog-title-wrap {
  min-width: 0;
}

.dialog-eyebrow {
  font-size: 0.72rem;
  line-height: 1.2;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
  margin-bottom: 4px;
}

.dialog-title {
  min-width: 0;
  font-size: 0.96rem;
  font-weight: 700;
  line-height: 1.2;
  word-break: break-all;
}

.dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 0;
  background: rgb(var(--v-theme-surface));
}

.dialog-json-panel {
  flex: 1;
  min-height: 0;
}

.dialog-json-panel:deep(.json-viewer-shell) {
  height: 100%;
  border: 0;
  border-radius: 0;
  background: rgb(var(--v-theme-surface));
}

.dialog-json-panel:deep(.json-viewer-frame) {
  max-height: none;
  border-top: 0;
}

@media (max-width: 640px) {
  .header-top,
  .primary-metric-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .header-actions {
    align-items: flex-start;
  }

  .dialog-header {
    padding-left: 14px;
    padding-right: 14px;
  }

  .dialog-body {
    padding: 0;
  }

  .dialog-actions {
    gap: 4px;
  }
}
</style>
