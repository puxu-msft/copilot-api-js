/**
 * Guards the management-API OpenAPI 3.1 document + Scalar UI.
 *
 * Locks: (1) /openapi.json is a valid 3.1 doc versioned to package.json;
 * (2) the converted management endpoints appear with correct path prefixes;
 * (3) the SCOPE boundary — compat (vendor-mirror) endpoints, the history REST
 * API, and the dry-run-pipeline inspector are intentionally absent.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import packageJson from "../../package.json"
import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

async function getSpec(): Promise<{ openapi: string; info: { version: string }; paths: Record<string, unknown> }> {
  const res = await app.request("/openapi.json")
  expect(res.status).toBe(200)
  return res.json() as Promise<{ openapi: string; info: { version: string }; paths: Record<string, unknown> }>
}

describe("management OpenAPI document", () => {
  test("serves a 3.1 doc versioned to package.json", async () => {
    const spec = await getSpec()
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.info.version).toBe(packageJson.version)
  })

  test("includes the converted management endpoints with correct prefixes", async () => {
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

  test("excludes compat (vendor-mirror) + history + dry-run-pipeline (scope boundary)", async () => {
    const { paths } = await getSpec()
    for (const p of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/embeddings", "/history/api/entries", "/api/debug/dry-run-pipeline"]) {
      expect(paths[p], `expected ${p} NOT in spec`).toBeUndefined()
    }
  })

  test("config/yaml documents both GET and PUT", async () => {
    const { paths } = await getSpec()
    const yaml = paths["/api/config/yaml"] as Record<string, unknown>
    expect(yaml.get).toBeDefined()
    expect(yaml.put).toBeDefined()
  })

  test("serves the Scalar reference UI at /docs", async () => {
    const res = await app.request("/docs")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type") ?? "").toContain("text/html")
  })
})
