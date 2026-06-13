<script setup lang="ts">
import { computed } from "vue"

import type { MessageContent } from "@/types"

import {
  //
  diffMessageList,
  diffStats,
} from "@/utils/block-diff"

const props = defineProps<{ left: Array<MessageContent>; right: Array<MessageContent> }>()

// Bound DOM cost (slot stays mounted under SectionBlock's v-show). Full data is
// reachable via the surrounding section's Raw modal.
const MAX_ROWS = 400
const rows = computed(() => diffMessageList(props.left, props.right))
const stats = computed(() => diffStats(rows.value))
const visibleRows = computed(() => rows.value.slice(0, MAX_ROWS))
const hiddenCount = computed(() => Math.max(0, rows.value.length - MAX_ROWS))

const sign: Record<string, string> = { same: "=", added: "+", removed: "−", modified: "~" }
const color: Record<string, string> = { same: "secondary", added: "success", removed: "error", modified: "aborted" }

function preview(m: MessageContent | undefined): string {
  if (!m) return ""
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null)
  return text.length > 160 ? text.slice(0, 157) + "…" : text
}
</script>

<template>
  <div class="msg-diff">
    <div class="msg-diff-summary text-caption text-medium-emphasis font-mono">
      {{ stats.modified }}~ {{ stats.removed }}− {{ stats.added }}+ · {{ stats.same }} unchanged
    </div>
    <div
      v-for="(row, i) in visibleRows"
      :key="i"
      class="msg-row"
      :class="`msg-${row.kind}`"
    >
      <span
        class="msg-sign font-mono"
        :style="{ color: `rgb(var(--v-theme-${color[row.kind]}))` }"
        >{{ sign[row.kind] }}</span
      >
      <span class="msg-role font-mono">{{ row.role }}</span>
      <span class="msg-body font-mono">
        <template v-if="row.kind === 'modified' && row.textDiff">
          <span
            v-for="(part, j) in row.textDiff"
            :key="j"
            :class="{ 'd-add': part.added, 'd-del': part.removed }"
            >{{ part.value }}</span
          >
        </template>
        <template v-else>{{ preview(row.right ?? row.left) }}</template>
      </span>
    </div>
    <div
      v-if="hiddenCount > 0"
      class="msg-more text-caption text-medium-emphasis"
    >
      +{{ hiddenCount }} more messages — open Raw for the full diff.
    </div>
  </div>
</template>

<style scoped>
.msg-diff {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.msg-diff-summary {
  margin-bottom: 6px;
}

.msg-row {
  display: grid;
  grid-template-columns: 16px 80px 1fr;
  gap: 8px;
  padding: 3px 6px;
  font-size: 0.74rem;
  align-items: baseline;
}

.msg-row.msg-removed {
  background: rgb(var(--v-theme-error) / 8%);
}
.msg-row.msg-added {
  background: rgb(var(--v-theme-success) / 8%);
}
.msg-row.msg-modified {
  background: rgb(var(--v-theme-aborted) / 8%);
}
.msg-row.msg-same {
  opacity: 0.55;
}

.msg-sign {
  font-weight: 700;
  text-align: center;
}

.msg-role {
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
}

.msg-body {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--v-theme-on-surface-variant));
}

.msg-modified .msg-body {
  white-space: normal;
  word-break: break-word;
}

.d-add {
  background: rgb(var(--v-theme-success) / 22%);
}
.d-del {
  background: rgb(var(--v-theme-error) / 22%);
  text-decoration: line-through;
}
</style>
