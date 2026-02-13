<script setup lang="ts">
withDefaults(defineProps<{
  color?: 'default' | 'primary' | 'success' | 'error' | 'warning' | 'purple' | 'cyan' | 'pink'
}>(), {
  color: 'default',
})
</script>

<template>
  <span class="base-badge" :class="'badge-' + color">
    <slot />
  </span>
</template>

<style scoped>
.base-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 0;
  font-size: var(--font-size-xs);
  font-weight: 500;
  white-space: nowrap;
  line-height: 1.2;
}

.badge-default {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.badge-primary {
  background: var(--primary-muted);
  color: var(--primary);
}
.badge-success {
  background: var(--success-muted);
  color: var(--success);
}
.badge-error {
  background: var(--error-muted);
  color: var(--error);
}
.badge-warning {
  background: var(--warning-muted);
  color: var(--warning);
}
.badge-purple {
  background: var(--purple-muted);
  color: var(--purple);
}
.badge-cyan {
  background: var(--cyan-muted);
  color: var(--cyan);
}
.badge-pink {
  background: var(--pink-muted);
  color: var(--pink);
}
</style>
