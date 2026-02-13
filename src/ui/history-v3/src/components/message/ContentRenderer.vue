<script setup lang="ts">
import { computed } from 'vue'
import type { ContentBlock } from '@/types'
import {
  isTextBlock,
  isThinkingBlock,
  isRedactedThinkingBlock,
  isToolUseBlock,
  isToolResultBlock,
  isImageBlock,
} from '@/utils/typeGuards'
import { useContentContext } from '@/composables/useContentContext'
import TextBlock from './TextBlock.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ImageBlock from './ImageBlock.vue'
import ToolUseBlock from './ToolUseBlock.vue'
import ToolResultBlock from './ToolResultBlock.vue'
import GenericBlock from './GenericBlock.vue'

const props = defineProps<{
  content: string | ContentBlock[]
}>()

const { filterType, toolUseNameMap } = useContentContext()

const blocks = computed<ContentBlock[]>(() => {
  if (typeof props.content === 'string') {
    return [{ type: 'text', text: props.content }]
  }
  if (!Array.isArray(props.content)) return []
  return props.content
})

const filteredBlocks = computed(() => {
  let result = blocks.value

  // Type filter
  if (filterType.value) {
    result = result.filter(b => b.type === filterType.value)
  }

  return result
})
</script>

<template>
  <div class="content-renderer">
    <template v-for="(block, i) in filteredBlocks" :key="i">
      <TextBlock
        v-if="isTextBlock(block)"
        :text="block.text"
      />
      <ThinkingBlock
        v-else-if="isThinkingBlock(block)"
        :text="block.thinking"
      />
      <ThinkingBlock
        v-else-if="isRedactedThinkingBlock(block)"
        text=""
        :redacted="true"
      />
      <ImageBlock
        v-else-if="isImageBlock(block)"
        :media-type="block.source.media_type"
        :data="block.source.data"
      />
      <ToolUseBlock
        v-else-if="isToolUseBlock(block)"
        :block="block"
      />
      <ToolResultBlock
        v-else-if="isToolResultBlock(block)"
        :block="block"
        :tool-name="toolUseNameMap[block.tool_use_id]"
      />
      <GenericBlock
        v-else
        :block="block"
      />
    </template>
  </div>
</template>

<style scoped>
.content-renderer {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

</style>
