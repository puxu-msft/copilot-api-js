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
import { useMessageActions } from "@/composables/useMessageActions"
import { useRawModal } from "@/composables/useRawModal"
import { isTextBlock } from "@/utils/typeGuards"

import ContentRenderer from "./ContentRenderer.vue"

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
// Cross-tab actions (open rich diff modal / jump to inbound↔effective counterpart)
const { openDiff, jumpToCounterpart } = useMessageActions()

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

/**
 * View mode is driven entirely by the stage (globalViewMode): the Inbound stage
 * passes "original", the Effective stage passes "rewritten". No per-message
 * toggle — original vs effective are now separate tabs, and the inline diff was
 * replaced by the rich diff modal (opened via the "diff" action).
 */
const viewMode = computed(() => {
  if (props.globalViewMode && props.isRewritten && props.rewrittenMessage) return props.globalViewMode
  return "original"
})

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

/** Whether the content actually differs (rewritten flag may be set but content identical) */
const contentDiffers = computed(() => Boolean(props.isRewritten && props.rewrittenMessage && originalText.value !== rewrittenText.value))

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

/** Open the rich diff modal (original = inbound message, effective = rewritten). */
function onDiff(event: Event) {
  event.stopPropagation()
  if (props.rewrittenMessage) openDiff(props.message, props.rewrittenMessage, `${props.message.role} #${props.index + 1}`)
}

/** Jump to this message's counterpart in the other request tab (inbound ↔ effective). */
function onJump(event: Event) {
  event.stopPropagation()
  jumpToCounterpart(props.index)
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
        <!-- Rewritten message: jump to counterpart tab + open rich diff modal. -->
        <template v-if="contentDiffers">
          <button
            class="action-btn"
            :title="globalViewMode === 'rewritten' ? 'Jump to inbound' : 'Jump to effective'"
            @click="onJump($event)"
          >
            ↔ {{ globalViewMode === "rewritten" ? "inbound" : "effective" }}
          </button>
          <button
            class="action-btn"
            title="Open diff (original vs effective)"
            @click="onDiff($event)"
          >
            <IconSvg
              name="code"
              :size="10"
            />
            diff
          </button>
        </template>

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
      <ContentRenderer
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
</style>
