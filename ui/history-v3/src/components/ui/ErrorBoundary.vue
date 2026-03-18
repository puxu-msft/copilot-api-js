<script setup lang="ts">
import { ref, onErrorCaptured } from "vue"

defineProps<{
  /** Fallback label shown when an error is captured */
  label?: string
}>()

const error = ref<Error | null>(null)

onErrorCaptured((err: Error) => {
  error.value = err
  console.error("[ErrorBoundary]", err)
  // Prevent error from propagating further
  return false
})
</script>

<template>
  <div v-if="error" class="error-boundary">
    <span class="error-icon">!</span>
    <span class="error-label">{{ label || "Render error" }}</span>
    <span class="error-message">{{ error.message }}</span>
  </div>
  <slot v-else />
</template>

<style scoped>
.error-boundary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--error-muted);
  border: 1px solid var(--error);
  font-size: var(--font-size-sm);
  color: var(--error);
  font-family: var(--font-mono);
}

.error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--error);
  font-weight: 700;
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}

.error-label {
  font-weight: 600;
  flex-shrink: 0;
}

.error-message {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
