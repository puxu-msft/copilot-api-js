import { describe, expect, test } from "bun:test"

import type { Model } from "~backend/lib/models/client"

import { modelStatus } from "@/lib/model-status"

const m = (id: string, pickerEnabled = true): Model =>
  ({ id, model_picker_enabled: pickerEnabled } as unknown as Model)

describe("modelStatus", () => {
  test("config-disabled wins (highest priority) even if picker-enabled", () => {
    expect(modelStatus(m("x", true), new Set(["x"]))).toBe("config-disabled")
  })
  test("config-disabled wins over picker-disabled", () => {
    expect(modelStatus(m("x", false), new Set(["x"]))).toBe("config-disabled")
  })
  test("picker-disabled when not config-disabled and model_picker_enabled===false", () => {
    expect(modelStatus(m("x", false), new Set())).toBe("picker-disabled")
  })
  test("enabled otherwise", () => {
    expect(modelStatus(m("x", true), new Set())).toBe("enabled")
  })
})
