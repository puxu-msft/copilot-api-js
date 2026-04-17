<script setup lang="ts">
import { ref, computed } from "vue"

import type { SystemBlock } from "@/types"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import IconSvg from "@/components/ui/IconSvg.vue"
import LineNumberPre from "@/components/ui/LineNumberPre.vue"
import { useCopyToClipboard } from "@/composables/useCopyToClipboard"
import { escapeHtml, highlightSearch } from "@/utils/formatters"
import { useRawModal } from "@/composables/useRawModal"

import SideBySideView from "./SideBySideView.vue"

const props = defineProps<{
  system: string | Array<SystemBlock>
  rewrittenSystem?: string | Array<SystemBlock> | null
  searchQuery?: string
  /** Global view mode from toolbar — null means per-message control */
  globalViewMode?: "original" | "rewritten" | "diff" | null
}>()

const { copy } = useCopyToClipboard()
const { openRawModal } = useRawModal()

const collapsed = ref(false)

// Rewrite view mode: local override or global
const localViewMode = ref<"original" | "rewritten" | "diff" | null>(null)

/** Effective view mode: local override takes priority, then global, then default */
const viewMode = computed(() => {
  if (localViewMode.value) return localViewMode.value
  if (props.globalViewMode && hasRewrite.value) return props.globalViewMode
  return "original"
})

const hasLocalOverride = computed(() => localViewMode.value !== null)

function setLocalViewMode(mode: "original" | "rewritten" | "diff") {
  localViewMode.value = mode
}

function resetLocalViewMode() {
  localViewMode.value = null
}

function systemToText(system: string | Array<SystemBlock>): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) return system.map((b) => b.text).join("\n")
  return ""
}

const originalText = computed(() => systemToText(props.system))
const rewrittenText = computed(() => (props.rewrittenSystem ? systemToText(props.rewrittenSystem) : ""))
const hasRewrite = computed(() => Boolean(props.rewrittenSystem))

/** Whether content actually differs (text level) */
const contentDiffers = computed(() => hasRewrite.value && originalText.value !== rewrittenText.value)

/** Show toggle whenever rewritten data exists */
const showViewToggle = computed(() => hasRewrite.value)

const displayText = computed(() => {
  if (viewMode.value === "rewritten" && hasRewrite.value) return rewrittenText.value
  return originalText.value
})

const displayHtml = computed(() => {
  if (props.searchQuery) return highlightSearch(displayText.value, props.searchQuery)
  return escapeHtml(displayText.value)
})

const summary = computed(() => {
  const t = originalText.value
  return t.length > 80 ? t.slice(0, 80) + "..." : t
})

const systemBlocks = computed<Array<SystemBlock>>(() => {
  if (typeof props.system === "string") return [{ type: "text", text: props.system }]
  return props.system
})

const rewrittenBlocks = computed<Array<SystemBlock>>(() => {
  if (!props.rewrittenSystem) return []
  if (typeof props.rewrittenSystem === "string") return [{ type: "text", text: props.rewrittenSystem }]
  return props.rewrittenSystem
})

/** Blocks to render based on current view mode */
const displayBlocks = computed<Array<SystemBlock>>(() => {
  if (viewMode.value === "rewritten" && hasRewrite.value) return rewrittenBlocks.value
  return systemBlocks.value
})

const hasCacheControl = computed(() => {
  if (typeof props.system === "string") return false
  return props.system.some((b) => b.cache_control)
})

const rawData = computed(() => {
  return { system: props.system }
})

const rewrittenRawData = computed(() => {
  if (!props.rewrittenSystem) return null
  return { system: props.rewrittenSystem }
})
</script>

