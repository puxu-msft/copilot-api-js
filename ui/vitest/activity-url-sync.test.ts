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
import { ref } from "vue"
import {
  //
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router"

vi.mock("@/api/http", () => ({
  api: {
    fetchEntries: vi.fn(() => Promise.resolve({ entries: [], total: 0, nextCursor: null, prevCursor: null })),
    fetchStats: vi.fn(() => Promise.resolve(null)),
    fetchSessions: vi.fn(() => Promise.resolve({ sessions: [], total: 0 })),
    fetchEntry: vi.fn(() => Promise.resolve({})),
  },
}))
vi.mock("@/composables/useDashboardStatus", () => ({ useDashboardStatus: () => ({ activeRequests: ref([]) }) }))
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

let pinia: Pinia

function makeRouter(): Router {
  const r = routes.map((rt) => ("component" in rt && rt.component ? { ...rt, component: { template: "<div />" } } : rt))
  return createRouter({ history: createMemoryHistory(), routes: r })
}

async function mountAt(router: Router, loc: string) {
  await router.push(loc)
  await router.isReady()
  const w = mount(VActivityPage, {
    global: { plugins: [router, pinia], components: { ...vuetifyComponentStubs, VTable: VTableStub, VSheet: VSheetStub } },
  })
  await flushPromises()
  return w
}

describe("VActivityPage URL ↔ filters integration", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  test("deep-link query hydrates filters on mount + fetches", async () => {
    const store = useHistoryStore()
    const router = makeRouter()
    await mountAt(router, "/activity?state=failed&model=opus&pid=1234")
    expect(store.filters.state).toBe("failed")
    expect(store.filters.model).toBe("opus")
    expect(store.filters.pid).toBe(1234)
  })

  test("setFilter reflects into the URL query (filters → URL sync)", async () => {
    const store = useHistoryStore()
    const router = makeRouter()
    await mountAt(router, "/activity")
    store.setFilter("state", "aborted")
    await flushPromises()
    expect(router.currentRoute.value.query.state).toBe("aborted")
  })

  test("clearFilters clears the URL query", async () => {
    const store = useHistoryStore()
    const router = makeRouter()
    await mountAt(router, "/activity?state=failed")
    expect(router.currentRoute.value.query.state).toBe("failed")
    store.clearFilters()
    await flushPromises()
    expect(router.currentRoute.value.query.state).toBeUndefined()
  })

  test("does NOT write the URL while on a different (detail) route — no cross-talk", async () => {
    const store = useHistoryStore()
    const router = makeRouter()
    await mountAt(router, "/activity") // VActivityPage mounted + active
    // Simulate the keep-alive scenario: user navigated to a detail page.
    await router.push({ name: "activity-detail", params: { id: "req_x" } })
    await flushPromises()
    // A session drill / any setFilter while on detail must NOT stamp the activity
    // query onto the detail URL.
    store.setFilter("sessionId", "sess_1")
    await flushPromises()
    expect(router.currentRoute.value.name).toBe("activity-detail")
    expect(router.currentRoute.value.query.sessionId).toBeUndefined()
  })
})
