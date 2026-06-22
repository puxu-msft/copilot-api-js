/**
 * Guards the OpenAPI 3.1 document + Scalar UI for the WHOLE API surface.
 *
 * Locks: (1) /openapi.json is a valid 3.1 doc versioned to package.json;
 * (2) DRIFT GUARD — every real HTTP route on the app is either documented in the
 * spec or in an explicit, reasoned exclusion set (so a newly-added route can't be
 * silently left undocumented — the failure mode the old hand-picked allowlist
 * missed); (3) documenting the plain-Hono routes did NOT break them.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import packageJson from "../../package.json"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

useIsolatedRuntime()

const app = createFullTestApp()

interface Spec {
  openapi: string
  info: { version: string }
  paths: Record<string, Record<string, unknown>>
}

async function getSpec(): Promise<Spec> {
  const res = await app.request("/openapi.json")
  expect(res.status).toBe(200)
  return res.json() as Promise<Spec>
}

/**
 * Map a real Hono (method, path) to the spec path it MUST appear as, or `null`
 * when intentionally not individually documented (with the reason inline).
 */
function canonicalSpecPath(rawPath: string): string | null {
  let p = rawPath.replace(/\/+$/, "") || "/"

  // The doc endpoints themselves + static UI + the /history → /ui redirect.
  if (p === "/openapi.json" || p === "/docs" || p === "/history") return null
  if (p === "/ui" || p.startsWith("/ui/")) return null
  // Gemini is one catch-all route (:modelWithMethod) but documented as 3 explicit
  // `{model}:<method>` paths — the catch-all itself is intentionally not a spec key.
  if (p === "/v1beta/models/:modelWithMethod") return null

  // Collapse OpenAI prefix aliases (no-prefix / /openai/v1) to the canonical /v1.
  p = p.replace(/^\/openai\/v1\//, "/v1/")
  if (/^\/(?:chat\/completions|models|embeddings|responses)(?:\/|$)/.test(p)) p = "/v1" + p
  // Anthropic /anthropic/v1/messages alias → canonical /v1/messages.
  p = p.replace(/^\/anthropic\/v1\/messages/, "/v1/messages")

  // Hono `:param` → OpenAPI `{param}`.
  return p.replaceAll(/:(\w+)/g, "{$1}")
}

describe("OpenAPI document — whole surface", () => {
  test("serves a 3.1 doc versioned to package.json", async () => {
    const spec = await getSpec()
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.info.version).toBe(packageJson.version)
  })

  test("DRIFT GUARD: every real HTTP route is documented or explicitly excluded", async () => {
    const { paths } = await getSpec()
    const missing: Array<string> = []
    const seen = new Set<string>()
    for (const route of app.routes) {
      if (route.method === "ALL") continue // middleware, not an endpoint
      const key = `${route.method} ${route.path}`
      if (seen.has(key)) continue
      seen.add(key)
      const specPath = canonicalSpecPath(route.path)
      if (specPath === null) continue // intentionally excluded (see canonicalSpecPath)
      const op = paths[specPath]?.[route.method.toLowerCase()]
      if (op === undefined) missing.push(`${route.method} ${route.path} → expected spec path ${specPath}`)
    }
    expect(missing, `undocumented routes (add to openapi-compat.ts or exclude in canonicalSpecPath):\n${missing.join("\n")}`).toEqual([])
  })

  test("spot-check key endpoints across every family are present", async () => {
    const { paths } = await getSpec()
    for (const p of [
      "/api/status",
      "/api/config/yaml",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
      "/anthropic/v1/models",
      "/v1beta/models/{model}:generateContent",
      "/openai/deployments/{deployment}/chat/completions",
      "/history/api/entries",
      "/history/api/entries/{id}/pin",
      "/api/debug/dry-run-pipeline",
      "/health",
    ]) {
      expect(paths[p], `expected ${p} in spec`).toBeDefined()
    }
  })

  test("config/yaml documents both GET and PUT", async () => {
    const { paths } = await getSpec()
    expect(paths["/api/config/yaml"].get).toBeDefined()
    expect(paths["/api/config/yaml"].put).toBeDefined()
  })

  test("documenting plain-Hono routes did NOT break them (handlers still respond)", async () => {
    const entries = await app.request("/history/api/entries")
    expect(entries.status).toBe(200)
    const pipeline = await app.request("/api/debug/dry-run-pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(pipeline.status).toBeGreaterThanOrEqual(400)
    expect(pipeline.status).toBeLessThan(500)
    expect(await pipeline.text()).not.toContain("Not Found")
  })

  test("serves the Scalar reference UI at /docs", async () => {
    const res = await app.request("/docs")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type") ?? "").toContain("text/html")
  })
})