<template>
  <div
    class="system-message"
    :class="{ collapsed }"
  >
    <div
      class="system-header"
      data-clickable
      @click="collapsed = !collapsed"
    >
      <div class="system-header-left">
        <span class="collapse-icon">{{ collapsed ? "▸" : "▾" }}</span>
        <BaseBadge color="purple">system</BaseBadge>
        <BaseBadge
          v-if="hasCacheControl"
          color="warning"
          >cached</BaseBadge
        >
        <BaseBadge
          v-if="contentDiffers"
          color="warning"
          >modified</BaseBadge
        >
        <BaseBadge
          v-else-if="hasRewrite"
          color="default"
          >rewritten</BaseBadge
        >
        <span
          v-if="collapsed"
          class="collapsed-summary"
          :title="summary"
          >{{ summary }}</span
        >
      </div>

      <div class="system-header-right">
        <!-- Rewrite view toggle (only when content differs) -->
        <div
          v-if="showViewToggle && !collapsed"
          class="view-toggle"
          @click.stop
        >
          <button
            :class="{ active: viewMode === 'original' }"
            @click="setLocalViewMode('original')"
          >
            Original
          </button>
          <button
            :class="{ active: viewMode === 'rewritten' }"
            @click="setLocalViewMode('rewritten')"
          >
            Rewritten
          </button>
          <button
            :class="{ active: viewMode === 'diff' }"
            @click="setLocalViewMode('diff')"
          >
            Diff
          </button>
          <button
            v-if="hasLocalOverride"
            class="reset-btn"
            title="Reset to global view mode"
            @click="resetLocalViewMode()"
          >
            ×
          </button>
        </div>

        <button
          class="action-btn"
          title="Copy"
          @click.stop="copy(displayText)"
        >
          <IconSvg
            name="copy"
            :size="10"
          />
          Copy
        </button>
        <button
          class="action-btn"
          title="View raw JSON"
          @click.stop="openRawModal(rawData, 'Raw — system', rewrittenRawData)"
        >
          <IconSvg
            name="code"
            :size="10"
          />
          Raw
        </button>
      </div>
    </div>

    <div
      v-show="!collapsed"
      class="system-body"
    >
      <!-- Diff view: side-by-side comparison -->
      <template v-if="viewMode === 'diff' && hasRewrite">
        <div
          v-if="systemBlocks.length !== rewrittenBlocks.length"
          class="diff-structure-notice"
        >
          Block count changed: {{ systemBlocks.length }} → {{ rewrittenBlocks.length }}
        </div>
        <SideBySideView :identical="!contentDiffers">
          <template #original>
            <div
              v-for="(block, i) in systemBlocks"
              :key="i"
              class="system-block-item"
              :class="{ 'system-block-separated': systemBlocks.length > 1 }"
            >
              <div
                v-if="systemBlocks.length > 1 || block.cache_control"
                class="block-label"
              >
                <span v-if="systemBlocks.length > 1">text[{{ i }}]</span>
                <span
                  v-if="block.cache_control"
                  class="cache-label"
                >[cache: {{ block.cache_control.type }}]</span>
              </div>
              <LineNumberPre :html="searchQuery ? highlightSearch(block.text, searchQuery) : escapeHtml(block.text)" />
            </div>
          </template>
          <template #rewritten>
            <div
              v-for="(block, i) in rewrittenBlocks"
              :key="i"
              class="system-block-item"
              :class="{ 'system-block-separated': rewrittenBlocks.length > 1 }"
            >
              <div
                v-if="rewrittenBlocks.length > 1 || block.cache_control"
                class="block-label"
              >
                <span v-if="rewrittenBlocks.length > 1">text[{{ i }}]</span>
                <span
                  v-if="block.cache_control"
                  class="cache-label"
                >[cache: {{ block.cache_control.type }}]</span>
              </div>
              <LineNumberPre :html="searchQuery ? highlightSearch(block.text, searchQuery) : escapeHtml(block.text)" />
            </div>
          </template>
        </SideBySideView>
      </template>
      <!-- Per-block rendering for arrays (original or rewritten mode) -->
      <template v-else-if="displayBlocks.length > 1">
        <div
          v-for="(block, i) in displayBlocks"
          :key="i"
          class="system-block-item system-block-separated"
        >
          <div class="block-label">
            <span>text[{{ i }}]</span>
            <span
              v-if="block.cache_control"
              class="cache-label"
            >[cache: {{ block.cache_control.type }}]</span>
          </div>
          <LineNumberPre :html="searchQuery ? highlightSearch(block.text, searchQuery) : escapeHtml(block.text)" />
        </div>
      </template>
      <!-- Single block or string — render as one -->
      <template v-else>
        <div
          v-if="displayBlocks.length === 1 && displayBlocks[0].cache_control"
          class="block-label"
        >
          <span class="cache-label">[cache: {{ displayBlocks[0].cache_control.type }}]</span>
        </div>
        <LineNumberPre :html="displayHtml" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.system-message {
  border: 1px solid var(--purple-muted);
  overflow: hidden;
  margin-bottom: var(--spacing-sm);
}

.system-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--purple-muted);
  cursor: pointer;
}

.system-header:hover {
  background: var(--purple-muted);
}

.system-header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
  overflow: hidden;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-dim);
  width: 10px;
  flex-shrink: 0;
}

.collapsed-summary {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.system-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.view-toggle {
  display: flex;
  gap: 1px;
  background: var(--bg);
  overflow: hidden;
}

.view-toggle button {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.view-toggle button:hover {
  color: var(--text);
}

.view-toggle button.active {
  color: var(--primary);
  background: var(--primary-muted);
}

.reset-btn {
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  color: var(--text-dim);
  background: var(--bg-secondary);
  line-height: 1;
}

.reset-btn:hover {
  color: var(--error);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 2px 6px;
  background: transparent;
}

.action-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.system-body {
  padding: var(--spacing-sm);
}

.system-block-item {
  margin-bottom: var(--spacing-sm);
}

.system-block-item:last-child {
  margin-bottom: 0;
}

.system-block-separated {
  border: 1px solid var(--border);
  padding: var(--spacing-xs);
}

.block-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  margin-bottom: 2px;
  font-family: var(--font-mono, "IBM Plex Mono", monospace);
}

.cache-label {
  font-size: var(--font-size-xs);
  color: var(--warning);
  font-style: italic;
}

.diff-structure-notice {
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--warning);
  background: var(--warning-muted);
  border-bottom: 1px solid var(--warning);
  margin-bottom: var(--spacing-xs);
}
</style>
