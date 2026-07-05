<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import {
  //
  computed,
  ref,
} from "vue"

import type { JoinedModelTelemetry } from "@/composables/model-telemetry-join"
import type {
  //
  ModelColumnKey,
  UseModelColumnsReturn,
} from "@/composables/useModelColumns"

const props = defineProps<{
  models: Array<Model>
  caps: (m: Model) => DerivedCapabilities
  vendorColor: (v: string | undefined) => string
  fmtNum: (n: number | undefined) => string
  selectedId?: string | null
  columns?: UseModelColumnsReturn
  telemetryFor?: (id: string) => JoinedModelTelemetry | null
  maxRequests7d?: number
}>()

const emit = defineEmits<{ select: [string] }>()

/** Column is shown when no column controller is provided (standalone), or the controller says so. */
function showCol(key: ModelColumnKey): boolean {
  return props.columns?.isVisible(key) ?? true
}

function requests7d(m: Model): number {
  return props.telemetryFor?.(m.id)?.last7d?.requestCount ?? 0
}

function requestShare(m: Model): number {
  const max = props.maxRequests7d ?? 0
  return max > 0 ? (requests7d(m) / max) * 100 : 0
}

type SortKey = "id" | "vendor" | "context" | "output" | "billing"
const sortKey = ref<SortKey>("id")
const sortDesc = ref(false)

function sortVal(m: Model, key: SortKey): string | number {
  const c = props.caps(m)
  switch (key) {
    case "id": {
      return m.id
    }
    case "vendor": {
      return m.vendor ?? ""
    }
    case "context": {
      return c.contextWindow ?? 0
    }
    case "output": {
      return c.maxOutput ?? 0
    }
    case "billing": {
      return m.billing?.multiplier ?? 0
    }
    default: {
      return ""
    }
  }
}

const sorted = computed(() => {
  const list = [...props.models]
  list.sort((a, b) => {
    const va = sortVal(a, sortKey.value)
    const vb = sortVal(b, sortKey.value)
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))
    return sortDesc.value ? -cmp : cmp
  })
  return list
})

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value
  else {
    sortKey.value = key
    // Numeric columns default to descending (largest first) — more useful.
    sortDesc.value = key === "context" || key === "output" || key === "billing"
  }
}

// Capability matrix columns (icon per derived boolean) + thinking/effort detail.
const capCols: Array<{ key: keyof DerivedCapabilities; label: string }> = [
  { key: "vision", label: "Vis" },
  { key: "toolCalls", label: "Tool" },
  { key: "parallelToolCalls", label: "Par" },
  { key: "structuredOutputs", label: "Struct" },
  { key: "streaming", label: "Stream" },
  { key: "thinking", label: "Think" },
]

function thinkingDetail(c: DerivedCapabilities): string {
  if (!c.thinking) return ""
  if (c.maxThinkingBudget > 0) return `≤${props.fmtNum(c.maxThinkingBudget)}`
  return c.adaptiveThinking ? "adaptive" : ""
}
</script>

