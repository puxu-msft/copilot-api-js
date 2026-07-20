<script setup lang="ts">
import { watchDebounced } from "@vueuse/core"
import {
  //
  computed,
  onActivated,
  onMounted,
  ref,
  watch,
} from "vue"
import {
  //
  useRoute,
  useRouter,
} from "vue-router"

import type {
  //
  ActivityFilters,
} from "@/composables/history-store/useHistoryData"
import type {
  //
  EntrySummary,
  RequestLifecycleState,
} from "@/types"

import ActivityRow from "@/components/activity/ActivityRow.vue"
import { useDashboardStatus } from "@/composables/useDashboardStatus"
import { useHistoryStore } from "@/composables/useHistoryStore"
import {
  //
  LIFECYCLE_STATES,
  statusMeta,
} from "@/utils/status-meta"

// Named for <keep-alive include="VActivityPage"> in App.vue.
defineOptions({ name: "VActivityPage" })

const router = useRouter()
const route = useRoute()
const store = useHistoryStore()
const { activeRequests } = useDashboardStatus()

const endpointOptions = [
  { title: "Anthropic Messages", value: "anthropic-messages" },
  { title: "OpenAI Chat Completions", value: "openai-chat-completions" },
  { title: "OpenAI Responses", value: "openai-responses" },
  { title: "Gemini Generate Content", value: "gemini-generate-content" },
]

const stateOptions = LIFECYCLE_STATES.map((s) => ({ title: statusMeta(s).label, value: s }))

// Local inputs for debounced text filters (search / model / pid).
const searchInput = ref(store.filters.search)
const modelInput = ref(store.filters.model ?? "")
const pidInput = ref<string>(store.filters.pid !== null ? String(store.filters.pid) : "")

watchDebounced(searchInput, (v) => store.setFilter("search", v), { debounce: 300 })
watchDebounced(modelInput, (v) => store.setFilter("model", v.trim() || null), { debounce: 300 })
watchDebounced(
  pidInput,
  (v) => {
    const n = v.trim() ? Number.parseInt(v.trim(), 10) : Number.NaN
    store.setFilter("pid", Number.isNaN(n) ? null : n)
  },
  { debounce: 300 },
)

// Keep local inputs in sync if filters are cleared elsewhere (chips / reset).
watch(
  () => store.filters.search,
  (v) => {
    if (v !== searchInput.value) searchInput.value = v
  },
)
watch(
  () => store.filters.model,
  (v) => {
    if ((v ?? "") !== modelInput.value) modelInput.value = v ?? ""
  },
)
watch(
  () => store.filters.pid,
  (v) => {
    const s = v !== null ? String(v) : ""
    if (s !== pidInput.value) pidInput.value = s
  },
)

/** Active filter chips for the "clear" summary bar. */
const activeFilterChips = computed(() => {
  const f = store.filters
  const chips: Array<{ key: keyof typeof f; label: string }> = []
  if (f.search) chips.push({ key: "search", label: `search: ${f.search}` })
  if (f.endpoint) chips.push({ key: "endpoint", label: `endpoint: ${f.endpoint}` })
  if (f.state) chips.push({ key: "state", label: `state: ${f.state}` })
  if (f.model) chips.push({ key: "model", label: `model: ${f.model}` })
  if (f.sessionId) chips.push({ key: "sessionId", label: `session: ${f.sessionId.slice(0, 12)}…` })
  if (f.pid !== null) chips.push({ key: "pid", label: `pid: ${f.pid}` })
  return chips
})

function clearFilter(key: keyof typeof store.filters): void {
  store.clearFilter(key)
}

function clearAllFilters(): void {
  store.clearFilters()
}

/**
 * In-flight requests come from the dashboard WS (a separate realtime stream from
 * the cursor-paginated history). Render them in their own top section using the
 * SAME ActivityRow; dedupe ids already in the current history page.
 */
const inflightRows = computed<Array<EntrySummary>>(() => {
  const historyIds = new Set(store.entries.map((e) => e.id))
  return activeRequests.value
    .filter((req) => !historyIds.has(req.id))
    .map(
      (req) =>
        ({
          id: req.id,
          startedAt: req.startTime,
          endpoint: req.endpoint as EntrySummary["endpoint"],
          rawPath: req.rawPath,
          state: req.state as EntrySummary["state"],
          active: true,
          requestModel: req.model,
          stream: req.stream,
          messageCount: 0,
          durationMs: req.durationMs,
          attemptCount: req.attemptCount,
          currentStrategy: req.currentStrategy,
          queueWaitMs: req.queueWaitMs,
          previewText: "",
          responsePreviewText: "",
        }) satisfies EntrySummary,
    )
})

