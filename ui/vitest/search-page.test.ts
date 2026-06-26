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
  SearchResult,
  SearchResultRow,
} from "@/types"

function makeRow(id: string, hash?: string): SearchResultRow {
  return {
    source: "inbound",
    hash,
    ownerReqId: id,
    snippet: `hello NEEDLE world (${id})`,
    summary: {
      id,
      startedAt: 1,
      endpoint: "anthropic-messages",
      state: "completed",
      messageCount: 1,
      requestModel: "opus",
      previewText: "",
    } as SearchResultRow["summary"],
  }
}

const search = vi.fn((): Promise<SearchResult> => Promise.resolve({ rows: [makeRow("req_a", "h1")], nextCursor: null, partial: false }))
vi.mock("@/api/http", () => ({
  api: { search: () => search(), searchContains: vi.fn(() => Promise.resolve({ hash: "h1", reqIds: ["req_a", "req_b"] })) },
  ApiError: class extends Error {},
}))

import { useSearchStore } from "@/composables/useSearchStore"
import VSearchPage from "@/pages/vuetify/VSearchPage.vue"
import { routes } from "@/router"

import {
  //
  vuetifyComponentStubs,
} from "./helpers/mount"

const Stub = { template: "<div><slot /></div>" }
let pinia: Pinia

function makeRouter(): Router {
  const r = routes.map((rt) => ("component" in rt && rt.component ? { ...rt, component: Stub } : rt))
  return createRouter({ history: createMemoryHistory(), routes: r })
}

async function mountSearch(router: Router) {
  await router.push("/search")
  await router.isReady()
  const w = mount(VSearchPage, {
    global: {
      plugins: [router, pinia],
      components: { ...vuetifyComponentStubs, VSheet: Stub },
    },
  })
  await flushPromises()
  return w
}

describe("VSearchPage integration", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    search.mockClear()
  })

  test("renders the 5 facet labels", async () => {
    const w = await mountSearch(makeRouter())
    const text = w.text()
    for (const label of ["Messages", "Req rewrites", "Resp rewrites", "Req headers", "Resp headers"]) {
      expect(text).toContain(label)
    }
  })

  test("shows the empty prompt before any search", async () => {
    const w = await mountSearch(makeRouter())
    expect(w.text()).toContain("Type to search")
    expect(search).not.toHaveBeenCalled()
  })

  test("renders a result snippet (with <mark> highlight) after a search", async () => {
    const w = await mountSearch(makeRouter())
    const store = useSearchStore()
    store.query = "NEEDLE"
    await store.runSearch()
    await flushPromises()
    expect(search).toHaveBeenCalled()
    expect(w.text()).toContain("hello NEEDLE world")
    // highlightSearch wraps the matched needle in <mark>.
    expect(w.html()).toContain("<mark")
  })

  test("escapes raw HTML in the snippet (no XSS via v-html)", async () => {
    search.mockResolvedValueOnce({
      rows: [
        {
          source: "inbound",
          hash: "h",
          ownerReqId: "x",
          snippet: "<script>alert(1)</script> NEEDLE",
          summary: {
            id: "x",
            startedAt: 1,
            endpoint: "anthropic-messages",
            state: "completed",
            messageCount: 1,
            previewText: "",
          } as SearchResultRow["summary"],
        },
      ],
      nextCursor: null,
      partial: false,
    })
    const w = await mountSearch(makeRouter())
    const store = useSearchStore()
    store.query = "NEEDLE"
    await store.runSearch()
    await flushPromises()
    const html = w.html()
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
  })
})
