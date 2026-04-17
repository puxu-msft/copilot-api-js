<script setup lang="ts">
/**
 * Side-by-side comparison view for original vs rewritten content.
 *
 * - Text differs: shows both full texts side-by-side
 * - Text identical: left shows original content, right shows "identical" notice
 */

defineProps<{
  originalLabel?: string
  rewrittenLabel?: string
  identical: boolean
}>()
</script>

<template>
  <div class="sbs-split">
    <div class="sbs-pane">
      <div class="sbs-pane-label">{{ originalLabel ?? "Original" }}</div>
      <div class="sbs-pane-body">
        <slot name="original" />
      </div>
    </div>
    <div
      class="sbs-pane"
      :class="{ 'sbs-pane-identical': identical }"
    >
      <div class="sbs-pane-label sbs-pane-label-rewritten">{{ rewrittenLabel ?? "Rewritten" }}</div>
      <div
        v-if="identical"
        class="sbs-identical-msg"
      >
        Content is identical
      </div>
      <div
        v-else
        class="sbs-pane-body"
      >
        <slot name="rewritten" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sbs-split {
  display: flex;
  min-height: 0;
}

.sbs-pane {
  flex: 1;
  min-width: 0;
  border-right: 1px solid var(--border-light);
  display: flex;
  flex-direction: column;
}

.sbs-pane:last-child {
  border-right: none;
}

.sbs-pane-label {
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.sbs-pane-label-rewritten {
  color: var(--warning);
}

.sbs-pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.sbs-pane-identical {
  display: flex;
  flex-direction: column;
}

.sbs-identical-msg {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-style: italic;
  padding: var(--spacing-lg);
}

@media (max-width: 768px) {
  .sbs-split {
    flex-direction: column;
  }

  .sbs-pane {
    border-right: none;
    border-bottom: 1px solid var(--border-light);
  }

  .sbs-pane:last-child {
    border-bottom: none;
  }
}
</style>
