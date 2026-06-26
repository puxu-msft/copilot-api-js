<script setup lang="ts">
import { watchDebounced } from "@vueuse/core"
import {
  //
  computed,
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
  SearchResultRow,
  SearchSource,
} from "@/types"

import { useSearchStore } from "@/composables/useSearchStore"
import {
  //
  formatTime,
  highlightSearch,
} from "@/utils/formatters"
import { statusMeta } from "@/utils/status-meta"

defineOptions({ name: "VSearchPage" })

const router = useRouter()
const route = useRoute()
const store = useSearchStore()

/** The 5 facets with display label + accent color (search-page is intentional, not a default list). */
const sourceOptions: Array<{ value: SearchSource; label: string; icon: string; color: string }> = [
  { value: "inbound", label: "Messages", icon: "mdi-message-text-outline", color: "primary" },
  { value: "rewrites-req", label: "Req rewrites", icon: "mdi-arrow-up-bold-outline", color: "info" },
  { value: "rewrites-resp", label: "Resp rewrites", icon: "mdi-arrow-down-bold-outline", color: "purple" },
  { value: "req-headers", label: "Req headers", icon: "mdi-format-list-bulleted", color: "secondary" },
  { value: "resp-headers", label: "Resp headers", icon: "mdi-format-list-bulleted-type", color: "secondary" },
]

const endpointOptions = [
  { title: "Anthropic Messages", value: "anthropic-messages" },
  { title: "OpenAI Chat Completions", value: "openai-chat-completions" },
  { title: "OpenAI Responses", value: "openai-responses" },
  { title: "Gemini Generate Content", value: "gemini-generate-content" },
]

const queryInput = ref(store.query)
const modelInput = ref(store.filters.model)
const sessionInput = ref(store.filters.sessionId)

// Debounced text inputs → store + re-search (deep full-text search is "press to search"
// in spirit, but a 350ms debounce keeps it responsive without a button).
watchDebounced(
  queryInput,
  (v) => {
    store.query = v
    void store.runSearch()
  },
  { debounce: 350 },
)
watchDebounced(
  modelInput,
  (v) => {
    store.filters.model = v
    if (store.query.trim()) void store.runSearch()
  },
  { debounce: 350 },
)
watchDebounced(
  sessionInput,
  (v) => {
    store.filters.sessionId = v
    if (store.query.trim()) void store.runSearch()
  },
  { debounce: 350 },
)

function onEndpoint(v: string | null): void {
  store.filters.endpoint = v
  if (store.query.trim()) void store.runSearch()
}

const builtPctLabel = computed(() => (store.builtPct === undefined ? "" : `${Math.round(store.builtPct * 100)}%`))

const expanded = ref<Set<string>>(new Set())

async function toggleContains(row: SearchResultRow): Promise<void> {
  if (!row.hash) return
  if (expanded.value.has(row.hash)) {
    expanded.value.delete(row.hash)
    expanded.value = new Set(expanded.value)
    return
  }
  await store.fetchContains(row.hash)
  expanded.value = new Set(expanded.value).add(row.hash)
}

function openDetail(id: string): void {
  void router.push({ name: "activity-detail", params: { id } })
}

function renderSnippet(row: SearchResultRow): string {
  return highlightSearch(row.snippet, store.query)
}

// Deep-link: ?q= & ?source= hydrate on first load.
let hydrating = true
onMounted(() => {
  const q = route.query
  if (typeof q.source === "string" && sourceOptions.some((o) => o.value === q.source)) {
    store.source = q.source as SearchSource
  }
  if (typeof q.q === "string" && q.q.length > 0) {
    queryInput.value = q.q
    store.query = q.q
    void store.runSearch()
  }
  hydrating = false
})

// Reflect query/source into the URL (shareable; replace → no history spam). Guarded
// by route name so a store mutation during a Search→Detail transition doesn't stamp
// the query onto the wrong URL; skipped during hydration (which set the values FROM
// the URL — no need to write them straight back).
watch(
  () => [store.query, store.source] as const,
  ([q, src]) => {
    if (hydrating || route.name !== "search") return
    const query: Record<string, string> = {}
    if (q) query.q = q
    if (src !== "inbound") query.source = src
    void router.replace({ query })
  },
)
</script>

