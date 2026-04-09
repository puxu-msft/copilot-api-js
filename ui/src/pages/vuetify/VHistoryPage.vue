<script setup lang="ts">
import HistoryDetailSurface from "@/components/detail/HistoryDetailSurface.vue"
import { useHistoryDetailRoute } from "@/composables/useHistoryDetailRoute"

const { detailLoading, detailMissingId, detailTitle, closeHistoryDetail } = useHistoryDetailRoute()
</script>

<template>
  <div class="history-detail-page v-page-root">
    <div class="v-page-scroll">
      <section class="history-detail-shell px-4 px-md-6 pt-4 pb-6">
        <HistoryDetailSurface
          :title="detailTitle"
          :loading="detailLoading"
          :missing-id="detailMissingId"
          @close="closeHistoryDetail"
        >
          <template #actions>
            <v-btn
              variant="outlined"
              size="small"
              prepend-icon="mdi-arrow-left"
              @click="closeHistoryDetail"
            >
              Back to Activity
            </v-btn>
          </template>
        </HistoryDetailSurface>
      </section>
    </div>
  </div>
</template>

<style scoped>
.history-detail-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: none;
  margin: 0 auto;
}
</style>
