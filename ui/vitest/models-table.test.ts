import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  describe,
  expect,
  test,
} from "vitest"

import ModelsTable from "@/components/models/ModelsTable.vue"

import {
  //
  mountWithVuetifyStubs,
  vuetifyComponentStubs,
} from "./helpers/mount"

function model(id: string, supports: Record<string, unknown>, limits: Record<string, number> = {}): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "v",
    version: "1",
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    preview: false,
    billing: { multiplier: 1 },
    capabilities: { supports: supports as never, limits: limits as never },
  }
}

const VTableStub = { name: "VTable", template: "<table><slot /></table>" }

function mountTable(models: Array<Model>) {
  return mountWithVuetifyStubs(ModelsTable, {
    props: { models, caps: deriveCapabilities, vendorColor: () => "primary", fmtNum: (n?: number) => (n ? String(n) : "-") },
    global: { components: { ...vuetifyComponentStubs, VTable: VTableStub }, stubs: { JsonViewerSurface: true } },
  })
}

describe("ModelsTable", () => {
  test("capability matrix shows ✓ for supported, · for unsupported", () => {
    const w = mountTable([model("a", { vision: true })])
    const t = w.text()
    expect(t).toContain("✓") // vision supported
    expect(t).toContain("·") // other caps unsupported
  })

  test("sortable: clicking the Ctx header sorts by context window (desc default)", async () => {
    const w = mountTable([model("small", {}, { max_context_window_tokens: 1000 }), model("big", {}, { max_context_window_tokens: 200000 })])
    const ctxHeader = w.findAll("th").find((h) => h.text().startsWith("Ctx"))
    await ctxHeader!.trigger("click")
    const rowIds = w.findAll("td.td-id").map((td) => td.text())
    // numeric column defaults to descending → big first
    expect(rowIds[0]).toContain("big")
  })

  test("row click emits select with the model id (drawer replaces in-row expand)", async () => {
    const w = mountTable([model("a", {})])
    expect(w.find("tr.model-expand-row").exists()).toBe(false)
    await w.find("tr.model-row").trigger("click")
    // No in-row expansion anymore — selection is delegated to the page's drawer.
    expect(w.find("tr.model-expand-row").exists()).toBe(false)
    expect(w.emitted("select")?.[0]).toEqual(["a"])
  })

  test("reasoning effort levels surface (array support not dropped)", () => {
    const w = mountTable([model("a", { reasoning_effort: ["low", "high"] })])
    expect(w.text()).toContain("low/high")
  })

  test("hides a column when the columns controller disables it", () => {
    const columns = {
      isVisible: (key: string) => key !== "context",
      toggle: () => {},
      reset: () => {},
      ALL_COLUMNS: [],
      visible: { value: {} },
    }
    const w = mountWithVuetifyStubs(ModelsTable, {
      props: {
        models: [model("a", {})],
        caps: deriveCapabilities,
        vendorColor: () => "primary",
        fmtNum: (n?: number) => (n ? String(n) : "-"),
        columns: columns as never,
      },
      global: { components: { ...vuetifyComponentStubs, VTable: VTableStub }, stubs: { JsonViewerSurface: true } },
    })
    expect(w.findAll("th").some((h) => h.text().startsWith("Ctx"))).toBe(false)
  })

  test("renders requests(7d) column value from telemetryFor", () => {
    const columns = {
      isVisible: (key: string) => key === "requests7d",
      toggle: () => {},
      reset: () => {},
      ALL_COLUMNS: [],
      visible: { value: {} },
    }
    const telemetryFor = () => ({
      last7d: {
        model: "a",
        requestCount: 42,
        successCount: 42,
        failureCount: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
      },
      sinceStart: null,
    })
    const w = mountWithVuetifyStubs(ModelsTable, {
      props: {
        models: [model("a", {})],
        caps: deriveCapabilities,
        vendorColor: () => "primary",
        fmtNum: (n?: number) => (n ? String(n) : "-"),
        columns: columns as never,
        telemetryFor,
        maxRequests7d: 42,
      },
      global: { components: { ...vuetifyComponentStubs, VTable: VTableStub }, stubs: { JsonViewerSurface: true } },
    })
    expect(w.text()).toContain("42")
    expect(w.findAll("th").some((h) => h.text().startsWith("Req"))).toBe(true)
  })
})
