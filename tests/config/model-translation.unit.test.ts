/**
 * `model_translation` config section (RFC 2026-07-14-anthropic-responses-direct-bridge §6.1,
 * Phase 7 of that RFC's plan): schema validation, parsing/apply into state, and the
 * `resolveTranslationFeatures()` query primitive.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  _resetConfigValidationWarnTrackingForTests,
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
  validateConfig,
  validateConfigInput,
} from "~/lib/config/config"
import { resolveTranslationFeatures } from "~/lib/config/model-translation"
import { PATHS } from "~/lib/config/paths"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  state,
} from "~/lib/state"

let warnSpy: ReturnType<typeof spyOn<typeof consola, "warn">>

beforeEach(() => {
  _resetConfigValidationWarnTrackingForTests()
  warnSpy = spyOn(consola, "warn").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.warn)
})

afterEach(() => {
  warnSpy.mockRestore()
  resetConfigManagedState()
})

function warnedMessages(): Array<string> {
  return warnSpy.mock.calls.map((call: Array<unknown>) => String(call[0]))
}

describe("model_translation — schema validation", () => {
  test("valid ingress + rule list parses through unchanged", () => {
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }],
      },
    })
    expect(result.model_translation).toEqual({
      "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }],
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("features is optional (defaults to scenario A, no stripping)", () => {
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "gpt-5.5@openai-responses" }],
      },
    })
    expect(result.model_translation?.["anthropic-messages"]?.[0]).toEqual({ match: "gpt-5.5@openai-responses" })
  })

  test("all four ingress formats are accepted", () => {
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "a@b" }],
        "openai-cc": [{ match: "c@d" }],
        "openai-responses": [{ match: "e@f" }],
        gemini: [{ match: "g@h" }],
      },
    })
    expect(Object.keys(result.model_translation ?? {}).sort()).toEqual(["anthropic-messages", "gemini", "openai-cc", "openai-responses"])
  })

  test("unrecognized ingress key warns + is stripped, sibling ingress entries survive", () => {
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "gpt-5.5@openai-responses" }],
        "bogus-ingress": [{ match: "x@y" }],
      },
    })
    expect(result.model_translation).toEqual({
      "anthropic-messages": [{ match: "gpt-5.5@openai-responses" }],
    })
    const calls = warnedMessages().filter((m) => m.includes("bogus-ingress"))
    expect(calls.length).toBeGreaterThan(0)
  })

  test("unrecognized feature value inside an array element degrades gracefully (warn-and-continue, never throws)", () => {
    // Existing `cleanInvalidPaths()` behavior for ARRAY-typed fields (shared by every
    // array field in the schema, not model_translation-specific — reproduced identically
    // with `disabled_models` in a scratch probe): deleting a single invalid array INDEX
    // leaves a sparse hole that still fails re-validation, so the pathological-case
    // fallback degrades the WHOLE config to `{}` under a warn. This documents the actual
    // recovery behavior (never throws, never crashes config load) rather than an idealized
    // per-element survival this shared pipeline doesn't implement.
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature", "bogus-feature"] }],
      },
    })
    expect(result).toEqual({})
    expect(warnedMessages().some((m) => m.includes("model_translation"))).toBe(true)
  })

  test("empty match string is rejected (min-length constraint)", () => {
    const result = validateConfig({
      model_translation: {
        "anthropic-messages": [{ match: "" }],
      },
    })
    expect(result.model_translation?.["anthropic-messages"]).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("model_translation"))).toBe(true)
  })

  test("absent key = undefined (no section declared)", () => {
    const result = validateConfig({})
    expect(result.model_translation).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("config problems never abort load — warn-and-continue, not a thrown error", () => {
    expect(() =>
      validateConfig({
        model_translation: { "totally-bogus": "not even an array" },
      }),
    ).not.toThrow()
  })

  test("PUT /api/config/yaml also validates model_translation (hard-fail with structured details)", () => {
    const r = validateConfigInput({
      model_translation: {
        "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }],
      },
    })
    expect(r.valid).toBe(true)
    if (r.valid)
      expect(r.value.model_translation).toEqual({ "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }] })
  })

  test("PUT with an unrecognized ingress key hard-fails with a structured detail (unlike file load)", () => {
    const r = validateConfigInput({
      model_translation: { "bogus-ingress": [{ match: "x@y" }] },
    })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.details.some((d) => d.field.includes("bogus-ingress"))).toBe(true)
  })
})

describe("model_translation — apply into state (retain-on-absence, mirrors model_mappings)", () => {
  let tmpDir: string
  let savedAppDir: string
  let savedConfigYaml: string
  let originalState: ReturnType<typeof snapshotStateForTests>

  async function writeConfig(content: string): Promise<void> {
    await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
  }

  beforeEach(async () => {
    originalState = snapshotStateForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-translation-test-"))
    savedAppDir = PATHS.APP_DIR
    savedConfigYaml = PATHS.CONFIG_YAML
    ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests({})
  })

  afterEach(async () => {
    restoreStateForTests(originalState)
    ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests(null)
  })

  test("applyConfigToState() populates state.modelTranslation", async () => {
    await writeConfig(`
model_translation:
  anthropic-messages:
    - match: gpt-5.5@openai-responses
      features:
        - strip-thinking-signature
`)
    await applyConfigToState()
    expect(state.modelTranslation).toEqual({
      "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }],
    })
  })

  test("empty object explicitly clears to {} (not retained)", async () => {
    await writeConfig(`
model_translation:
  anthropic-messages:
    - match: gpt-5.5@openai-responses
`)
    await applyConfigToState()
    expect(Object.keys(state.modelTranslation).length).toBeGreaterThan(0)

    resetConfigCache()
    await writeConfig("model_translation: {}\n")
    await applyConfigToState()
    expect(state.modelTranslation).toEqual({})
  })

  test("omitted key retains the prior runtime value (retain-on-absence)", async () => {
    await writeConfig(`
model_translation:
  anthropic-messages:
    - match: gpt-5.5@openai-responses
`)
    await applyConfigToState()
    resetConfigCache()
    await writeConfig("") // model_translation absent this time
    await applyConfigToState()
    expect(state.modelTranslation).toEqual({
      "anthropic-messages": [{ match: "gpt-5.5@openai-responses" }],
    })
  })

  test("resetConfigManagedState() restores the built-in empty default", () => {
    setStateForTests({
      modelTranslation: { "anthropic-messages": [{ match: "gpt-5.5@openai-responses" }] },
    })
    expect(Object.keys(state.modelTranslation).length).toBeGreaterThan(0)
    resetConfigManagedState()
    expect(state.modelTranslation).toEqual({})
  })
})

describe("resolveTranslationFeatures — match semantics (exact model@format, post-routing)", () => {
  beforeEach(() => {
    setStateForTests({
      modelTranslation: {
        "anthropic-messages": [
          { match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] },
          { match: "gpt-5.6@openai-responses" }, // declared, no features = scenario A
        ],
      },
    })
  })

  test("exact match returns the declared features", () => {
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-5.5", "openai-responses")).toEqual(["strip-thinking-signature"])
  })

  test("declared pair with no features returns empty array (scenario A)", () => {
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-5.6", "openai-responses")).toEqual([])
  })

  test("undeclared model returns empty array (default scenario A)", () => {
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-6", "openai-responses")).toEqual([])
  })

  test("undeclared ingress returns empty array", () => {
    expect(resolveTranslationFeatures("openai-cc", "gpt-5.5", "openai-responses")).toEqual([])
  })

  test("wrong format on an otherwise-matching model does not match (exact-string only, no wildcard)", () => {
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-5.5", "anthropic-messages")).toEqual([])
  })

  test("no rules declared for any ingress returns empty array", () => {
    setStateForTests({ modelTranslation: {} })
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-5.5", "openai-responses")).toEqual([])
  })

  test("first matching rule wins when multiple rules could theoretically apply (array order)", () => {
    setStateForTests({
      modelTranslation: {
        "anthropic-messages": [
          { match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] },
          { match: "gpt-5.5@openai-responses" }, // duplicate match, should never be reached
        ],
      },
    })
    expect(resolveTranslationFeatures("anthropic-messages", "gpt-5.5", "openai-responses")).toEqual(["strip-thinking-signature"])
  })
})
