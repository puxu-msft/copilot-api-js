<script setup lang="ts">
import { ref } from "vue"

defineProps<{
  headers: Record<string, string>
  title: string
}>()

const collapsed = ref(true)
</script>

<template>
  <div class="headers-section">
    <button
      class="headers-toggle"
      @click="collapsed = !collapsed"
    >
      <span class="toggle-icon">{{ collapsed ? "+" : "-" }}</span>
      {{ title }}
      <span class="header-count">({{ Object.keys(headers).length }})</span>
    </button>
    <div
      v-if="!collapsed"
      class="headers-grid"
    >
      <div
        v-for="(value, key) in headers"
        :key="String(key)"
        class="header-row"
      >
        <span class="header-name">{{ key }}</span>
        <span class="header-value">{{ value }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.headers-section {
  display: flex;
  flex-direction: column;
}

.headers-toggle {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  padding: var(--spacing-xs) 0;
  background: none;
  cursor: pointer;
  text-align: left;
}

.headers-toggle:hover {
  color: var(--text);
}

.toggle-icon {
  font-family: var(--font-mono);
  width: 12px;
  text-align: center;
  font-weight: 600;
}

.header-count {
  color: var(--text-dim);
}

.headers-grid {
  display: flex;
  flex-direction: column;
  margin-top: var(--spacing-xs);
}

.header-row {
  display: flex;
  gap: var(--spacing-sm);
  padding: 2px 0;
  font-size: 10px;
  border-bottom: 1px solid var(--border-light);
}

.header-name {
  flex: 0 0 200px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  word-break: break-all;
}

.header-value {
  flex: 1;
  color: var(--text-muted);
  font-family: var(--font-mono);
  word-break: break-all;
}
</style>
