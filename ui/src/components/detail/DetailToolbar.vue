<script setup lang="ts">
import { ref } from "vue"

import BaseButton from "@/components/ui/BaseButton.vue"
import BaseCheckbox from "@/components/ui/BaseCheckbox.vue"
import BaseInput from "@/components/ui/BaseInput.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import IconSvg from "@/components/ui/IconSvg.vue"
import { useDetailViewState } from "@/composables/useDetailViewState"

const detail = useDetailViewState()

const props = defineProps<{
  hasRewrites: boolean
  rewriteSummary: {
    msgCount: number
    sysRewritten: boolean
    truncated: boolean
    truncatedCount: number
  }
  rewrittenIndexList: Array<number>
}>()

defineEmits<{
  export: []
}>()

const roleOptions = [
  { value: "system", label: "System" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" },
  { value: "tool", label: "Tool" },
]

const typeOptions = [
  { value: "text", label: "Text" },
  { value: "tool_use", label: "Tool Use" },
  { value: "tool_result", label: "Tool Result" },
  { value: "thinking", label: "Thinking" },
  { value: "image", label: "Image" },
]

/** Current navigation index within the rewritten message list */
const navIndex = ref(-1)

function scrollToRewrittenMessage(index: number) {
  // Find the message block by data-msg-index attribute
  const el = document.querySelector(`[data-msg-index="${index}"]`)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.remove("highlight-flash")
    void (el as HTMLElement).offsetWidth
    el.classList.add("highlight-flash")
  }
}

function navigateRewritten(direction: "prev" | "next") {
  const list = props.rewrittenIndexList
  if (list.length === 0) return
  if (direction === "next") {
    navIndex.value = navIndex.value < list.length - 1 ? navIndex.value + 1 : 0
  } else {
    navIndex.value = navIndex.value > 0 ? navIndex.value - 1 : list.length - 1
  }
  scrollToRewrittenMessage(list[navIndex.value])
}
</script>

<template>
  <div class="detail-toolbar">
    <BaseInput
      :model-value="detail.detailSearch"
      placeholder="Search in messages..."
      icon="search"
      @update:model-value="detail.detailSearch = $event"
    />
    <div class="toolbar-row">
      <BaseSelect
        :model-value="detail.detailFilterRole || null"
        :options="roleOptions"
        placeholder="Role"
        @update:model-value="detail.detailFilterRole = $event ?? ''"
      />
      <BaseSelect
        :model-value="detail.detailFilterType || null"
        :options="typeOptions"
        placeholder="Type"
        @update:model-value="detail.detailFilterType = $event ?? ''"
      />
      <BaseCheckbox
        :model-value="detail.aggregateTools"
        label="Aggregate Tools"
        @update:model-value="detail.aggregateTools = $event"
      />
      <BaseButton
        variant="ghost"
        @click="$emit('export')"
      >
        <IconSvg
          name="download"
          :size="13"
        />
        Export
      </BaseButton>
    </div>

    <!-- Rewrite controls: only shown when there are rewrites -->
    <div
      v-if="hasRewrites"
      class="toolbar-row rewrite-row"
    >
      <div class="rewrite-stats">
        <span class="rewrite-label">Rewrites:</span>
        <span
          v-if="rewriteSummary.msgCount > 0"
          class="rewrite-stat"
        >
          {{ rewriteSummary.msgCount }} msg{{ rewriteSummary.msgCount > 1 ? "s" : "" }}
        </span>
        <span
          v-if="rewriteSummary.sysRewritten"
          class="rewrite-stat"
          >system</span
        >
        <span
          v-if="rewriteSummary.truncated"
          class="rewrite-stat rewrite-stat-truncated"
        >
          {{ rewriteSummary.truncatedCount }} truncated
        </span>
      </div>

      <div class="rewrite-controls">
        <!-- Show only rewritten filter -->
        <BaseCheckbox
          :model-value="detail.showOnlyRewritten"
          label="Only Rewritten"
          @update:model-value="detail.showOnlyRewritten = $event"
        />

        <!-- Navigation between rewritten messages -->
        <div
          v-if="rewriteSummary.msgCount > 0"
          class="rewrite-nav"
        >
          <button
            class="nav-btn"
            title="Previous rewritten message"
            @click="navigateRewritten('prev')"
          >
            <IconSvg
              name="chevron-up"
              :size="10"
            />
          </button>
          <span class="nav-label">{{ navIndex >= 0 ? navIndex + 1 : "–" }}/{{ rewrittenIndexList.length }}</span>
          <button
            class="nav-btn"
            title="Next rewritten message"
            @click="navigateRewritten('next')"
          >
            <IconSvg
              name="chevron-down"
              :size="10"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.rewrite-row {
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--border-light);
  justify-content: space-between;
}

.rewrite-stats {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.rewrite-label {
  font-size: var(--font-size-xs);
  color: var(--warning);
  font-weight: 600;
}

.rewrite-stat {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  padding: 1px 6px;
  background: var(--warning-muted);
  border-radius: 3px;
}

.rewrite-stat-truncated {
  background: var(--error-muted);
  color: var(--error);
}

.rewrite-controls {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.rewrite-nav {
  display: flex;
  align-items: center;
  gap: 2px;
}

.nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--text-dim);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-light);
}

.nav-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.nav-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
  min-width: 32px;
  text-align: center;
}
</style>
