import {
  //
  describe,
  expect,
  test,
} from "vitest"
import {
  //
  defineComponent,
  h,
} from "vue"
import {
  //
  createMemoryHistory,
  createRouter,
  type Router,
} from "vue-router"

import { routes } from "@/router"

const Stub = defineComponent({ name: "RouteStub", render: () => h("div") })

// Build a router with the REAL route table but in-memory history + stubbed page
// components (so navigation doesn't load heavy .vue pages).
function testRouter(): Router {
  const testRoutes = routes.map((r) => ("component" in r && r.component ? { ...r, component: Stub } : r))
  return createRouter({ history: createMemoryHistory(), routes: testRoutes })
}

describe("router table", () => {
  test("/ redirects to dashboard", async () => {
    const r = testRouter()
    await r.push("/")
    expect(r.currentRoute.value.name).toBe("dashboard")
  })

  test("/activity/:id resolves with the id param + name activity-detail", async () => {
    const r = testRouter()
    await r.push("/activity/req_123")
    expect(r.currentRoute.value.name).toBe("activity-detail")
    expect(r.currentRoute.value.params.id).toBe("req_123")
  })

  test("object-form nav {name:'activity-detail', params:{id}} → /activity/:id (the form used by openDetail/prev-next)", async () => {
    const r = testRouter()
    await r.push({ name: "activity-detail", params: { id: "abc" } })
    expect(r.currentRoute.value.path).toBe("/activity/abc")
    expect(r.currentRoute.value.params.id).toBe("abc")
  })

  test("named 'activity' route → /activity", async () => {
    const r = testRouter()
    await r.push({ name: "activity" })
    expect(r.currentRoute.value.path).toBe("/activity")
  })

  test("legacy /v/history/:id → activity-detail, preserving id + query", async () => {
    const r = testRouter()
    await r.push("/v/history/req_9?foo=bar")
    expect(r.currentRoute.value.name).toBe("activity-detail")
    expect(r.currentRoute.value.params.id).toBe("req_9")
    expect(r.currentRoute.value.query.foo).toBe("bar")
  })

  test("legacy path redirects", async () => {
    for (const [from, expected] of [
      ["/history", "/activity"],
      ["/logs", "/activity"],
      ["/usage", "/dashboard"],
      ["/v/models", "/models"],
      ["/v/config", "/config"],
    ] as const) {
      const r = testRouter()
      await r.push(from)
      expect(r.currentRoute.value.path).toBe(expected)
    }
  })

  test("unknown path → 404 catch-all → dashboard", async () => {
    const r = testRouter()
    await r.push("/totally/unknown/path")
    expect(r.currentRoute.value.path).toBe("/dashboard")
  })

  test("query (?state=failed) survives on the activity route", async () => {
    const r = testRouter()
    await r.push({ path: "/activity", query: { state: "failed", model: "opus" } })
    expect(r.currentRoute.value.query).toMatchObject({ state: "failed", model: "opus" })
  })

  test("prev/next via replace keeps the back-stack clean (one Back returns to list)", async () => {
    const r = testRouter()
    await r.push("/activity")
    await r.push({ name: "activity-detail", params: { id: "a" } }) // opening detail = push
    await r.replace({ name: "activity-detail", params: { id: "b" } }) // next = replace
    await r.replace({ name: "activity-detail", params: { id: "c" } }) // next = replace
    expect(r.currentRoute.value.params.id).toBe("c")
    r.back()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.currentRoute.value.path).toBe("/activity") // not /activity/b or /activity/a
  })
})
