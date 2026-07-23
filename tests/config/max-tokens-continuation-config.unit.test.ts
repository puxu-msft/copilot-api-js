import {
  //
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { ConfigSchema } from "~/lib/config/schema"
import {
  //
  resetConfigManagedState,
  resolveEffectiveMaxTokensContinuation,
  resolveMaxTokensContinuation,
  setMaxTokensContinuationOverride,
  setMaxTokensContinuationShared,
} from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

let configDir: string | undefined
let savedAppDir: string | undefined
let savedConfigPath: string | undefined

async function applyYaml(content: string): Promise<void> {
  resetConfigManagedState()
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
  resetConfigCache()
  await applyConfigToState()
}

async function withIsolatedConfig<T>(testBody: () => Promise<T>): Promise<T> {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "max-tokens-continuation-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigPath = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = configDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(configDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  try {
    return await testBody()
  } finally {
    ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
    ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigPath
    await fs.rm(configDir, { recursive: true, force: true })
    resetConfigCache()
    resetApplyState()
    setBundledConfigForTests(null)
  }
}

useIsolatedRuntime()

test("max_tokens_continuation defaults are disabled and preserve the frozen P0 strategy shape", () => {
  expect(resolveMaxTokensContinuation("anthropic")).toEqual({
    enabled: false,
    maxRounds: 1,
    classes: { text: "continue", toolUse: "passthrough", thinking: "passthrough" },
    message: "Please continue where you left off.",
    visibility: "transparent",
    thinkingRetryBudget: null,
  })
})

test("per-vendor override wins over the shared max_tokens_continuation setting", () => {
  setMaxTokensContinuationShared({ maxRounds: 3, visibility: "marker" })
  setMaxTokensContinuationOverride("anthropic", { maxRounds: 1, visibility: "transparent" })

  expect(resolveMaxTokensContinuation("anthropic")).toMatchObject({ maxRounds: 1, visibility: "transparent" })
  expect(resolveMaxTokensContinuation("openai-responses")).toMatchObject({ maxRounds: 3, visibility: "marker" })
})

test("schema parses the top-level max_tokens_continuation section and rejects unknown keys", () => {
  expect(
    ConfigSchema.parse({
      max_tokens_continuation: {
        enabled: true,
        max_rounds: 2,
        classes: { text: "continue", tool_use: "passthrough", thinking: "retry_with_budget" },
        message: "continue exactly",
        visibility: "marker",
        thinking_retry_budget: 64000,
      },
    }).max_tokens_continuation,
  ).toEqual({
    enabled: true,
    max_rounds: 2,
    classes: { text: "continue", tool_use: "passthrough", thinking: "retry_with_budget" },
    message: "continue exactly",
    visibility: "marker",
    thinking_retry_budget: 64000,
  })
  expect(() => ConfigSchema.parse({ max_tokens_continuation: { unexpected: true } })).toThrow()
})

test("real YAML application resolves shared policy before the per-vendor override", async () => {
  await withIsolatedConfig(async () => {
    await applyYaml(`max_tokens_continuation:
  enabled: true
  max_rounds: 3
  visibility: marker
anthropic:
  max_tokens_continuation:
    max_rounds: 1
    visibility: transparent
`)

    expect(resolveMaxTokensContinuation("anthropic")).toMatchObject({ enabled: true, maxRounds: 1, visibility: "transparent" })
    expect(resolveMaxTokensContinuation("openai-responses")).toMatchObject({ enabled: true, maxRounds: 3, visibility: "marker" })
  })
})

test("passthrough visibility prevents every configured stitch strategy and makes the diagnostic explicit", () => {
  setMaxTokensContinuationShared({
    visibility: "passthrough",
    classes: { text: "continue", toolUse: "continue", thinking: "retry_with_budget" },
  })

  expect(resolveEffectiveMaxTokensContinuation("anthropic")).toEqual({
    enabled: false,
    maxRounds: 1,
    classes: { text: "passthrough", toolUse: "passthrough", thinking: "passthrough" },
    message: "Please continue where you left off.",
    visibility: "passthrough",
    thinkingRetryBudget: null,
    diagnostics: ["strategy-prevented-stitch"],
  })
})

test("transparent visibility preserves continuation strategy without diagnostics", () => {
  expect(resolveEffectiveMaxTokensContinuation("anthropic")).toMatchObject({
    classes: { text: "continue", toolUse: "passthrough", thinking: "passthrough" },
    diagnostics: [],
  })
})
