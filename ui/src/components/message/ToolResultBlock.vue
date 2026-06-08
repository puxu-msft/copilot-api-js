<script setup lang="ts">
import { computed } from "vue"

import type { ToolResultContentBlock } from "@/types"

import LineNumberPre from "@/components/ui/LineNumberPre.vue"
import { useContentContext } from "@/composables/useContentContext"
import { useHighlightHtml } from "@/composables/useHighlightHtml"
import { escapeHtml } from "@/utils/formatters"

import ContentBlockWrapper from "./ContentBlockWrapper.vue"

const props = defineProps<{
  block: ToolResultContentBlock
  toolName?: string
  embedded?: boolean
}>()

const { searchQuery, aggregateTools, scrollToCall } = useContentContext()

const showStub = computed(() => aggregateTools.value && !props.embedded)

const isError = computed(() => props.block.is_error === true)

/** Whether content is a simple string (render as text) or an array (render per-block) */
const isStringContent = computed(() => typeof props.block.content === "string")

const stringContent = computed(() => (typeof props.block.content === "string" ? props.block.content : ""))

/** Array content blocks — render each by type, preserving original structure */
const arrayContent = computed(() => {
  if (!Array.isArray(props.block.content)) return []
  return props.block.content as Array<{ type: string; text?: string; [key: string]: unknown }>
})

const summary = computed(() => {
  return props.toolName || "for " + props.block.tool_use_id.slice(0, 8)
})

const copyText = computed(() => {
  if (typeof props.block.content === "string") return props.block.content
  if (Array.isArray(props.block.content)) {
    return props.block.content.map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : JSON.stringify(b))).join("\n")
  }
  return ""
})

const { displayHtml } = useHighlightHtml(stringContent, searchQuery)
</script>

<template>
  <!-- Aggregated standalone: compact stub with jump link -->
  <div
    v-show="showStub"
    class="aggregated-stub"
    :id="showStub ? 'tool-result-' + block.tool_use_id : undefined"
  >
    <span
      class="stub-label"
      :class="isError ? 'label-error' : 'label-success'"
      >TOOL RESULT</span
    >
    <span
      v-if="toolName"
      class="result-tool-name"
      >{{ toolName }}</span
    >
    <span class="result-tool-id">{{ block.tool_use_id }}</span>
    <span
      v-if="isError"
      class="result-error-badge"
      >ERROR</span
    >
    <a
      class="jump-link"
      @click.prevent="scrollToCall(block.tool_use_id)"
    >
      ← Jump to call
    </a>
  </div>

  <!-- Full view (standalone non-aggregate, or embedded in ToolUseBlock) -->
  <ContentBlockWrapper
    v-show="!showStub"
    label="TOOL RESULT"
    :label-color="isError ? 'error' : 'success'"
    :summary="summary"
    :block-id="'tool-result-' + block.tool_use_id"
    :copy-text="copyText"
    :raw-data="block"
    :raw-title="'Raw — tool_result' + (toolName ? ': ' + toolName : '')"
  >
    <template #header-extra>
      <span
        v-if="toolName"
        class="result-tool-name"
        >{{ toolName }}</span
      >
      <span class="result-tool-id">for {{ block.tool_use_id }}</span>
      <span
        v-if="isError"
        class="result-error-badge"
        >ERROR</span
      >
    </template>

    <!-- String content: single text block -->
    <LineNumberPre
      v-if="isStringContent"
      :html="displayHtml"
    />

    <!-- Array content: render each block by type, preserving structure -->
    <template v-else>
      <div
        v-for="(sub, i) in arrayContent"
        :key="i"
        class="result-sub-block"
      >
        <LineNumberPre
          v-if="sub.type === 'text' && typeof sub.text === 'string'"
          :html="escapeHtml(sub.text)"
        />
        <pre
          v-else
          class="result-raw-block"
          >{{ JSON.stringify(sub, null, 2) }}</pre
        >
      </div>
    </template>

    <!-- Jump to call (only in standalone non-aggregate mode) -->
    <div
      v-if="!embedded"
      class="tool-jump"
    >
      <a
        class="jump-link"
        @click.prevent="scrollToCall(block.tool_use_id)"
      >
        ← Jump to call
      </a>
    </div>
  </ContentBlockWrapper>
</template>

<style scoped>
.aggregated-stub {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  font-size: var(--font-size-xs);
}

.stub-label {
  font-weight: 600;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.label-success {
  color: var(--success);
}
.label-error {
  color: var(--error);
}

.result-tool-name {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.result-tool-id {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.result-error-badge {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--error);
}

.result-sub-block {
  border-bottom: 1px solid var(--border-light);
}

.result-sub-block:last-child {
  border-bottom: none;
}

.result-raw-block {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--text-muted);
}

.tool-jump {
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--border-light);
  margin-top: var(--spacing-sm);
  margin-left: calc(-1 * var(--spacing-sm));
  margin-right: calc(-1 * var(--spacing-sm));
  margin-bottom: calc(-1 * var(--spacing-sm));
  padding-left: var(--spacing-sm);
  padding-bottom: var(--spacing-xs);
}

.jump-link {
  font-size: var(--font-size-xs);
  color: var(--primary);
  cursor: pointer;
}

.jump-link:hover {
  text-decoration: underline;
}
</style>
