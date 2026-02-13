<script setup lang="ts">
import IconSvg from './IconSvg.vue'

defineProps<{
  visible: boolean
  title: string
  width?: string
  height?: string
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

function close() {
  emit('update:visible', false)
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    close()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="modal-overlay"
        @click="onOverlayClick"
        @keydown="onKeydown"
      >
        <div class="modal-content" :style="{ width: width || '80vw', height: height }">
          <div class="modal-header">
            <h3 class="modal-title">{{ title }}</h3>
            <div class="modal-header-actions">
              <slot name="header-actions" />
              <button class="modal-close" @click="close">
                <IconSvg name="close" :size="16" />
              </button>
            </div>
          </div>
          <div class="modal-body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.modal-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-lg);
  max-height: 95vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.modal-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.modal-close {
  color: var(--text-muted);
  padding: var(--spacing-xs);
  border-radius: var(--border-radius-sm);
  transition: all var(--transition-fast);
}
.modal-close:hover {
  color: var(--text);
  background: var(--bg-tertiary);
}

.modal-body {
  padding: var(--spacing-lg);
  overflow-y: auto;
  flex: 1;
}
</style>
