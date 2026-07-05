import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import { setModels } from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

function mockModel(id: string, overrides?: Partial<Model>): Model {
  return {
    id,
    name: `Model ${id}`,
    vendor: "TestVendor",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: id,
    is_chat_default: false,
    is_chat_fallback: false,
    ...overrides,
  }
}

// `/api/models` (internal format) serves the full Copilot model object. Per ADR
// internal-tool-security-posture, `request_headers` is NO LONGER stripped — this
// is an internal personal tool, and the model-specific routing headers CAPI ships
// are diagnostic value the operator's Raw JSON view should see (richest-data-flow).
// The old `stripInternalFields` helper was removed with the strip.
describe("GET /api/models — full field exposure (internal format)", () => {
  useIsolatedRuntime()

  test("exposes request_headers (no longer stripped)", async () => {
    setModels({
      object: "list",
      data: [mockModel("m1", { request_headers: { "x-model-region": "eu" } })],
    })
    const app = createFullTestApp()
    const res = await app.request("/api/models")
    const body = (await res.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data[0].request_headers).toEqual({ "x-model-region": "eu" })
  })

  test("single-model route also exposes request_headers", async () => {
    setModels({
      object: "list",
      data: [mockModel("m2", { request_headers: { "x-model-region": "us" } })],
    })
    const app = createFullTestApp()
    const res = await app.request("/api/models/m2")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.request_headers).toEqual({ "x-model-region": "us" })
  })

  test("passes remaining upstream fields through unchanged (no fabricated/renamed fields)", async () => {
    setModels({ object: "list", data: [mockModel("m3", { capabilities: { supports: { tool_calls: true, vision: true } } })] })
    const app = createFullTestApp()
    const res = await app.request("/api/models")
    const body = (await res.json()) as { data: Array<Record<string, unknown>> }
    const m = body.data[0]
    expect(m.object).toBe("model")
    expect(m).not.toHaveProperty("created")
    expect(m).not.toHaveProperty("owned_by")
    expect((m.capabilities as Record<string, Record<string, boolean>>).supports.tool_calls).toBe(true)
  })
})