<template>
  <div class="search-page v-page-root">
    <div class="v-page-scroll">
      <section class="search-shell px-4 px-md-6 pt-4 pb-6">
        <!-- Toolbar -->
        <div class="page-toolbar">
          <div class="toolbar-copy">
            <div class="toolbar-title">Search</div>
            <div class="toolbar-meta text-caption text-medium-emphasis">
              Content-addressed full-text · {{ store.hasSearched ? `${store.rows.length} result${store.rows.length === 1 ? "" : "s"}` : "5 facets" }}
            </div>
          </div>

          <div class="toolbar-controls">
            <v-text-field
              v-model="queryInput"
              placeholder="Search history…"
              prepend-inner-icon="mdi-magnify"
              clearable
              autofocus
              style="min-width: 260px"
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
              @update:model-value="onEndpoint"
            />
            <v-text-field
              v-model="sessionInput"
              placeholder="Session"
              clearable
              style="max-width: 150px"
            />
          </div>
        </div>

        <!-- Facet switcher -->
        <v-btn-toggle
          :model-value="store.source"
          mandatory
          density="compact"
          variant="outlined"
          divided
          class="facet-toggle"
          @update:model-value="(v: SearchSource) => store.setSource(v)"
        >
          <v-btn
            v-for="opt in sourceOptions"
            :key="opt.value"
            :value="opt.value"
            size="small"
          >
            <v-icon
              :icon="opt.icon"
              size="x-small"
              start
            />
            {{ opt.label }}
          </v-btn>
        </v-btn-toggle>

        <!-- Partial-index banner -->
        <v-alert
          v-if="store.partial"
          type="info"
          variant="tonal"
          density="compact"
          icon="mdi-progress-clock"
        >
          Indexing history{{ builtPctLabel ? ` — ${builtPctLabel} built` : "" }}. Message results are partial until the backfill completes.
        </v-alert>

        <!-- Results -->
        <v-sheet
          class="panel"
          color="surface"
          border
        >
          <div
            v-if="store.loading && store.rows.length === 0"
            class="state-shell"
          >
            <v-progress-circular
              indeterminate
              color="primary"
            />
          </div>

          <div
            v-else-if="store.error"
            class="state-shell flex-column"
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
            v-else-if="!store.hasSearched"
            class="state-shell flex-column"
          >
            <v-icon
              icon="mdi-text-search"
              size="40"
              class="mb-2 text-disabled"
            />
            <span class="text-medium-emphasis">Type to search across {{ sourceOptions.find((o) => o.value === store.source)?.label.toLowerCase() }}.</span>
          </div>

          <div
            v-else-if="store.rows.length === 0"
            class="state-shell"
          >
            <span class="text-medium-emphasis">No matches for “{{ store.query }}”.</span>
          </div>

          <div
            v-else
            class="result-list"
          >
            <div
              v-for="(row, i) in store.rows"
              :key="(row.hash ?? row.ownerReqId) + ':' + i"
              class="result-row"
            >
              <div class="result-main">
                <div class="result-snippet font-mono">
                  <!-- eslint-disable-next-line vue/no-v-html -- snippet is escaped + <mark>-wrapped by highlightSearch -->
                  <span v-html="renderSnippet(row)" />
                </div>
                <div class="result-meta text-caption text-medium-emphasis">
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="statusMeta(row.summary.state).color"
                    label
                  >
                    {{ statusMeta(row.summary.state).label }}
                  </v-chip>
                  <span class="font-mono">{{ row.summary.requestModel ?? row.summary.responseModel ?? "—" }}</span>
                  <span class="dot">·</span>
                  <span>{{ row.summary.endpoint }}</span>
                  <span class="dot">·</span>
                  <span class="font-mono">{{ formatTime(row.summary.startedAt) }}</span>
                  <button
                    v-if="row.hash"
                    type="button"
                    class="contains-toggle"
                    @click="toggleContains(row)"
                  >
                    <v-icon
                      :icon="expanded.has(row.hash) ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                      size="x-small"
                    />
                    {{ expanded.has(row.hash) ? "hide" : "requests using this message" }}
                  </button>
                </div>

                <!-- Lazy contains expansion (inbound only) -->
                <div
                  v-if="row.hash && expanded.has(row.hash)"
                  class="contains-list"
                >
                  <v-chip
                    v-for="reqId in store.containsCache[row.hash] ?? []"
                    :key="reqId"
                    size="x-small"
                    variant="outlined"
                    class="font-mono"
                    @click="openDetail(reqId)"
                  >
                    {{ reqId }}
                  </v-chip>
                </div>
              </div>

              <v-btn
                icon="mdi-arrow-right"
                size="x-small"
                variant="text"
                :aria-label="`Open request ${row.ownerReqId}`"
                @click="openDetail(row.ownerReqId)"
              />
            </div>
          </div>

          <div
            v-if="store.nextCursor"
            class="pagination-bar"
          >
            <v-btn
              variant="tonal"
              size="small"
              :loading="store.loading"
              @click="store.loadMore()"
            >
              Load more
            </v-btn>
          </div>
        </v-sheet>
      </section>
    </div>
  </div>
</template>

<style scoped>
.search-shell {
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

.facet-toggle {
  align-self: start;
  flex-wrap: wrap;
  height: auto;
}

.panel {
  padding: 0;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.result-list {
  display: flex;
  flex-direction: column;
}

.result-row {
  display: flex;
  align-items: start;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.result-row:last-child {
  border-bottom: none;
}

.result-main {
  flex: 1 1 auto;
  min-width: 0;
}

.result-snippet {
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 6.5em;
  overflow: hidden;
}

.result-snippet :deep(mark) {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border-radius: 0;
  padding: 0 1px;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.result-meta .dot {
  opacity: 0.5;
}

.contains-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  background: none;
  border: none;
  font: inherit;
}

.contains-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.state-shell {
  min-height: 220px;
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
