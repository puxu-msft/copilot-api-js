import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { historyRoutes } from "~/routes/history/route"
import { uiRoutes } from "~/routes/ui/route"

const app = new Hono()
app.route("/history", historyRoutes)
app.route("/ui", uiRoutes)

describe("history UI routes", () => {
  test("GET /history is no longer a UI entrypoint", async () => {
    const res = await app.request("http://localhost/history")

    expect(res.status).toBe(404)
  })

  test("GET /ui serves the history UI shell", async () => {
    const res = await app.request("http://localhost/ui")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")

    const body = await res.text()
    expect(body).toContain('<div id="app"></div>')
    expect(body).toContain("/ui/assets/")
  })

  test("GET /ui/assets/* reaches the canonical asset route", async () => {
    const res = await app.request("http://localhost/ui/assets/does-not-exist.js")

    expect(res.status).toBe(404)
  })
})
