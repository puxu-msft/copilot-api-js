<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue"

import IconSvg from "@/components/ui/IconSvg.vue"
import { useRawModal } from "@/composables/useRawModal"

const props = withDefaults(
  defineProps<{
    title: string
    defaultCollapsed?: boolean
    badge?: string
    rawData?: unknown
    rewrittenRawData?: unknown
    rawTitle?: string
    /** Override the auto-generated anchor id (for path-based TOC navigation) */
    anchor?: string
  }>(),
  {
    rawTitle: "Raw",
  },
)

const { openRawModal } = useRawModal()
const collapsed = ref(props.defaultCollapsed ?? false)
const sectionSlug = computed(() =>
  props.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, ""),
)
const sectionRef = ref<HTMLElement>()

function toggle() {
  collapsed.value = !collapsed.value
}

/** Auto-expand when navigated from TOC sidebar */
function handleTocNavigate() {
  if (collapsed.value) collapsed.value = false
}

onMounted(() => {
  sectionRef.value?.addEventListener("toc-navigate", handleTocNavigate)
})

onUnmounted(() => {
  sectionRef.value?.removeEventListener("toc-navigate", handleTocNavigate)
})

function openRaw(e: Event) {
  e.stopPropagation()
  if (props.rawData !== undefined) {
    openRawModal(props.rawData, props.rawTitle, props.rewrittenRawData)
  }
}
</script>

<template>
  <div
    ref="sectionRef"
    class="section-block"
    :class="{ collapsed }"
    :id="anchor || `section-${sectionSlug}`"
    :data-testid="`section-block-${sectionSlug}`"
  >
    <div
      class="section-header"
      data-clickable
      @click="toggle"
    >
      <IconSvg
        :name="collapsed ? 'chevron-right' : 'chevron-down'"
        :size="12"
        class="section-chevron"
      />
      <span class="section-title">{{ title }}</span>
      <span
        v-if="badge"
        class="section-badge"
        >{{ badge }}</span
      >
      <button
        v-if="rawData !== undefined"
        class="section-raw-btn"
        title="View raw JSON"
        :data-testid="`section-raw-${sectionSlug}`"
        @click="openRaw"
      >
        <IconSvg
          name="code"
          :size="10"
        />
        Raw
      </button>
    </div>
    <div
      v-show="!collapsed"
      class="section-body"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.section-block {
  border: 1px solid var(--border-light);
  margin-bottom: var(--spacing-sm);
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-tertiary);
  cursor: pointer;
}

.section-header:hover {
  background: var(--bg-hover);
}

.section-chevron {
  color: var(--text-dim);
  flex-shrink: 0;
}

.section-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.section-badge {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.section-raw-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 2px 6px;
  background: transparent;
  margin-left: auto;
}

.section-raw-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.section-body {
  padding: var(--spacing-sm);
}
</style>
