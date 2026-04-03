<script setup lang="ts">
defineProps<{
  filteredCount: number
  totalCount: number
  vendorCount: number
  endpointCount: number
}>()
defineEmits<{
  openRawJson: []
}>()
</script>

<template>
  <div class="toolbar-shell">
    <div class="toolbar-copy">
      <div class="toolbar-title">Models</div>
      <div class="toolbar-meta text-caption text-medium-emphasis">
        {{ filteredCount }} visible / {{ totalCount }} total · {{ vendorCount }} vendors · {{ endpointCount }} endpoints
      </div>
    </div>

    <v-btn
      variant="outlined"
      class="raw-json-button"
      @click="$emit('openRawJson')"
    >
      Raw JSON
    </v-btn>
  </div>
</template>

<style scoped>
.toolbar-shell {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.toolbar-copy {
  min-width: 0;
}

.toolbar-title {
  font-size: 1.125rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
}

.toolbar-meta {
  margin-top: 4px;
}

.raw-json-button {
  flex-shrink: 0;
}

@media (max-width: 900px) {
  .toolbar-shell {
    flex-direction: column;
    align-items: start;
  }
}
</style>
