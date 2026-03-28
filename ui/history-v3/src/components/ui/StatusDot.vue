<script setup lang="ts">
withDefaults(
  defineProps<{
    status: "success" | "error" | "pending"
    size?: number
  }>(),
  {
    size: 8,
  },
)
</script>

<template>
  <span
    class="status-dot"
    :class="'status-' + status"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
</template>

<style scoped>
.status-dot {
  display: inline-block;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-success {
  background: var(--success);
  box-shadow: 0 0 4px var(--success);
}
.status-error {
  background: var(--error);
  box-shadow: 0 0 4px var(--error);
}
.status-pending {
  background: var(--warning);
  box-shadow: 0 0 4px var(--warning);
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