function openDetail(id: string): void {
  void router.push({ name: "activity-detail", params: { id } })
}

// ── URL ↔ filters sync (deep-link / refresh / share) ──
// keep-alive means onMounted runs once (first visit); the Pinia store retains
// filters across navigation, so this only hydrates on a genuine first load.
let hydrating = true
onMounted(() => {
  const q = route.query
  const patch: Partial<ActivityFilters> = {}
  if (typeof q.search === "string") patch.search = q.search
  if (typeof q.endpoint === "string") patch.endpoint = q.endpoint
  if (typeof q.state === "string") patch.state = q.state as RequestLifecycleState
  if (typeof q.model === "string") patch.model = q.model
  if (typeof q.sessionId === "string") patch.sessionId = q.sessionId
  if (typeof q.pid === "string") {
    const n = Number.parseInt(q.pid, 10)
    if (!Number.isNaN(n)) patch.pid = n
  }
  if (Object.keys(patch).length > 0) {
    Object.assign(store.filters, patch)
    searchInput.value = store.filters.search
    modelInput.value = store.filters.model ?? ""
    pidInput.value = store.filters.pid !== null ? String(store.filters.pid) : ""
    void store.fetchEntries()
  }
  hydrating = false
})

// Reflect filters into the URL query (replace → shareable, no history spam).
// Guarded by route name: this component stays alive (keep-alive) while the user
// is on the DETAIL page, where a store.setFilter (e.g. session drill) would
// otherwise fire this watch and `router.replace` would stamp the query onto the
// detail URL (cross-talk). Only sync when Activity is the active route.
function syncUrlFromFilters(): void {
  if (route.name !== "activity") return
  const f = store.filters
  const query: Record<string, string> = {}
  if (f.search) query.search = f.search
  if (f.endpoint) query.endpoint = f.endpoint
  if (f.state) query.state = f.state
  if (f.model) query.model = f.model
  if (f.sessionId) query.sessionId = f.sessionId
  if (f.pid !== null) query.pid = String(f.pid)
  void router.replace({ query })
}

watch(
  () => ({ ...store.filters }),
  () => {
    if (hydrating) return
    syncUrlFromFilters()
  },
)

// On re-activation (returning from detail, incl. after a session drill that set
// filters while cached), resync the URL so the filtered view stays shareable.
onActivated(() => {
  if (!hydrating) syncUrlFromFilters()
})
</script>

