import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  modelStatus,
  statusMeta,
} from "@/lib/model-status"

const m = (id: string, pickerEnabled = true): Model => ({ id, model_picker_enabled: pickerEnabled }) as unknown as Model

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

describe("statusMeta (presentational SSOT shared by table + drawer)", () => {
  test("enabled is dot-only (no label), a quiet muted filled dot", () => {
    const meta = statusMeta("enabled")
    expect(meta.label).toBeNull()
    expect(meta.glyph).toBe("●")
    // Muted (not signal-green): only config-disabled carries a color, so the
    // exception pops instead of a wall of green dots on the majority. C2
    // neutralized to a design-neutral `--signal-*` token (amber preset resolves
    // it back to the old `var(--color-muted)`; guarded by semantic-tokens oracle).
    expect(meta.colorVar).toBe("var(--signal-muted)")
    expect(meta.title).toBe("enabled")
  })
  test("config-disabled is a red filled dot labelled 'disabled'", () => {
    const meta = statusMeta("config-disabled")
    expect(meta.label).toBe("disabled")
    expect(meta.glyph).toBe("●")
    expect(meta.colorVar).toBe("var(--signal-fail)")
    expect(meta.title).toContain("config.disabled_models")
  })
  test("picker-disabled is a hollow muted dot labelled 'picker-off' (distinct shape cue)", () => {
    const meta = statusMeta("picker-disabled")
    expect(meta.label).toBe("picker-off")
    expect(meta.glyph).toBe("○") // hollow ≠ filled: non-color cue vs the other states
    expect(meta.colorVar).toBe("var(--signal-muted)")
    expect(meta.title).toContain("model_picker_enabled")
  })
})
