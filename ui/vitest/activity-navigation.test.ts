import {
  //
  flushPromises,
  mount,
} from "@vue/test-utils"
import {
  //
  createPinia,
  setActivePinia,
} from "pinia"
import {
  //
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import { ref } from "vue"
import {
  //
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router"

import type { EntrySummary } from "@/types"

// Mock the API so the real store can fetch deterministic entries.
const sampleEntries: Array<EntrySummary> = [
  {
    id: "req_a",
    startedAt: 3,
    endpoint: "anthropic-messages",
    messageCount: 0,
    previewText: "first",
    searchText: "",
    state: "completed",
    responseModel: "opus",
  },
  {
    id: "req_b",
    startedAt: 2,
    endpoint: "anthropic-messages",
    messageCount: 0,
    previewText: "second",
    searchText: "",
    state: "failed",
    responseModel: "sonnet",
  },
]
vi.mock("@/api/http", () => ({
  api: {
    fetchEntries: vi.fn(() => Promise.resolve({ entries: sampleEntries, total: 2, nextCursor: null, prevCursor: null })),
    fetchStats: vi.fn(() => Promise.resolve(null)),
    fetchSessions: vi.fn(() => Promise.resolve({ sessions: [], total: 0 })),
    fetchEntry: vi.fn(() => Promise.resolve({})),
  },
}))
// Dashboard status (in-flight requests) — empty.
vi.mock("@/composables/useDashboardStatus", () => ({ useDashboardStatus: () => ({ activeRequests: ref([]) }) }))
// WS client is a no-op in tests.
vi.mock("@/api/ws", () => ({
  WSClient: class {
    init() {}
    destroy() {}
  },
}))

import { useHistoryStore } from "@/composables/useHistoryStore"
import VActivityPage from "@/pages/vuetify/VActivityPage.vue"
import { routes } from "@/router"

import {
  //
  vuetifyComponentStubs,
} from "./helpers/mount"

const VTableStub = { name: "VTable", template: "<table><slot /></table>" }
const VSheetStub = { name: "VSheet", template: "<div><slot /></div>" }
const Stub = { template: "<div />" }

function makeRouter(): Router {
  const r = routes.map((rt) => ("component" in rt && rt.component ? { ...rt, component: Stub } : rt))
  return createRouter({ history: createMemoryHistory(), routes: r })
}

async function mountActivity(router: Router) {
  await router.push("/activity")
  await router.isReady()
  const w = mount(VActivityPage, {
    global: {
      plugins: [router],
      components: { ...vuetifyComponentStubs, VTable: VTableStub, VSheet: VSheetStub },
    },
  })
  // let the store's fetch settle
  await new Promise((res) => setTimeout(res, 0))
  await w.vm.$nextTick()
  return w
}

describe("Activity navigation integration", () => {
  beforeEach(() => setActivePinia(createPinia()))

  test("list renders rows from the store after fetch", async () => {
    const store = useHistoryStore()
    await store.fetchEntries()
    const w = await mountActivity(makeRouter())
    expect(w.text()).toContain("opus")
    expect(w.text()).toContain("sonnet")
  })

  test("clicking a row navigates to /activity/:id (object-form openDetail)", async () => {
    const store = useHistoryStore()
    await store.fetchEntries()
    const router = makeRouter()
    const w = await mountActivity(router)
    const row = w.find("tr.activity-row")
    expect(row.exists()).toBe(true)
    await row.trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.name).toBe("activity-detail")
    expect(router.currentRoute.value.params.id).toBe("req_a")
  })
})
