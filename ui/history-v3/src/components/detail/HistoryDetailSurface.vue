<script setup lang="ts">
import DetailPanel from "@/components/detail/DetailPanel.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

withDefaults(
  defineProps<{
    title: string
    loading: boolean
    missingId: string | null
  }>(),
  {
    missingId: null,
  },
)

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <div
    class="history-detail-surface"
    data-testid="activity-detail-card"
  >
    <div class="detail-toolbar">
      <div class="detail-heading">
        <div class="detail-title">Request</div>
        <div class="detail-subtitle text-caption text-medium-emphasis">
          {{ missingId ? `Request ${missingId}` : title }}
        </div>
      </div>

      <div class="detail-actions">
        <slot name="actions">
          <v-btn
            variant="outlined"
            size="small"
            prepend-icon="mdi-close"
            @click="emit('close')"
          >
            Close
          </v-btn>
        </slot>
      </div>
    </div>

    <div
      v-if="loading"
      class="detail-state"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else-if="missingId"
      class="detail-state"
    >
      <div class="empty-title">Detail is not available yet.</div>
      <div class="text-caption text-medium-emphasis">
        The request entry may still be initializing. Retry from Activity in a moment.
      </div>
    </div>

    <div
      v-else
      class="detail-body"
    >
      <ErrorBoundary label="History detail">
        <DetailPanel />
      </ErrorBoundary>
    </div>
  </div>
</template>

<style scoped>
.history-detail-surface {
  width: 100%;
  min-height: min(760px, calc(100vh - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.detail-heading {
  min-width: 0;
}

.detail-title {
  font-size: 1.125rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
}

.detail-subtitle {
  margin-top: 4px;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.detail-state {
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.detail-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  background: rgb(var(--v-theme-surface));
}

.detail-body :deep(.detail-panel) {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  height: auto;
  background: rgb(var(--v-theme-surface));
}

.detail-body :deep(.detail-empty) {
  flex: 1;
  min-height: 0;
  height: auto;
}

.empty-title {
  font-size: 1rem;
  font-weight: 600;
}

@media (max-width: 960px) {
  .history-detail-surface {
    min-height: calc(100vh - 24px);
    max-height: calc(100vh - 24px);
  }

  .detail-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
