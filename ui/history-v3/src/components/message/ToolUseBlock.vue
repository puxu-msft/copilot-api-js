<script setup lang="ts">
import { computed } from 'vue'
import type { ToolUseContentBlock, ToolResultContentBlock } from '@/types'
import ContentBlockWrapper from './ContentBlockWrapper.vue'
import ToolResultBlock from './ToolResultBlock.vue'
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'
import { useContentContext } from '@/composables/useContentContext'

const props = defineProps<{
  block: ToolUseContentBlock
}>()

const { aggregateTools, toolResultMap, scrollToResult } = useContentContext()

const inputJson = computed(() => {
  try {
    return JSON.stringify(props.block.input, null, 2)
  } catch {
    return String(props.block.input)
  }
})

const isObjectInput = computed(() => {
  return props.block.input !== null && typeof props.block.input === 'object'
})

const resultBlock = computed(() => {
  if (!toolResultMap.value) return null
  return (toolResultMap.value[props.block.id] as ToolResultContentBlock) ?? null
})

const hasResult = computed(() => !!resultBlock.value)
</script>

<template>
  <ContentBlockWrapper
    label="TOOL USE"
    label-color="cyan"
    :summary="block.name"
    :block-id="'tool-use-' + block.id"
    :copy-text="inputJson"
    :raw-data="block"
    :raw-title="'Raw — tool_use: ' + block.name"
  >
    <template #header-extra>
      <span class="tool-name">{{ block.name }}</span>
      <span class="tool-id">{{ block.id }}</span>
    </template>

    <VueJsonPretty
      v-if="isObjectInput"
      :data="(block.input as any)"
      :deep="3"
      :show-icon="true"
      :show-line-number="true"
      :collapsed-on-click-brackets="true"
    />
    <pre v-else class="tool-input">{{ inputJson }}</pre>

    <!-- Result section: mount once if result exists, toggle visibility -->
    <template v-if="hasResult">
      <div v-show="aggregateTools" class="tool-aggregate-result">
        <ToolResultBlock :block="(resultBlock as ToolResultContentBlock)" :tool-name="block.name" :embedded="true" />
      </div>
      <div v-show="!aggregateTools" class="tool-jump">
        <a class="jump-link" @click.prevent="scrollToResult(block.id)">
          → Jump to result
        </a>
      </div>
    </template>
  </ContentBlockWrapper>
</template>

<style scoped>
.tool-name {
  font-size: var(--font-size-sm);
  color: var(--primary);
  font-weight: 600;
  font-family: var(--font-mono);
}

.tool-id {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.tool-input {
  font-size: var(--font-size-sm);
  color: var(--text);
}

.tool-aggregate-result {
  border-top: 1px solid var(--border);
  margin-top: var(--spacing-sm);
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
