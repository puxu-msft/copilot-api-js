<script setup lang="ts">
import {
  //
  ref,
  computed,
  onMounted,
  onUnmounted,
} from "vue"

import type { MessageContent } from "@/types"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import IconSvg from "@/components/ui/IconSvg.vue"
import { extractText } from "@/composables/useHistoryStore"
import { useRawModal } from "@/composables/useRawModal"
import { isTextBlock } from "@/utils/typeGuards"

import ContentRenderer from "./ContentRenderer.vue"
import SideBySideView from "./SideBySideView.vue"

const props = withDefaults(
  defineProps<{
    message: MessageContent
    index: number
    isTruncated?: boolean
    isRewritten?: boolean
    rewrittenMessage?: MessageContent | null
    /** Global view mode from toolbar — null means per-message control */
    globalViewMode?: "original" | "rewritten" | "diff" | null
    /** Start collapsed to defer content rendering */
    defaultCollapsed?: boolean
  }>(),
  {
    isTruncated: false,
    isRewritten: false,
  },
)

// Collapse/expand
const collapsed = ref(props.defaultCollapsed ?? false)
const msgRef = ref<HTMLElement>()

// Shared modal
const { openRawModal } = useRawModal()

/** Auto-expand when navigated from TOC sidebar */
function handleTocNavigate() {
  if (collapsed.value) collapsed.value = false
}

onMounted(() => {
  msgRef.value?.addEventListener("toc-navigate", handleTocNavigate)
})

onUnmounted(() => {
  msgRef.value?.removeEventListener("toc-navigate", handleTocNavigate)
})

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

/** Content blocks for structural comparison */
const originalBlocks = computed(() => {
  const c = props.message.content
  if (typeof c === "string") return [{ type: "text" }]
  if (Array.isArray(c)) return c.map((b) => ({ type: b.type }))
  return []
})

const rewrittenBlocks = computed(() => {
  const c = props.rewrittenMessage?.content
  if (!c) return []
  if (typeof c === "string") return [{ type: "text" }]
  if (Array.isArray(c)) return c.map((b) => ({ type: b.type }))
  return []
})

/** Whether the content actually differs (rewritten flag may be set but content identical) */
const contentDiffers = computed(() => props.isRewritten && props.rewrittenMessage && originalText.value !== rewrittenText.value)

/** Show toggle whenever rewritten data exists */
const showViewToggle = computed(() => props.isRewritten && Boolean(props.rewrittenMessage))

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

function openRaw(event: Event) {
  event.stopPropagation()
  openRawModal(props.message, `Raw — ${props.message.role} #${props.index + 1}`, props.isRewritten ? props.rewrittenMessage : undefined)
}
</script>

<template>
  <div
    ref="msgRef"
    class="message-block"
    :class="{
      truncated: isTruncated,
      collapsed,
      'is-rewritten': isRewritten,
    }"
    :id="index >= 0 ? `request.messages.${index}` : 'response.content'"
    :data-msg-index="index"
  >
    <div
      class="msg-header"
      data-clickable
      @click="collapsed = !collapsed"
    >
      <div class="msg-header-left">
        <span class="collapse-icon">{{ collapsed ? "▸" : "▾" }}</span>
        <BaseBadge :color="roleBadgeColor">{{ message.role }}</BaseBadge>
        <span class="msg-index">#{{ index + 1 }}</span>

        <BaseBadge
          v-if="contentDiffers"
          color="warning"
          >modified</BaseBadge
        >
        <BaseBadge
          v-else-if="isRewritten"
          color="default"
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
        <!-- Rewrite view toggle (only when content actually differs) -->
        <div
          v-if="showViewToggle"
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
      </div>
    </div>

    <div
      v-show="!collapsed"
      class="msg-body"
    >
      <!-- Diff view: side-by-side comparison -->
      <template v-if="viewMode === 'diff' && isRewritten && rewrittenMessage">
        <div
          v-if="originalBlocks.length !== rewrittenBlocks.length"
          class="diff-structure-notice"
        >
          Block count changed: {{ originalBlocks.length }} → {{ rewrittenBlocks.length }}
        </div>
        <SideBySideView :identical="!contentDiffers">
          <template #original>
            <ContentRenderer
              :content="message.content ?? ''"
              :message="message"
            />
          </template>
          <template #rewritten>
            <ContentRenderer
              :content="rewrittenMessage.content ?? ''"
              :message="rewrittenMessage"
            />
          </template>
        </SideBySideView>
      </template>

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
