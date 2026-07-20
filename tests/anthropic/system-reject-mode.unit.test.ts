import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  markSystemRejectModel,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  isSystemRejectModel,
  resolveSystemSanitizeMode,
} from "~/lib/anthropic/system-reject-mode"
import {
  //
  setAnthropicBehavior,
} from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

afterEach(() => clearAnthropicFeatureNegotiationForTests())

describe("resolveSystemSanitizeMode", () => {
  autoRestoreState()

  test("config reject set matches by normalized substring → uses systemRejectMode", () => {
    setAnthropicBehavior({ systemRejectModels: ["claude-haiku-4.5"], systemRejectMode: "as_user", systemDefaultMode: false })
    // real resolved name is date-suffixed; substring of normalized key must still match
    expect(isSystemRejectModel("claude-haiku-4-5-20251001")).toBe(true)
    expect(resolveSystemSanitizeMode("claude-haiku-4-5-20251001")).toBe("as_user")
  })
  test("non-reject model falls back to global system_default_mode", () => {
    setAnthropicBehavior({ systemRejectModels: ["claude-haiku-4.5"], systemRejectMode: "as_user", systemDefaultMode: false })
    expect(isSystemRejectModel("claude-opus-4.8")).toBe(false)
    expect(resolveSystemSanitizeMode("claude-opus-4.8")).toBe(false)
  })
  test("learned reject set (reactive) also drives the effective mode", () => {
    setAnthropicBehavior({ systemRejectModels: [], systemRejectMode: "merge", systemDefaultMode: false })
    markSystemRejectModel("claude-sonnet-4.6")
    expect(resolveSystemSanitizeMode("claude-sonnet-4.6")).toBe("merge")
  })
})