<template>
  <div class="activity-page v-page-root">
    <div class="v-page-scroll">
      <section class="activity-shell px-4 px-md-6 pt-4 pb-6">
        <!-- Toolbar -->
        <div class="page-toolbar">
          <div class="toolbar-copy">
            <div class="toolbar-title">Activity</div>
            <div class="toolbar-meta text-caption text-medium-emphasis">{{ store.total }} total · {{ inflightRows.length }} active</div>
          </div>

          <div class="toolbar-controls">
            <v-text-field
              v-model="searchInput"
              placeholder="Search…"
              prepend-inner-icon="mdi-magnify"
              clearable
              style="min-width: 200px"
            />
            <v-text-field
              v-model="modelInput"
              placeholder="Model"
              clearable
              style="max-width: 150px"
            />
            <v-select
              :model-value="store.filters.endpoint"
              :items="endpointOptions"
              placeholder="Endpoint"
              clearable
              style="max-width: 200px"
              @update:model-value="(v: string | null) => store.setFilter('endpoint', v)"
            />
            <v-select
              :model-value="store.filters.state"
              :items="stateOptions"
              placeholder="State"
              clearable
              style="max-width: 140px"
              @update:model-value="(v: RequestLifecycleState | null) => store.setFilter('state', v)"
            />
            <v-text-field
              v-model="pidInput"
              placeholder="pid"
              type="number"
              clearable
              style="max-width: 92px"
            />
          </div>
        </div>

        <!-- Active filter chips -->
        <div
          v-if="activeFilterChips.length > 0"
          class="filter-chips"
        >
          <v-chip
            v-for="chip in activeFilterChips"
            :key="chip.key"
            size="x-small"
            closable
            variant="tonal"
            @click:close="clearFilter(chip.key)"
          >
            {{ chip.label }}
          </v-chip>
          <v-btn
            variant="text"
            size="x-small"
            @click="clearAllFilters"
            >Clear all</v-btn
          >
        </div>

        <!-- In-flight requests -->
        <v-sheet
          v-if="inflightRows.length > 0"
          class="panel"
          color="surface"
          border
        >
          <div class="section-label">In-flight ({{ inflightRows.length }})</div>
          <div class="table-wrap">
            <v-table
              density="compact"
              hover
              class="activity-table bg-transparent"
            >
              <thead>
                <tr>
                  <th class="table-head col-status"></th>
                  <th class="table-head">Time</th>
                  <th class="table-head">Model</th>
                  <th class="table-head">Endpoint</th>
                  <th class="table-head">State</th>
                  <th class="table-head text-right">Dur</th>
                  <th class="table-head text-right">In</th>
                  <th class="table-head text-right">Out</th>
                  <th class="table-head text-right">Cache</th>
                  <th class="table-head">Detail</th>
                </tr>
              </thead>
              <tbody>
                <ActivityRow
                  v-for="entry in inflightRows"
                  :key="entry.id"
                  :entry="entry"
                  @open="openDetail"
                />
              </tbody>
            </v-table>
          </div>
        </v-sheet>

        <!-- History (cursor-paginated, filtered) -->
        <v-sheet
          class="panel"
          color="surface"
          border
        >
          <div
            v-if="store.loading && store.entries.length === 0"
            class="state-shell"
          >
            <v-progress-circular
              indeterminate
              color="primary"
            />
          </div>

          <div
            v-else-if="store.error"
            class="state-shell"
          >
            <v-icon
              icon="mdi-alert-circle-outline"
              size="36"
              color="error"
              class="mb-2"
            />
            <span class="text-medium-emphasis">{{ store.error }}</span>
          </div>

          <div
            v-else-if="store.entries.length === 0"
            class="state-shell flex-column"
          >
            <span class="text-medium-emphasis mb-2">No matching requests</span>
            <v-btn
              v-if="activeFilterChips.length > 0"
              variant="tonal"
              size="small"
              @click="clearAllFilters"
              >Clear filters</v-btn
            >
          </div>

          <div
            v-else
            class="table-wrap"
          >
            <v-table
              density="compact"
              fixed-header
              hover
              class="activity-table bg-transparent"
            >
              <thead>
                <tr>
                  <th class="table-head col-status"></th>
                  <th class="table-head">Time</th>
                  <th class="table-head">Model</th>
                  <th class="table-head">Endpoint</th>
                  <th class="table-head">State</th>
                  <th class="table-head text-right">Dur</th>
                  <th class="table-head text-right">In</th>
                  <th class="table-head text-right">Out</th>
                  <th class="table-head text-right">Cache</th>
                  <th class="table-head">Preview</th>
                </tr>
              </thead>
              <tbody>
                <ActivityRow
                  v-for="entry in store.entries"
                  :key="entry.id"
                  :entry="entry"
                  :selected="entry.id === store.selectedEntry?.id"
                  @open="openDetail"
                />
              </tbody>
            </v-table>
          </div>

          <div
            v-if="store.total > 0"
            class="pagination-bar"
          >
            <v-btn
              variant="text"
              size="small"
              :disabled="!store.prevCursor"
              @click="store.loadPrev()"
            >
              <v-icon icon="mdi-chevron-left" />
              Newer
            </v-btn>
            <span class="text-caption text-medium-emphasis font-mono">{{ store.entries.length }} of {{ store.total }}</span>
            <v-btn
              variant="text"
              size="small"
              :disabled="!store.nextCursor"
              @click="store.loadNext()"
            >
              Older
              <v-icon icon="mdi-chevron-right" />
            </v-btn>
          </div>
        </v-sheet>
      </section>
    </div>
  </div>
</template>

<style scoped>
.activity-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-toolbar {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  font-size: 1.125rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
}

.toolbar-meta {
  margin-top: 4px;
}

.toolbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: end;
}

.filter-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.panel {
  padding: 0;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.section-label {
  padding: 8px 12px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(var(--v-theme-secondary));
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.table-wrap {
  overflow-x: auto;
}

.activity-table :deep(th) {
  padding: 6px 8px;
}

.table-head {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
}

.col-status {
  width: 28px;
}

.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.state-shell {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state-shell.flex-column {
  flex-direction: column;
}

@media (max-width: 780px) {
  .page-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .toolbar-controls {
    justify-content: start;
  }
}
</style>
