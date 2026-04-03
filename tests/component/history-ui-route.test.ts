import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { historyRoutes } from "~/routes/history/route"
import { createUiRoutes, normalizeExternalUiUrl } from "~/routes/ui/route"

const app = new Hono()
app.route("/history", historyRoutes)
app.route("/ui", createUiRoutes())
const originalFetch = globalThis.fetch

describe("history UI routes", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("GET /history redirects to the Activity landing route", async () => {
    const res = await app.request("http://localhost/history")

    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/ui#/v/activity")
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

  test("normalizeExternalUiUrl accepts only absolute http(s) URLs without query/hash", () => {
    expect(normalizeExternalUiUrl("http://localhost:5173/")).toBe("http://localhost:5173")
    expect(normalizeExternalUiUrl("https://example.com/ui/")).toBe("https://example.com/ui")
    expect(() => normalizeExternalUiUrl("ws://localhost:5173")).toThrow("Unsupported external UI URL protocol")
    expect(() => normalizeExternalUiUrl("http://localhost:5173/?v=1")).toThrow(
      "--external-ui-url must not include query parameters or hash fragments",
    )
  })

  test("external /ui proxy rewrites Vite HTML and JS paths but preserves backend API roots", async () => {
    const externalUiApp = new Hono()
    externalUiApp.get("/", () =>
      new Response(
        '<script type="module" src="/@vite/client"></script><script type="module" src="/src/main.ts?t=1"></script>',
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ))
    externalUiApp.get("/src/main.ts", () =>
      new Response(
        'import "/@fs/work/node_modules/vue.js"; import "/src/App.vue"; fetch("/api/status"); import "/models?detail=true";',
        { headers: { "Content-Type": "application/javascript" } },
      ))

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url)

      if (url.origin === "http://external-ui.test") {
        return externalUiApp.request(url.toString(), init)
      }
      return originalFetch(input as Parameters<typeof fetch>[0], init)
    }) as unknown as typeof fetch

    const proxyApp = new Hono()
    proxyApp.route("/ui", createUiRoutes({ externalUiUrl: "http://external-ui.test" }))

    const htmlRes = await proxyApp.request("http://localhost/ui")
    expect(htmlRes.status).toBe(200)
    const html = await htmlRes.text()
    expect(html).toContain('/ui/@vite/client')
    expect(html).toContain('/ui/src/main.ts?t=1')

    const jsRes = await proxyApp.request("http://localhost/ui/src/main.ts")
    expect(jsRes.status).toBe(200)
    const js = await jsRes.text()
    expect(js).toContain('import "/ui/@fs/work/node_modules/vue.js"')
    expect(js).toContain('import "/ui/src/App.vue"')
    expect(js).toContain('fetch("/api/status")')
    expect(js).toContain('import "/models?detail=true"')
  })

  test("external /ui proxy preserves JavaScript regex literals while still rewriting Vite paths in strings", async () => {
    const externalUiApp = new Hono()
    externalUiApp.get("/@vite/client", () =>
      new Response(
        [
          'const currentScriptHost = currentScriptHostURL.pathname.replace(/@vite\\/client$/, "");',
          'import "/@fs/work/node_modules/vite/dist/client/env.mjs";',
          'const direct = "/@vite/client";',
          'const absolute = "http://external-ui.test/@vite/client";',
        ].join("\n"),
        { headers: { "Content-Type": "application/javascript" } },
      ))

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url)

      if (url.origin === "http://external-ui.test") {
        return externalUiApp.request(url.toString(), init)
      }
      return originalFetch(input as Parameters<typeof fetch>[0], init)
    }) as unknown as typeof fetch

    const proxyApp = new Hono()
    proxyApp.route("/ui", createUiRoutes({ externalUiUrl: "http://external-ui.test" }))

    const jsRes = await proxyApp.request("http://localhost/ui/@vite/client")
    expect(jsRes.status).toBe(200)
    const js = await jsRes.text()

    expect(js).toContain('pathname.replace(/@vite\\/client$/, "")')
    expect(js).toContain('import "/ui/@fs/work/node_modules/vite/dist/client/env.mjs"')
    expect(js).toContain('const direct = "/ui/@vite/client"')
    expect(js).toContain('const absolute = "/ui/@vite/client"')
  })
})
