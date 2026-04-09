<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue"

import type { MessageContent } from "@/types"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import IconSvg from "@/components/ui/IconSvg.vue"
import { extractText } from "@/composables/useHistoryStore"
import { useRawModal } from "@/composables/useRawModal"
import { useSharedResizeObserver } from "@/composables/useSharedResizeObserver"
import { isTextBlock } from "@/utils/typeGuards"

import ContentRenderer from "./ContentRenderer.vue"
import DiffView from "./DiffView.vue"

const props = withDefaults(
  defineProps<{
    message: MessageContent
    index: number
    isTruncated?: boolean
    isRewritten?: boolean
    rewrittenMessage?: MessageContent | null
    /** Global view mode from toolbar — null means per-message control */
    globalViewMode?: "original" | "rewritten" | "diff" | null
  }>(),
  {
    isTruncated: false,
    isRewritten: false,
  },
)

// Collapse/expand
const collapsed = ref(false)
const expanded = ref(false)
const isOverflowing = ref(false)
const bodyRef = ref<HTMLElement>()

// Shared modal and observer
const { openRawModal } = useRawModal()
const sharedObserver = useSharedResizeObserver()

// Rewrite view mode: local override or global
const localViewMode = ref<"original" | "rewritten" | "diff" | null>(null)

/** Effective view mode: local override takes priority, then global, then default */
const viewMode = computed(() => {
  if (localViewMode.value) return localViewMode.value
  if (props.globalViewMode && props.isRewritten && props.rewrittenMessage) return props.globalViewMode
  return "original"
})

/** Whether the local mode differs from global (shows reset indicator) */
const hasLocalOverride = computed(() => localViewMode.value !== null)

function setLocalViewMode(mode: "original" | "rewritten" | "diff") {
  localViewMode.value = mode
}

function resetLocalViewMode() {
  localViewMode.value = null
}

const roleBadgeColor = computed(() => {
  switch (props.message.role) {
    case "user": {
      return "primary"
    }
    case "assistant": {
      return "success"
    }
    case "system": {
      return "purple"
    }
    case "tool": {
      return "cyan"
    }
    default: {
      return "default"
    }
  }
})

// Collapsed summary text
const messageSummary = computed(() => {
  const content = props.message.content
  if (typeof content === "string") {
    return content.length > 80 ? content.slice(0, 80) + "..." : content
  }
  if (!Array.isArray(content) || content.length === 0) return ""
  // If single text block, show its text
  const first = content[0]
  if (content.length === 1 && isTextBlock(first)) {
    const t = first.text
    return t.length > 80 ? t.slice(0, 80) + "..." : t
  }
  // Otherwise show type counts
  const counts: Record<string, number> = {}
  for (const b of content) {
    counts[b.type] = (counts[b.type] || 0) + 1
  }
  return Object.entries(counts)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ")
})

const originalText = computed(() => extractText(props.message.content))
const rewrittenText = computed(() => (props.rewrittenMessage ? extractText(props.rewrittenMessage.content) : ""))

const displayContent = computed(() => {
  if (viewMode.value === "rewritten" && props.rewrittenMessage) {
    return props.rewrittenMessage.content ?? ""
  }
  return props.message.content ?? ""
})

/** Full message for OpenAI tool_calls rendering */
const displayMessage = computed<MessageContent | undefined>(() => {
  if (viewMode.value === "rewritten" && props.rewrittenMessage) {
    return props.rewrittenMessage
  }
  return props.message
})

function checkOverflow() {
  if (bodyRef.value && !expanded.value) {
    isOverflowing.value = bodyRef.value.scrollHeight > bodyRef.value.clientHeight + 10
  }
}

function toggleExpand(event: Event) {
  event.stopPropagation()
  expanded.value = !expanded.value
  if (!expanded.value) {
    void nextTick(checkOverflow)
  }
}

function openRaw(event: Event) {
  event.stopPropagation()
  openRawModal(
    props.message,
    `Raw — ${props.message.role} #${props.index + 1}`,
    props.isRewritten ? props.rewrittenMessage : undefined,
  )
}

onMounted(() => {
  void nextTick(() => {
    checkOverflow()
    if (bodyRef.value) {
      sharedObserver.observe(bodyRef.value, checkOverflow)
    }
  })
})

onUnmounted(() => {
  if (bodyRef.value) sharedObserver.unobserve(bodyRef.value)
})

watch(
  () => props.message,
  () => {
    expanded.value = false
    void nextTick(checkOverflow)
  },
)
</script>

<template>
  <div
    class="message-block"
    :class="{
      truncated: isTruncated,
      collapsed,
      'is-rewritten': isRewritten,
    }"
    :data-msg-index="index"
  >
    <div
      class="msg-header"
      @click="collapsed = !collapsed"
    >
      <div class="msg-header-left">
        <span class="collapse-icon">{{ collapsed ? "▸" : "▾" }}</span>
        <BaseBadge :color="roleBadgeColor">{{ message.role }}</BaseBadge>
        <span class="msg-index">#{{ index + 1 }}</span>

        <BaseBadge
          v-if="isRewritten"
          color="warning"
          >rewritten</BaseBadge
        >
        <BaseBadge
          v-if="isTruncated"
          color="error"
          >truncated</BaseBadge
        >

        <span
          v-if="collapsed && messageSummary"
          class="collapsed-summary"
          :title="messageSummary"
          >{{ messageSummary }}</span
        >
      </div>

      <div class="msg-header-right">
        <!-- Rewrite view toggle -->
        <div
          v-if="isRewritten && rewrittenMessage"
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

        <!-- Raw button -->
        <button
          class="action-btn"
          title="View raw JSON"
          @click="openRaw($event)"
        >
          <IconSvg
            name="code"
            :size="10"
          />
          Raw
        </button>

        <!-- Expand/collapse -->
        <button
          v-if="isOverflowing && !collapsed"
          class="action-btn"
          @click="toggleExpand($event)"
          :title="expanded ? 'Collapse content' : 'Show full content'"
        >
          <IconSvg
            :name="expanded ? 'contract' : 'expand'"
            :size="10"
          />
          {{ expanded ? "Collapse" : "Expand" }}
        </button>
      </div>
    </div>

    <div
      v-show="!collapsed"
      ref="bodyRef"
      class="msg-body"
      :class="{ 'body-limited': isOverflowing && !expanded }"
    >
      <!-- Diff view -->
      <DiffView
        v-if="viewMode === 'diff' && isRewritten"
        :old-text="originalText"
        :new-text="rewrittenText"
      />

      <!-- Normal content -->
      <ContentRenderer
        v-else
        :content="displayContent"
        :message="displayMessage"
      />
    </div>
  </div>
</template>

<style scoped>
.message-block {
  border: 1px solid var(--border-light);
  overflow: hidden;
}

.message-block.truncated {
  border-color: var(--error);
  opacity: 0.7;
  text-decoration: line-through;
}

.msg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  cursor: pointer;
  user-select: none;
}

.msg-header:hover {
  background: var(--bg-hover);
}

.msg-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.msg-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-dim);
  width: 10px;
  flex-shrink: 0;
}

.msg-index {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.collapsed-summary {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

.message-block.is-rewritten {
  border-left: 2px solid var(--warning);
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

.msg-body {
  padding: var(--spacing-sm);
}

.msg-body.body-limited {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
</style>
