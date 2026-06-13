import {
  //
  flushPromises,
  mount,
} from "@vue/test-utils"
import {
  //
  createPinia,
  setActivePinia,
  type Pinia,
} from "pinia"
import {
  //
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import {
  //
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router"

import type {
  //
  EntrySummary,
  HistoryEntry,
} from "@/types"

function fullEntry(id: string): HistoryEntry {
  return {
    id,
    sessionId: "sess_1",
    endpoint: "anthropic-messages",
    startedAt: 1,
    state: "completed",
    durationMs: 100,
    inboundRequest: { model: "opus", messages: [{ role: "user", content: "hi" }] },
    outboundResponse: { success: true, model: "opus", usage: { input_tokens: 1, output_tokens: 1 }, content: { role: "assistant", content: "ok" } },
  } as HistoryEntry
}
const summaries: Array<EntrySummary> = [
  { id: "req_a", startedAt: 3, endpoint: "anthropic-messages", messageCount: 1, previewText: "", searchText: "" },
  { id: "req_b", startedAt: 2, endpoint: "anthropic-messages", messageCount: 1, previewText: "", searchText: "" },
  { id: "req_c", startedAt: 1, endpoint: "anthropic-messages", messageCount: 1, previewText: "", searchText: "" },
]

// Mock the API (real store + real component tree exercise the actual integration).
const fetchEntry = vi.fn((id: string) => Promise.resolve(fullEntry(id)))
vi.mock("@/api/http", () => ({
  api: {
    fetchEntries: vi.fn(() => Promise.resolve({ entries: summaries, total: 3, nextCursor: null, prevCursor: null })),
    fetchStats: vi.fn(() => Promise.resolve(null)),
    fetchSessions: vi.fn(() => Promise.resolve({ sessions: [], total: 0 })),
    fetchEntry: (id: string) => fetchEntry(id),
  },
}))
vi.mock("@/api/ws", () => ({
  WSClient: class {
    init() {}
    destroy() {}
  },
}))

import { useHistoryStore } from "@/composables/useHistoryStore"
import VDetailPage from "@/pages/vuetify/VDetailPage.vue"
import { routes } from "@/router"

import {
  //
  vuetifyComponentStubs,
} from "./helpers/mount"

const Stub = { template: "<div />" }
let pinia: Pinia

function makeRouter(): Router {
  const r = routes.map((rt) => ("component" in rt && rt.component ? { ...rt, component: Stub } : rt))
  return createRouter({ history: createMemoryHistory(), routes: r })
}

async function mountDetail(router: Router) {
  await router.push("/activity/req_b")
  await router.isReady()
  const w = mount(VDetailPage, {
    global: {
      plugins: [router, pinia],
      // Keep DetailPanel + stages + StageTabs REAL; stub heavy leaf renderers + Vuetify chrome not in the helper.
      components: {
        ...vuetifyComponentStubs,
        VTabs: { template: "<div><slot /></div>" },
        VTab: { template: "<button><slot /></button>" },
        VTable: { template: "<table><slot /></table>" },
        VSheet: Stub,
      },
      stubs: {
        ContentRenderer: true,
        RawJsonModal: true,
        JsonViewerSurface: true,
        SseEventsSection: true,
        AttemptsTimeline: true,
        TocTree: true,
        VDialog: true,
      },
    },
  })
  await flushPromises()
  return w
}

describe("VDetailPage integration", () => {
  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    fetchEntry.mockClear()
    // Seed the list so prev/next has neighbours.
    await useHistoryStore().fetchEntries()
  })

  test("mounts the real detail tree without runtime error + shows the model", async () => {
    const w = await mountDetail(makeRouter())
    expect(w.text()).toContain("opus")
  })

  test("loads the entry for the route id via selectEntry", async () => {
    await mountDetail(makeRouter())
    expect(fetchEntry).toHaveBeenCalledWith("req_b")
  })

  test("pressing j (next) REPLACES the route to the adjacent entry", async () => {
    const router = makeRouter()
    await mountDetail(router)
    // req_b is index 1 in [a,b,c] → next = req_c
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }))
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe("req_c")
  })

  test("pressing k (prev) goes to the previous entry", async () => {
    const router = makeRouter()
    await mountDetail(router)
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }))
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe("req_a")
  })

  test("Session button drills into the session: sets sessionId filter + navigates to Activity", async () => {
    const router = makeRouter()
    const w = await mountDetail(router)
    const store = useHistoryStore()
    const sessionBtn = w.findAll("button").find((b) => b.text().includes("Session"))
    expect(sessionBtn).toBeDefined()
    await sessionBtn!.trigger("click")
    await flushPromises()
    expect(store.filters.sessionId).toBe("sess_1")
    expect(router.currentRoute.value.path).toBe("/activity")
  })

  test("Escape returns to the Activity list", async () => {
    const router = makeRouter()
    await mountDetail(router)
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe("/activity")
  })
})
