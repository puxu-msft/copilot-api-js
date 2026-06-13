<script setup lang="ts">
import { computed } from "vue"

import type { SseEventRecord } from "@/types"

import SectionBlock from "@/components/detail/SectionBlock.vue"
import {
  //
  diffSseFrames,
  diffStats,
} from "@/utils/block-diff"

const props = defineProps<{ upstream: Array<SseEventRecord>; forwarded: Array<SseEventRecord> }>()

// Bound work: SectionBlock keeps the slot mounted (v-show), so this computes on
// mount regardless of collapse. Skip the diff for pathologically large streams
// (worst-case O(N·D)), and cap rendered rows (DOM cost) — full data is always in
// the section's Raw modal.
const MAX_INPUT = 4000
const MAX_ROWS = 400
const oversized = computed(() => props.upstream.length + props.forwarded.length > MAX_INPUT)

const rows = computed(() => (oversized.value ? [] : diffSseFrames(props.upstream, props.forwarded)))
const stats = computed(() => diffStats(rows.value))
const visibleRows = computed(() => rows.value.slice(0, MAX_ROWS))
const hiddenCount = computed(() => Math.max(0, rows.value.length - MAX_ROWS))
// Default-expand only when there's an actual divergence (rewrite/drop/add) —
// an identical pass-through stays collapsed (nothing to diagnose).
const hasDivergence = computed(() => stats.value.modified + stats.value.added + stats.value.removed > 0)

const kindMeta: Record<string, { label: string; color: string; sign: string }> = {
  same: { label: "same", color: "secondary", sign: "=" },
  modified: { label: "rewritten", color: "aborted", sign: "~" },
  removed: { label: "dropped", color: "error", sign: "−" },
  added: { label: "added", color: "success", sign: "+" },
}
</script>

<template>
  <SectionBlock
    title="SSE Frames (upstream vs client)"
    anchor="sse-diff"
    :default-collapsed="!hasDivergence"
    :badge="`${stats.modified}~ ${stats.removed}− ${stats.added}+`"
    :raw-data="{ upstream, forwarded }"
    raw-title="SSE frames (both sides)"
  >
    <div
      v-if="oversized"
      class="frame-oversized text-caption text-medium-emphasis"
    >
      Stream too large to diff inline ({{ upstream.length }} + {{ forwarded.length }} frames). Open Raw for the full data.
    </div>
    <div
      v-else
      class="frame-diff"
    >
      <div
        v-for="(row, i) in visibleRows"
        :key="i"
        class="frame-row"
        :class="`frame-${row.kind}`"
      >
        <span
          class="frame-tag font-mono"
          :style="{ color: `rgb(var(--v-theme-${kindMeta[row.kind].color}))` }"
          >{{ kindMeta[row.kind].sign }}</span
        >
        <span class="frame-type font-mono">{{ row.type }}</span>
        <span
          class="frame-body font-mono"
          :class="{ 'frame-body-wrap': row.kind === 'modified' }"
        >
          <template v-if="row.kind === 'modified' && row.rawDiff">
            <span
              v-for="(part, j) in row.rawDiff"
              :key="j"
              :class="{ 'd-add': part.added, 'd-del': part.removed }"
              >{{ part.value }}</span
            >
          </template>
          <template v-else>{{ (row.forwarded ?? row.upstream)?.raw }}</template>
        </span>
      </div>
      <div
        v-if="hiddenCount > 0"
        class="frame-more text-caption text-medium-emphasis"
      >
        +{{ hiddenCount }} more frames — open Raw for the full diff.
      </div>
    </div>
  </SectionBlock>
</template>

<style scoped>
.frame-diff {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 0.72rem;
}

.frame-row {
  display: grid;
  grid-template-columns: 16px 160px 1fr;
  gap: 8px;
  padding: 2px 6px;
  align-items: baseline;
}

.frame-row.frame-removed {
  background: rgb(var(--v-theme-error) / 8%);
}
.frame-row.frame-added {
  background: rgb(var(--v-theme-success) / 8%);
}
.frame-row.frame-modified {
  background: rgb(var(--v-theme-aborted) / 8%);
}

.frame-tag {
  font-weight: 700;
  text-align: center;
}

.frame-type {
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.frame-body {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--v-theme-on-surface-variant));
}

/* Rewritten frames wrap so the full inline diff is visible (not ellipsis-clipped). */
.frame-body-wrap {
  overflow: visible;
  white-space: normal;
  word-break: break-word;
}

.frame-oversized,
.frame-more {
  padding: 6px;
}

.d-add {
  background: rgb(var(--v-theme-success) / 22%);
}
.d-del {
  background: rgb(var(--v-theme-error) / 22%);
  text-decoration: line-through;
}
</style>
