/**
 * Unit tests for model classification used by tool-name sanitization rules.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getModelClass,
  getToolNameRulesForModel,
} from "~/lib/models/resolver"

describe("getModelClass — vendor takes priority", () => {
  test("Google vendor → gemini", () => {
    expect(getModelClass("anything", "Google")).toBe("gemini")
  })
  test("OpenAI vendor → gpt", () => {
    expect(getModelClass("anything", "OpenAI")).toBe("gpt")
  })
  test("Anthropic vendor → claude", () => {
    expect(getModelClass("anything", "Anthropic")).toBe("claude")
  })
  test("unknown vendor falls back to name heuristic", () => {
    expect(getModelClass("gpt-5", "MysteryCorp")).toBe("gpt")
  })
})

describe("getModelClass — name heuristics fallback", () => {
  test("gemini name → gemini", () => {
    expect(getModelClass("gemini-2.5-pro")).toBe("gemini")
  })
  test("gpt- prefix → gpt", () => {
    expect(getModelClass("gpt-5.5")).toBe("gpt")
  })
  test("claude name → claude", () => {
    expect(getModelClass("claude-opus-4.8")).toBe("claude")
  })
  test("unknown → default", () => {
    expect(getModelClass("some-random-model")).toBe("default")
  })
})

describe("getToolNameRulesForModel", () => {
  test("gemini allows dots, 128 cap", () => {
    expect(getToolNameRulesForModel("gemini-2.5-pro")).toEqual({ allowDots: true, maxNameLength: 128 })
  })
  test("gpt allows dots, 128 cap", () => {
    expect(getToolNameRulesForModel("gpt-5.5")).toEqual({ allowDots: true, maxNameLength: 128 })
  })
  test("claude is strict, 64 cap", () => {
    expect(getToolNameRulesForModel("claude-opus-4.8")).toEqual({ allowDots: false, maxNameLength: 64 })
  })
  test("default is strict, 64 cap", () => {
    expect(getToolNameRulesForModel("unknown")).toEqual({ allowDots: false, maxNameLength: 64 })
  })
})
