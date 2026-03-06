<script setup lang="ts">
import ContentBlockWrapper from './ContentBlockWrapper.vue'

defineProps<{
  mediaType: string
  data: string
}>()
</script>

<template>
  <ContentBlockWrapper
    label="IMAGE"
    label-color="pink"
    :summary="mediaType"
    :raw-data="{ type: 'image', source: { type: 'base64', media_type: mediaType } }"
    raw-title="Raw — image"
  >
    <template #header-extra>
      <span class="image-media-type">{{ mediaType }}</span>
    </template>
    <img :src="'data:' + mediaType + ';base64,' + data" alt="Image content" class="image-content" />
  </ContentBlockWrapper>
</template>

<style scoped>
.image-media-type {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.image-content {
  max-width: 100%;
  max-height: 400px;
  border: 1px solid var(--border);
}
</style>
