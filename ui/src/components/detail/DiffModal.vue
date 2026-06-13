<script setup lang="ts">
import {
  //
  computed,
  ref,
  watch,
} from "vue"

import type { MessageContent } from "@/types"

import ContentRenderer from "@/components/message/ContentRenderer.vue"
import SideBySideView from "@/components/message/SideBySideView.vue"
import { useCopyToClipboard } from "@/composables/useCopyToClipboard"
import {
  //
  diffLinesRich,
  type DiffLineRow,
} from "@/utils/block-diff"

const props = defineProps<{
  visible: boolean
  original: MessageContent | null
  effective: MessageContent | null
  label: string
}>()
const emit = defineEmits<{ "update:visible": [boolean] }>()

const { copy } = useCopyToClipboard()

type Mode = "unified" | "side-by-side"
const mode = ref<Mode>("unified")
const CONTEXT = 3

function asJson(m: MessageContent | null): string {
  if (!m) return ""
  return JSON.stringify(m.content ?? null, null, 2)
}

const unifiedRows = computed(() => (props.original && props.effective ? diffLinesRich(asJson(props.original), asJson(props.effective)) : []))

const stats = computed(() => {
  const s = { add: 0, del: 0 }
  for (const r of unifiedRows.value) {
    if (r.kind === "add") s.add++
    else if (r.kind === "del") s.del++
  }
  return s
})

// Collapse long runs of unchanged lines into expandable gaps (git hunk style),
// keeping CONTEXT lines around each change so changes aren't drowned in same-text.
const expandedGaps = ref<Set<number>>(new Set())
watch([() => props.original, () => props.effective], () => (expandedGaps.value = new Set()))

type DisplayItem = { type: "row"; row: DiffLineRow } | { type: "gap"; count: number; id: number }
const displayItems = computed<Array<DisplayItem>>(() => {
  const rows = unifiedRows.value
  const keep = Array.from({ length: rows.length }, () => false)
  for (const [i, r] of rows.entries()) {
    if (r.kind === "same") continue
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true
  }
  const items: Array<DisplayItem> = []
  let i = 0
  while (i < rows.length) {
    if (keep[i]) {
      items.push({ type: "row", row: rows[i] })
      i++
      continue
    }
    let j = i
    while (j < rows.length && !keep[j]) j++
    if (expandedGaps.value.has(i) || j - i <= 1) {
      for (let k = i; k < j; k++) items.push({ type: "row", row: rows[k] })
    } else {
      items.push({ type: "gap", count: j - i, id: i })
    }
    i = j
  }
  return items
})

function expandGap(id: number): void {
  const next = new Set(expandedGaps.value)
  next.add(id)
  expandedGaps.value = next
}

function gutter(kind: DiffLineRow["kind"]): string {
  if (kind === "add") return "+"
  if (kind === "del") return "−"
  return " "
}

function close(): void {
  emit("update:visible", false)
}
</script>

<template>
  <v-dialog
    :model-value="visible"
    max-width="1180"
    scrollable
    @update:model-value="emit('update:visible', $event)"
  >
    <v-card class="diff-modal">
      <div class="diff-head">
        <div class="diff-title-wrap">
          <div class="diff-eyebrow">Original → Effective diff</div>
          <div class="diff-title">{{ label }}</div>
        </div>
        <div class="diff-actions">
          <v-btn-toggle
            v-model="mode"
            mandatory
            density="compact"
            variant="outlined"
            divided
          >
            <v-btn
              value="unified"
              size="small"
              >Unified</v-btn
            >
            <v-btn
              value="side-by-side"
              size="small"
              >Side&nbsp;by&nbsp;side</v-btn
            >
          </v-btn-toggle>
          <span class="diff-stat font-mono">
            <span class="d-add-text">+{{ stats.add }}</span> <span class="d-del-text">−{{ stats.del }}</span>
          </span>
          <v-btn
            size="small"
            variant="text"
            icon="mdi-content-copy"
            title="Copy effective JSON"
            @click="copy(asJson(effective), 'Effective JSON copied')"
          />
          <v-btn
            size="small"
            variant="text"
            icon="mdi-close"
            @click="close"
          />
        </div>
      </div>

      <div class="diff-body">
        <!-- Unified line+word diff (git-style: line numbers + collapsed unchanged hunks). -->
        <div
          v-if="mode === 'unified'"
          class="unified"
        >
          <template
            v-for="(item, i) in displayItems"
            :key="i"
          >
            <button
              v-if="item.type === 'gap'"
              class="u-gap"
              @click="expandGap(item.id)"
            >
              ⋯ {{ item.count }} unchanged line{{ item.count > 1 ? "s" : "" }} — click to expand
            </button>
            <div
              v-else
              class="u-row"
              :class="`u-${item.row.kind}`"
            >
              <span class="u-no">{{ item.row.oldNo ?? "" }}</span>
              <span class="u-no">{{ item.row.newNo ?? "" }}</span>
              <span class="u-gutter">{{ gutter(item.row.kind) }}</span>
              <span class="u-text">
                <template v-if="item.row.words">
                  <span
                    v-for="(p, j) in item.row.words"
                    :key="j"
                    :class="{ 'w-add': p.added, 'w-del': p.removed }"
                    >{{ p.value }}</span
                  >
                </template>
                <template v-else>{{ item.row.text }}</template>
              </span>
            </div>
          </template>
        </div>

        <!-- Side-by-side rendered content (semantic view). -->
        <SideBySideView
          v-else
          :identical="false"
        >
          <template #original>
            <ContentRenderer
              v-if="original"
              :content="original.content ?? ''"
              :message="original"
            />
          </template>
          <template #rewritten>
            <ContentRenderer
              v-if="effective"
              :content="effective.content ?? ''"
              :message="effective"
            />
          </template>
        </SideBySideView>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.diff-modal {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.diff-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.diff-eyebrow {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(var(--v-theme-secondary));
}

.diff-title {
  font-size: 0.95rem;
  font-weight: 700;
}

.diff-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.diff-stat {
  font-size: 0.8rem;
}

.d-add-text {
  color: rgb(var(--v-theme-success));
}

.d-del-text {
  color: rgb(var(--v-theme-error));
}

.diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 0;
}

.unified {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
}

.u-row {
  display: flex;
  gap: 8px;
  padding: 0 12px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.u-row.u-add {
  background: rgb(var(--v-theme-success) / 10%);
}
.u-row.u-del {
  background: rgb(var(--v-theme-error) / 10%);
}

.u-no {
  flex-shrink: 0;
  width: 40px;
  text-align: right;
  padding-right: 4px;
  color: rgb(var(--v-theme-secondary));
  opacity: 0.6;
  user-select: none;
}

.u-gutter {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  user-select: none;
  color: rgb(var(--v-theme-secondary));
}

.u-add .u-gutter {
  color: rgb(var(--v-theme-success));
}
.u-del .u-gutter {
  color: rgb(var(--v-theme-error));
}

.u-text {
  flex: 1;
  min-width: 0;
}

.w-add {
  background: rgb(var(--v-theme-success) / 28%);
}
.w-del {
  background: rgb(var(--v-theme-error) / 28%);
}

.u-gap {
  display: block;
  width: 100%;
  text-align: center;
  padding: 2px 0;
  font-size: 0.72rem;
  color: rgb(var(--v-theme-secondary));
  background: rgb(var(--v-theme-surface-variant) / 40%);
  cursor: pointer;
}

.u-gap:hover {
  color: rgb(var(--v-theme-primary));
  background: rgb(var(--v-theme-primary) / 10%);
}

.diff-body :deep(.side-by-side) {
  padding: 0 12px;
}
</style>
