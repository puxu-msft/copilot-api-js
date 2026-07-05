<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <section class="detail-section">
    <div class="section-title">{{ title }}</div>
    <slot />
  </section>
</template>

<style scoped>
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.section-title {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
  font-weight: 700;
}
</style>
