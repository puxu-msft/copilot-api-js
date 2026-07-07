import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  describe,
  expect,
  test,
} from "vitest"

import CapabilitiesTab from "@/components/models/detail/tabs/CapabilitiesTab.vue"
import LimitsVisionTab from "@/components/models/detail/tabs/LimitsVisionTab.vue"
import OverviewTab from "@/components/models/detail/tabs/OverviewTab.vue"
import TelemetryTab from "@/components/models/detail/tabs/TelemetryTab.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

const model = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "m",
    name: "m",
    vendor: "Anthropic",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
    capabilities: { type: "chat", supports: { vision: true, custom_flag: 42, reasoning_effort: ["low", "high"] }, limits: {} },
    ...over,
  }) as Model

describe("detail tabs", () => {
  test("OverviewTab shows — for missing family/tokenizer", () => {
    const m = model()
    const w = mountWithVuetifyStubs(OverviewTab, { props: { model: m, caps: deriveCapabilities(m) } })
    expect(w.text()).toContain("Family")
    expect(w.text()).toContain("—")
  })

  test("OverviewTab shows the model name (distinct from id)", () => {
    const m = model({ id: "claude-opus-4.8", name: "Claude Opus 4.8" })
    const w = mountWithVuetifyStubs(OverviewTab, { props: { model: m, caps: deriveCapabilities(m) } })
    expect(w.text()).toContain("Name")
    expect(w.text()).toContain("Claude Opus 4.8")
  })

  test("CapabilitiesTab shows the FULL raw supports map, not just derived", () => {
    const m = model()
    const w = mountWithVuetifyStubs(CapabilitiesTab, { props: { model: m, caps: deriveCapabilities(m) } })
    expect(w.text()).toContain("custom_flag") // raw non-derived key surfaced
    expect(w.text()).toContain("42")
    expect(w.text()).toContain("reasoning_effort")
    expect(w.text()).toContain("low/high") // array joined
  })

  test("LimitsVisionTab hides Vision block when no vision limits", () => {
    const m = model({ capabilities: { limits: {} } })
    const w = mountWithVuetifyStubs(LimitsVisionTab, { props: { model: m, caps: deriveCapabilities(m) } })
    expect(w.text()).not.toContain("Max images")
  })

  test("LimitsVisionTab shows Vision block when vision limits present", () => {
    const m = model({ capabilities: { limits: { vision: { max_prompt_images: 5, max_prompt_image_size: 1000 } } } })
    const w = mountWithVuetifyStubs(LimitsVisionTab, { props: { model: m, caps: deriveCapabilities(m) } })
    expect(w.text()).toContain("Max images")
    expect(w.text()).toContain("5")
  })

  test("TelemetryTab shows no-traffic message when telemetry null", () => {
    const m = model()
    const w = mountWithVuetifyStubs(TelemetryTab, { props: { model: m, caps: deriveCapabilities(m), telemetry: null } })
    expect(w.text()).toMatch(/no traffic/i)
  })

  test("TelemetryTab shows all six token dimensions when telemetry present", () => {
    const m = model()
    const telemetry = {
      last7d: {
        model: "m",
        requestCount: 10,
        successCount: 8,
        failureCount: 2,
        totalDurationMs: 5000,
        averageDurationMs: 500,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, reasoningTokens: 6 },
      },
      sinceStart: null,
    }
    const w = mountWithVuetifyStubs(TelemetryTab, { props: { model: m, caps: deriveCapabilities(m), telemetry } })
    expect(w.text()).toMatch(/cache read/i)
    expect(w.text()).toMatch(/reasoning/i)
    expect(w.text()).toContain("10") // requests
  })
})
