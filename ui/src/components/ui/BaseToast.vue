<script setup lang="ts">
import { useToast } from "@/composables/useToast"

const { messages } = useToast()
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="slide-up">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="toast-item"
          :class="'toast-' + msg.type"
        >
          {{ msg.text }}
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast-item {
  padding: 8px 16px;
  border-radius: var(--border-radius);
  font-size: var(--font-size-sm);
  box-shadow: var(--shadow-md);
  pointer-events: auto;
  max-width: 320px;
}

.toast-info {
  background: var(--bg-tertiary);
  color: var(--text);
  border: 1px solid var(--border);
}

.toast-success {
  background: var(--success-muted);
  color: var(--success);
  border: 1px solid var(--success);
}

.toast-error {
  background: var(--error-muted);
  color: var(--error);
  border: 1px solid var(--error);
}
</style>
