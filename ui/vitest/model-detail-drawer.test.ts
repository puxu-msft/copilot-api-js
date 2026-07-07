import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  describe,
  expect,
  test,
} from "vitest"

import ModelDetailDrawer from "@/components/models/ModelDetailDrawer.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

const model = {
  id: "claude-opus-4.8",
  name: "Opus",
  vendor: "Anthropic",
  object: "model",
  preview: false,
  model_picker_enabled: true,
  is_chat_default: false,
  is_chat_fallback: false,
  version: "1",
  capabilities: { type: "chat", supports: {}, limits: {} },
} as Model

describe("ModelDetailDrawer", () => {
  test("renders selected model id + tab labels when open", () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, {
      props: { modelValue: true, model, caps: deriveCapabilities(model), telemetry: null },
      global: { stubs: { JsonViewerSurface: true } },
    })
    expect(w.text()).toContain("claude-opus-4.8")
    expect(w.text()).toContain("Overview")
    expect(w.text()).toContain("Capabilities")
    expect(w.text()).toContain("Telemetry")
    expect(w.text()).toContain("Raw JSON")
  })

  test("renders nothing meaningful when model is null", () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, {
      props: { modelValue: false, model: null, caps: null, telemetry: null },
      global: { stubs: { JsonViewerSurface: true } },
    })
    expect(w.text()).not.toContain("Overview")
  })

  test("close button emits update:modelValue false", async () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, {
      props: { modelValue: true, model, caps: deriveCapabilities(model), telemetry: null },
      global: { stubs: { JsonViewerSurface: true } },
    })
    await w.find('button[aria-label="Close"]').trigger("click")
    expect(w.emitted("update:modelValue")?.some((e) => e[0] === false)).toBe(true)
  })

  test("Escape closes the drawer when open", async () => {
    const w = mountWithVuetifyStubs(ModelDetailDrawer, {
      props: { modelValue: true, model, caps: deriveCapabilities(model), telemetry: null },
      global: { stubs: { JsonViewerSurface: true } },
      attachTo: document.body,
    })
    globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await w.vm.$nextTick()
    expect(w.emitted("update:modelValue")?.some((e) => e[0] === false)).toBe(true)
    w.unmount()
  })
})
