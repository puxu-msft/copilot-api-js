<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { NModal, NButton, NIcon } from 'naive-ui'
import { CopyOutline } from '@vicons/ionicons5'
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'

const props = defineProps<{
  visible: boolean
  title: string
  data: unknown
}>()

defineEmits<{
  'update:visible': [value: boolean]
}>()

const prefersDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
let mediaQuery: MediaQueryList | null = null

onMounted(() => {
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => { prefersDark.value = e.matches }
  mediaQuery.addEventListener('change', handler)
  onUnmounted(() => mediaQuery?.removeEventListener('change', handler))
})

const jsonTheme = computed(() => prefersDark.value ? 'dark' : 'light')

const jsonData = computed(() => {
  if (props.data === null || props.data === undefined) return null
  return props.data as Record<string, unknown>
})

const copyContent = async () => {
  const text = JSON.stringify(props.data, null, 2)
  await navigator.clipboard.writeText(text)
}
</script>

<template>
  <NModal
    :show="visible"
    preset="card"
    :title="title + ' - Raw JSON'"
    style="width: 1200px; max-width: 95vw; max-height: 90vh;"
    :bordered="false"
    @update:show="$emit('update:visible', $event)"
  >
    <template #header-extra>
      <NButton text @click="copyContent">
        <template #icon>
          <NIcon><CopyOutline /></NIcon>
        </template>
        Copy
      </NButton>
    </template>

    <div class="json-tree-container">
      <VueJsonPretty
        :data="jsonData"
        :deep="3"
        :show-length="true"
        :show-line="true"
        :show-icon="true"
        :show-double-quotes="true"
        :collapsed-on-click-brackets="true"
        :theme="jsonTheme"
      />
    </div>
  </NModal>
</template>

<style scoped>
.json-tree-container {
  max-height: 75vh;
  overflow: auto;
  font-size: 12px;
}

.json-tree-container :deep(.vjs-tree) {
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>
