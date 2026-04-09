<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue"

withDefaults(
  defineProps<{
    defaultLeftWidth?: number
    minLeftWidth?: number
    maxLeftWidth?: number
  }>(),
  {
    defaultLeftWidth: 320,
    minLeftWidth: 240,
    maxLeftWidth: 500,
  },
)

const leftWidth = ref(Number.parseInt(localStorage.getItem("history-v3-split-width") || "0") || 320)
const isDragging = ref(false)

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  document.addEventListener("mousemove", onMouseMove)
  document.addEventListener("mouseup", onMouseUp)
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  const newWidth = Math.max(240, Math.min(500, e.clientX))
  leftWidth.value = newWidth
}

function onMouseUp() {
  isDragging.value = false
  localStorage.setItem("history-v3-split-width", String(leftWidth.value))
  document.removeEventListener("mousemove", onMouseMove)
  document.removeEventListener("mouseup", onMouseUp)
}

onMounted(() => {
  const saved = Number.parseInt(localStorage.getItem("history-v3-split-width") || "0")
  if (saved > 0) leftWidth.value = saved
})

onUnmounted(() => {
  document.removeEventListener("mousemove", onMouseMove)
  document.removeEventListener("mouseup", onMouseUp)
})
</script>

<template>
  <div
    class="split-pane"
    :class="{ dragging: isDragging }"
  >
    <div
      class="split-left"
      :style="{ width: leftWidth + 'px' }"
    >
      <slot name="left" />
    </div>
    <div
      class="split-handle"
      @mousedown="onMouseDown"
    />
    <div class="split-right">
      <slot name="right" />
    </div>
  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.split-pane.dragging {
  user-select: none;
  cursor: col-resize;
}

.split-left {
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.split-handle {
  width: 4px;
  background: var(--border);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background var(--transition-fast);
}

.split-handle:hover,
.dragging .split-handle {
  background: var(--primary);
}

.split-right {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .split-pane {
    flex-direction: column;
  }

  .split-left {
    width: 100% !important;
    height: 40%;
    border-bottom: 1px solid var(--border);
  }

  .split-handle {
    display: none;
  }

  .split-right {
    height: 60%;
  }
}
</style>
