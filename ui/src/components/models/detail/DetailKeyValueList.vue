<script setup lang="ts">
defineProps<{ rows: Array<[string, string | null]> }>()
</script>

<template>
  <div class="kv-list">
    <div
      v-for="[label, value] in rows"
      :key="label"
      class="kv-row"
    >
      <span class="kv-label">{{ label }}</span>
      <span class="kv-value font-mono">{{ value ?? "—" }}</span>
    </div>
  </div>
</template>

<style scoped>
.kv-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kv-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: baseline;
}

.kv-label {
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.kv-value {
  font-size: 0.83rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
  word-break: break-word;
}
</style>
