/**
 * Guards the OpenAPI 3.1 document + Scalar UI for the WHOLE API surface.
 *
 * Locks: (1) /openapi.json is a valid 3.1 doc versioned to package.json;
 * (2) the management endpoints (precise schemas) AND the compat / history /
 * diagnostic endpoints (simple schemas via registerPath) all appear with correct
 * paths; (3) documenting the plain-Hono routes did NOT break them — history REST
 * and the dry-run-pipeline inspector still respond (handlers untouched).
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

async function getSpec(): Promise<{ openapi: string; info: { version: string }; paths: Record<string, Record<string, unknown>> }> {
  const res = await app.request("/openapi.json")
  expect(res.status).toBe(200)
  return res.json() as Promise<{ openapi: string; info: { version: string }; paths: Record<string, Record<string, unknown>> }>
}

describe("OpenAPI document — whole surface", () => {
  test("serves a 3.1 doc versioned to package.json", async () => {
    const spec = await getSpec()
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.info.version).toBe(packageJson.version)
  })

  test("includes management endpoints (precise schemas) with correct prefixes", async () => {
    const { paths } = await getSpec()
    for (const p of [
      "/api/status",
      "/api/tokens",
      "/api/config",
      "/api/config/yaml",
      "/api/logs",
      "/api/models",
      "/api/models/{model}",
      "/api/debug/dry-run-truncate",
    ]) {
      expect(paths[p], `expected ${p} in spec`).toBeDefined()
    }
  })

  test("includes ALL compat + history + diagnostic endpoints (no exclusions)", async () => {
    const { paths } = await getSpec()
    for (const p of [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/responses",
      "/v1/embeddings",
      "/v1/models",
      "/anthropic/v1/models",
      "/v1beta/models/{model}:generateContent",
      "/v1beta/models/{model}:streamGenerateContent",
      "/openai/deployments/{deployment}/chat/completions",
      "/history/api/entries",
      "/history/api/sessions",
      "/api/debug/dry-run-pipeline",
      "/api/event_logging/batch",
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
    // history REST: with history enabled, entries returns 200 (not 404/unrouted)
    const entries = await app.request("/history/api/entries")
    expect(entries.status).toBe(200)
    // dry-run-pipeline: route is live — an empty body is rejected by the handler
    // (4xx), proving the handler runs (a missing route would be 404 from notFound).
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
