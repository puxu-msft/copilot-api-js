<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "danger" | "ghost"
    size?: "sm" | "md"
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    variant: "default",
    size: "sm",
    disabled: false,
    loading: false,
  },
)

defineEmits<{
  click: [e: MouseEvent]
}>()
</script>

<template>
  <button
    class="base-btn"
    :class="['btn-' + variant, 'btn-size-' + size, { 'btn-loading': loading }]"
    :disabled="disabled || loading"
    @click="$emit('click', $event)"
  >
    <span
      v-if="loading"
      class="spinner"
    />
    <slot />
  </button>
</template>

<style scoped>
.base-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  border-radius: var(--border-radius-sm);
  font-weight: 500;
  white-space: nowrap;
  transition: all var(--transition-fast);
  border: 1px solid var(--border);
  line-height: 1;
}

.base-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sizes */
.btn-size-sm {
  padding: 4px 8px;
  font-size: var(--font-size-xs);
}
.btn-size-md {
  padding: 6px 12px;
  font-size: var(--font-size-sm);
}

/* Variants */
.btn-default {
  background: var(--bg-tertiary);
  color: var(--text);
}
.btn-default:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn-primary {
  background: var(--primary);
  color: var(--primary-contrast);
  border-color: var(--primary);
}
.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-danger {
  background: transparent;
  color: var(--error);
  border-color: var(--error);
}
.btn-danger:hover:not(:disabled) {
  background: var(--error-muted);
}

.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.btn-ghost:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-tertiary);
}

/* Loading spinner */
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
