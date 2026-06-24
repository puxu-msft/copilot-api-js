import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"

import { stripInternalFields } from "~/routes/models/internal"

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

// The production `/api/models` field-exposure helper (src/routes/models/internal.ts). Tested at the
// function level here (a fast capability lock on the SECURITY-relevant `request_headers` strip) —
// the route wiring that calls it is covered at the flow level by tests/infra/basic-routes.http.
describe("stripInternalFields — internal /api/models field exposure", () => {
  test("strips request_headers (internal-only — must not leak upstream auth to clients)", () => {
    const exposed = stripInternalFields(
      mockModel("claude-opus-4.6", { vendor: "Anthropic", name: "Claude Opus 4.6", request_headers: { authorization: "Bearer upstream-secret" } }),
    )
    expect(exposed).not.toHaveProperty("request_headers")
    expect(exposed).toMatchObject({ id: "claude-opus-4.6", name: "Claude Opus 4.6", vendor: "Anthropic", object: "model" })
  })

  test("passes the remaining upstream fields through unchanged (no fabricated/renamed fields)", () => {
    const exposed = stripInternalFields(mockModel("test-model"))
    expect(exposed).not.toHaveProperty("created")
    expect(exposed).not.toHaveProperty("owned_by")
    expect(exposed).not.toHaveProperty("display_name")
    expect(exposed.object).toBe("model")
  })

  test("keeps capabilities when present", () => {
    const exposed = stripInternalFields(mockModel("test-model", { capabilities: { supports: { tool_calls: true, vision: true } } }))
    expect((exposed.capabilities as Record<string, Record<string, boolean>> | undefined)?.supports?.tool_calls).toBe(true)
  })
})