<template>
  <div class="models-table-wrap">
    <v-table
      density="compact"
      fixed-header
      hover
      class="models-table bg-transparent"
    >
      <thead>
        <tr>
          <th
            class="th-sort"
            @click="toggleSort('id')"
          >
            Model<span
              v-if="sortKey === 'id'"
              class="sort-caret"
              >{{ sortDesc ? "▼" : "▲" }}</span
            >
          </th>
          <th
            v-if="showCol('vendor')"
            class="th-sort"
            @click="toggleSort('vendor')"
          >
            Vendor<span
              v-if="sortKey === 'vendor'"
              class="sort-caret"
              >{{ sortDesc ? "▼" : "▲" }}</span
            >
          </th>
          <th
            v-if="showCol('context')"
            class="th-num th-sort"
            @click="toggleSort('context')"
          >
            Ctx<span
              v-if="sortKey === 'context'"
              class="sort-caret"
              >{{ sortDesc ? "▼" : "▲" }}</span
            >
          </th>
          <th
            v-if="showCol('output')"
            class="th-num th-sort"
            @click="toggleSort('output')"
          >
            Out<span
              v-if="sortKey === 'output'"
              class="sort-caret"
              >{{ sortDesc ? "▼" : "▲" }}</span
            >
          </th>
          <th
            v-if="showCol('effort')"
            class="th-num"
          >
            Effort
          </th>
          <th
            v-for="col in capCols"
            v-show="showCol(col.key as ModelColumnKey)"
            :key="col.key"
            class="th-cap"
          >
            {{ col.label }}
          </th>
          <th
            v-if="showCol('billing')"
            class="th-num th-sort"
            @click="toggleSort('billing')"
          >
            $×<span
              v-if="sortKey === 'billing'"
              class="sort-caret"
              >{{ sortDesc ? "▼" : "▲" }}</span
            >
          </th>
          <th
            v-if="showCol('requests7d')"
            class="th-num"
          >
            Req 7d
          </th>
        </tr>
      </thead>
      <tbody>
        <template
          v-for="m in sorted"
          :key="m.id"
        >
          <tr
            class="model-row"
            :class="{ selected: m.id === selectedId }"
            :aria-selected="m.id === selectedId"
            @click="emit('select', m.id)"
          >
            <td class="td-id font-mono">
              {{ m.id
              }}<v-chip
                v-if="m.is_chat_default"
                size="x-small"
                variant="tonal"
                color="primary"
                class="ml-1"
                >default</v-chip
              ><v-chip
                v-if="m.preview"
                size="x-small"
                variant="tonal"
                class="ml-1"
                >preview</v-chip
              >
            </td>
            <td
              v-if="showCol('vendor')"
              class="dense"
            >
              <v-chip
                size="x-small"
                variant="tonal"
                :color="vendorColor(m.vendor)"
                >{{ m.vendor }}</v-chip
              >
            </td>
            <td
              v-if="showCol('context')"
              class="td-num font-mono"
            >
              {{ fmtNum(caps(m).contextWindow) }}
            </td>
            <td
              v-if="showCol('output')"
              class="td-num font-mono"
            >
              {{ fmtNum(caps(m).maxOutput) }}
            </td>
            <td
              v-if="showCol('effort')"
              class="td-num font-mono effort-cell"
            >
              {{ caps(m).reasoningEffort.join("/") || "-" }}
            </td>
            <td
              v-for="col in capCols"
              v-show="showCol(col.key as ModelColumnKey)"
              :key="col.key"
              class="td-cap"
            >
              <span
                v-if="col.key === 'thinking' && caps(m).thinking"
                class="cap-yes font-mono"
                :title="thinkingDetail(caps(m))"
                >✓</span
              >
              <span
                v-else-if="caps(m)[col.key]"
                class="cap-yes"
                >✓</span
              >
              <span
                v-else
                class="cap-no"
                >·</span
              >
            </td>
            <td
              v-if="showCol('billing')"
              class="td-num font-mono"
            >
              {{ m.billing?.multiplier ?? "-" }}
            </td>
            <td
              v-if="showCol('requests7d')"
              class="td-num font-mono req-cell"
            >
              <span class="req-count">{{ requests7d(m) || "-" }}</span>
              <span
                v-if="requests7d(m) > 0"
                class="req-bar"
                :style="{ width: `${requestShare(m)}%` }"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </v-table>
  </div>
</template>

<style scoped>
.models-table-wrap {
  overflow-x: auto;
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.models-table :deep(th),
.models-table :deep(td) {
  padding: 5px 8px;
  white-space: nowrap;
}

.models-table :deep(th) {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(var(--v-theme-secondary));
}

.th-sort {
  cursor: pointer;
  user-select: none;
}

.th-sort:hover {
  color: rgb(var(--v-theme-primary));
}

.sort-caret {
  margin-left: 3px;
  font-size: 0.6rem;
}

.th-num,
.td-num {
  text-align: right;
}

.th-cap,
.td-cap {
  text-align: center;
}

.dense,
.td-num,
.td-cap,
.td-id {
  font-size: 0.76rem;
}

.model-row {
  cursor: pointer;
}

.model-row.selected {
  background: rgb(var(--v-theme-surface-variant));
}

.td-id {
  font-weight: 600;
}

.effort-cell {
  color: rgb(var(--v-theme-secondary));
}

.cap-yes {
  color: rgb(var(--v-theme-success));
  font-weight: 700;
}

.cap-no {
  color: rgb(var(--v-theme-surface-variant));
}

.req-cell {
  position: relative;
}

.req-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: rgb(var(--v-theme-primary));
  opacity: 0.6;
}
</style>
