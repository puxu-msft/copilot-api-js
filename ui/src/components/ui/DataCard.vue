<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<template>
  <div class="data-card">
    <div class="card-title">{{ title }}</div>
    <div class="card-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.data-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.card-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text);
  padding-bottom: var(--spacing-sm);
  border-bottom: 1px solid var(--border-light);
}

.card-content {
  display: flex;
  flex-direction: column;
}
</style>
