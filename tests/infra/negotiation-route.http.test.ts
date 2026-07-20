import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  markAnthropicFeatureUnsupported,
} from "~/lib/anthropic/feature-negotiation"
import { NEGOTIATION_CATEGORIES } from "~/lib/anthropic/negotiation-lifecycle"
import { negotiationRoutes } from "~/routes/negotiation/route"

describe("/api/negotiation", () => {
  beforeEach(() => clearAnthropicFeatureNegotiationForTests())

  test("GET / returns grouped snapshot", async () => {
    markAnthropicFeatureUnsupported("m", "context_management")
    const res = await negotiationRoutes.request("/")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { categories: Array<unknown> }
    // One group per category — pin to the SSOT list so adding a category never drifts this oracle.
    expect(body.categories.length).toBe(NEGOTIATION_CATEGORIES.length)
  })

  test("POST /renew revives an entry", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const snap = (await (await negotiationRoutes.request("/")).json()) as {
      categories: Array<{ category: string; entries: Array<{ key: string; value: string }> }>
    }
    const e = snap.categories.find((c) => c.category === "features")!.entries[0]
    const res = await negotiationRoutes.request("/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: e.key, value: e.value }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  test("POST /expire keeps the row as manually_expired", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const snap = (await (await negotiationRoutes.request("/")).json()) as {
      categories: Array<{ category: string; entries: Array<{ key: string; value: string }> }>
    }
    const e = snap.categories.find((c) => c.category === "features")!.entries[0]
    const res = await negotiationRoutes.request("/expire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: e.key, value: e.value }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { entry: { status: string } }).entry.status).toBe("manually_expired")
  })

  test("POST /pin toggles pinned", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const snap = (await (await negotiationRoutes.request("/")).json()) as {
      categories: Array<{ category: string; entries: Array<{ key: string; value: string }> }>
    }
    const e = snap.categories.find((c) => c.category === "features")!.entries[0]
    const res = await negotiationRoutes.request("/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: e.key, value: e.value, pinned: true }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { entry: { status: string } }).entry.status).toBe("pinned")
  })

  test("POST /entry/delete missing → 404", async () => {
    const res = await negotiationRoutes.request("/entry/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: "nope", value: "nope" }),
    })
    expect(res.status).toBe(404)
  })

  test("POST /renew with invalid body → 400", async () => {
    const res = await negotiationRoutes.request("/renew", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "not_a_category", key: "x", value: "y" }),
    })
    expect(res.status).toBe(400)
  })

  test("GET /export returns v2 dataset with attachment header", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const res = await negotiationRoutes.request("/export")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toContain("attachment")
    expect(((await res.json()) as { version: number }).version).toBe(2)
  })
})
