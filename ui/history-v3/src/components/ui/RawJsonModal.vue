<script setup lang="ts">
import { computed } from "vue"
import VueJsonPretty from "vue-json-pretty"

import { useCopyToClipboard } from "@/composables/useCopyToClipboard"

import IconSvg from "./IconSvg.vue"
import "vue-json-pretty/lib/styles.css"

const props = defineProps<{
  visible: boolean
  title: string
  data: unknown
  rewrittenData?: unknown
}>()

const emit = defineEmits<{
  "update:visible": [value: boolean]
}>()

const { copy } = useCopyToClipboard()

const isVisible = computed({
  get: () => props.visible,
  set: (value: boolean) => emit("update:visible", value),
})

const hasSplit = computed(() => props.rewrittenData !== null && props.rewrittenData !== undefined)

const jsonText = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})

const rewrittenJsonText = computed(() => {
  if (!props.rewrittenData) return ""
  try {
    return JSON.stringify(props.rewrittenData, null, 2)
  } catch {
    return String(props.rewrittenData)
  }
})

function copyJson(): void {
  void copy(jsonText.value)
}

function copyRewrittenJson(): void {
  void copy(rewrittenJsonText.value)
}
</script>

<template>
  <v-dialog
    v-model="isVisible"
    width="min(96vw, 1400px)"
    scrollable
    :transition="false"
    :z-index="2510"
    :scrim="false"
    content-class="raw-json-dialog"
  >
    <v-card
      class="raw-json-card"
      color="surface"
      data-testid="raw-json-card"
    >
      <div class="raw-json-toolbar">
        <div class="raw-json-heading">
          <div class="raw-json-title">{{ title }}</div>
          <div class="raw-json-subtitle text-caption text-medium-emphasis">
            {{ hasSplit ? "JSON" : "Payload" }}
          </div>
        </div>

        <div class="raw-json-actions">
          <v-btn
            v-if="!hasSplit"
            variant="text"
            size="small"
            @click="copyJson"
          >
            <IconSvg
              name="copy"
              :size="12"
            />
            Copy
          </v-btn>
          <v-btn
            variant="outlined"
            size="small"
            prepend-icon="mdi-close"
            @click="isVisible = false"
          >
            Close
          </v-btn>
        </div>
      </div>

      <div class="raw-json-body">
        <div
          v-if="hasSplit"
          class="json-split"
        >
          <section class="json-pane">
            <div class="pane-header">
              <span class="pane-label">Original</span>
              <v-btn
                variant="text"
                size="small"
                @click="copyJson"
              >
                <IconSvg
                  name="copy"
                  :size="12"
                />
                Copy
              </v-btn>
            </div>
            <div class="json-viewer">
              <VueJsonPretty
                :data="data as any"
                :deep="5"
                :show-line-number="true"
                :show-icon="true"
                :show-length="true"
                :collapsed-on-click-brackets="true"
              />
            </div>
          </section>

          <div class="pane-divider" />

          <section class="json-pane">
            <div class="pane-header">
              <span class="pane-label pane-label-rewritten">Rewritten</span>
              <v-btn
                variant="text"
                size="small"
                @click="copyRewrittenJson"
              >
                <IconSvg
                  name="copy"
                  :size="12"
                />
                Copy
              </v-btn>
            </div>
            <div class="json-viewer">
              <VueJsonPretty
                :data="rewrittenData as any"
                :deep="5"
                :show-line-number="true"
                :show-icon="true"
                :show-length="true"
                :collapsed-on-click-brackets="true"
              />
            </div>
          </section>
        </div>

        <div
          v-else
          class="json-viewer json-viewer-single"
        >
          <VueJsonPretty
            :data="data as any"
            :deep="5"
            :show-line-number="true"
            :show-icon="true"
            :show-length="true"
            :collapsed-on-click-brackets="true"
          />
        </div>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
:deep(.raw-json-dialog) {
  width: min(96vw, 1400px);
  max-width: min(96vw, 1400px);
  max-height: calc(100vh - 32px);
}

.raw-json-card {
  min-height: min(820px, calc(100vh - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgb(var(--v-theme-surface-variant));
}

.raw-json-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.raw-json-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.raw-json-title {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.2;
}

.raw-json-subtitle {
  margin-top: 0;
  line-height: 1.2;
}

.raw-json-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.raw-json-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: rgb(var(--v-theme-surface));
}

.json-viewer,
.json-split,
.json-pane {
  min-height: 0;
}

.json-viewer {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.json-viewer-single {
  width: 100%;
}

.json-split {
  display: flex;
  flex: 1;
  width: 100%;
  overflow: hidden;
}

.json-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.json-pane .json-viewer {
  padding-top: 12px;
}

.pane-divider {
  width: 1px;
  background: rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
}

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
}

.pane-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-on-surface-variant));
}

.pane-label-rewritten {
  color: rgb(var(--v-theme-warning));
}

@media (max-width: 960px) {
  .raw-json-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .raw-json-actions {
    width: 100%;
  }

  .json-split {
    flex-direction: column;
  }

  .pane-divider {
    width: 100%;
    height: 1px;
  }
}
</style>
