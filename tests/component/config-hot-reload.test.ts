/**
 * Tests for applyConfigToState() — config hot-reload behavior.
 *
 * Verifies:
 * - Scalar fields: applied when present, unchanged when absent
 * - Collection fields: entirely replaced (model_overrides, rewrite_system_reminders)
 * - Empty config ({}) causes no state mutation
 * - history_limit syncs to historyState.maxEntries
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { applyConfigToState, resetApplyState, resetConfigCache } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { historyState, initHistory } from "~/lib/history"
import {
  CONFIG_MANAGED_DEFAULTS,
  DEFAULT_MODEL_OVERRIDES,
  restoreStateForTests,
  resetConfigManagedState,
  setStateForTests,
  snapshotStateForTests,
  state,
} from "~/lib/state"

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

/** Write a YAML config file to the test-isolated path */
async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

/** Remove the config file if it exists */
async function removeConfig(): Promise<void> {
  try {
    await fs.unlink(PATHS.CONFIG_YAML)
  } catch {
    // Ignore ENOENT
  }
}

let originalState = snapshotStateForTests()

beforeEach(async () => {
  originalState = snapshotStateForTests()
  // Redirect PATHS to a unique temp dir — isolates from concurrent test files
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  initHistory(true, 200)
})

afterEach(async () => {
  restoreStateForTests(originalState)
  // Restore original PATHS
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  // Clean up temp dir
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
})

describe("applyConfigToState: scalar fields", () => {
  test("applies anthropic scalar fields when present", async () => {
    await writeConfig(`
anthropic:
  strip_server_tools: false
  immutable_thinking_messages: true
  strip_read_tool_result_tags: true
  context_editing_trigger: 200000
  context_editing_keep_tools: 5
  context_editing_keep_thinking: 2
  tool_search: false
  auto_cache_control: false
fetch_timeout: 30
stream_idle_timeout: 60
`)
    await applyConfigToState()

    expect(state.stripServerTools).toBe(false)
    expect(state.immutableThinkingMessages).toBe(true)
    expect(state.fetchTimeout).toBe(30)
    expect(state.streamIdleTimeout).toBe(60)
    expect(state.stripReadToolResultTags).toBe(true)
    expect(state.contextEditingTrigger).toBe(200000)
    expect(state.contextEditingKeepTools).toBe(5)
    expect(state.contextEditingKeepThinking).toBe(2)
    expect(state.toolSearchEnabled).toBe(false)
    expect(state.autoCacheControl).toBe(false)
  })

  test("leaves state unchanged when config has no anthropic section", async () => {
    setStateForTests({ fetchTimeout: 42 })
    await writeConfig(`
history:
  limit: 100
`)
    await applyConfigToState()

    // Anthropic fields unchanged
    expect(state.fetchTimeout).toBe(42)
    // history.limit applied
    expect(state.historyLimit).toBe(100)
  })

  test("applies compress_tool_results_before_truncate", async () => {
    await writeConfig("compress_tool_results_before_truncate: false\n")
    await applyConfigToState()
    expect(state.compressToolResultsBeforeTruncate).toBe(false)
  })

  test("normalizes dedup_tool_calls: true → 'input'", async () => {
    await writeConfig(`
anthropic:
  dedup_tool_calls: true
`)
    await applyConfigToState()
    expect(state.dedupToolCalls).toBe("input")
  })

  test("normalizes dedup_tool_calls: 'result' stays 'result'", async () => {
    await writeConfig(`
anthropic:
  dedup_tool_calls: result
`)
    await applyConfigToState()
    expect(state.dedupToolCalls).toBe("result")
  })

  test("applies shutdown timing fields when present", async () => {
    await writeConfig(`
shutdown:
  graceful_wait: 30
  abort_wait: 60
`)
    await applyConfigToState()

    expect(state.shutdownGracefulWait).toBe(30)
    expect(state.shutdownAbortWait).toBe(60)
  })

  test("leaves shutdown fields unchanged when config has no shutdown section", async () => {
    setStateForTests({ shutdownGracefulWait: 45, shutdownAbortWait: 90 })
    await writeConfig("history_limit: 100\n")
    await applyConfigToState()

    expect(state.shutdownGracefulWait).toBe(45)
    expect(state.shutdownAbortWait).toBe(90)
  })

  test("applies openai-responses.normalize_call_ids", async () => {
    setStateForTests({ normalizeResponsesCallIds: false })
    await writeConfig(`
openai-responses:
  normalize_call_ids: true
`)
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(true)
  })

  test("applies openai-responses.normalize_call_ids: false", async () => {
    setStateForTests({ normalizeResponsesCallIds: true })
    await writeConfig(`
openai-responses:
  normalize_call_ids: false
`)
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(false)
  })

  test("leaves normalizeResponsesCallIds unchanged when config has no openai-responses section", async () => {
    setStateForTests({ normalizeResponsesCallIds: true })
    await writeConfig("fetch_timeout: 30\n")
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(true)
  })

  test("applies stale_request_max_age", async () => {
    await writeConfig("stale_request_max_age: 300\n")
    await applyConfigToState()
    expect(state.staleRequestMaxAge).toBe(300)
  })

  test("applies model_refresh_interval and allows zero to disable", async () => {
    await writeConfig("model_refresh_interval: 0\n")
    await applyConfigToState()
    expect(state.modelRefreshInterval).toBe(0)

    resetConfigCache()
    await writeConfig("model_refresh_interval: 120\n")
    await applyConfigToState()
    expect(state.modelRefreshInterval).toBe(120)
  })

  test("leaves staleRequestMaxAge unchanged when absent", async () => {
    setStateForTests({ staleRequestMaxAge: 900 })
    await writeConfig("fetch_timeout: 30\n")
    await applyConfigToState()
    expect(state.staleRequestMaxAge).toBe(900)
  })
})

describe("applyConfigToState: collection fields", () => {
  test("model_overrides: replaces from defaults + config (not cumulative)", async () => {
    // First apply: add opus override
    await writeConfig(`
model_overrides:
  opus: claude-opus-4.6-1m
`)
    await applyConfigToState()
    expect(state.modelOverrides.opus).toBe("claude-opus-4.6-1m")
    // Default sonnet/haiku preserved
    expect(state.modelOverrides.sonnet).toBe(DEFAULT_MODEL_OVERRIDES.sonnet)
    expect(state.modelOverrides.haiku).toBe(DEFAULT_MODEL_OVERRIDES.haiku)

    // Second apply: change config to only have sonnet override
    // Need to reset cache to pick up the change
    resetConfigCache()
    await writeConfig(`
model_overrides:
  sonnet: claude-sonnet-4.6
`)
    await applyConfigToState()
    // opus should revert to default (not residual from first apply)
    expect(state.modelOverrides.opus).toBe(DEFAULT_MODEL_OVERRIDES.opus)
    expect(state.modelOverrides.sonnet).toBe("claude-sonnet-4.6")
  })

  test("rewrite_system_reminders array: entire replacement", async () => {
    await writeConfig(`
anthropic:
  rewrite_system_reminders:
    - from: "pattern1"
      to: ""
    - from: "pattern2"
      to: "replacement"
`)
    await applyConfigToState()
    const rules = state.rewriteSystemReminders
    expect(Array.isArray(rules)).toBe(true)
    if (Array.isArray(rules)) {
      expect(rules).toHaveLength(2)
      expect(rules[0].from).toBeInstanceOf(RegExp)
      expect(rules[0].to).toBe("")
      expect(rules[1].to).toBe("replacement")
    }
  })

  test("rewrite_system_reminders boolean: true removes all", async () => {
    await writeConfig(`
anthropic:
  rewrite_system_reminders: true
`)
    await applyConfigToState()
    expect(state.rewriteSystemReminders).toBe(true)
  })

  test("non_deferred_tools: entire replacement", async () => {
    await writeConfig(`
anthropic:
  non_deferred_tools:
    - first_tool
    - second_tool
`)
    await applyConfigToState()
    expect(state.nonDeferredTools).toEqual(["first_tool", "second_tool"])

    resetConfigCache()
    await writeConfig(`
anthropic:
  non_deferred_tools:
    - replacement_tool
`)
    await applyConfigToState()
    expect(state.nonDeferredTools).toEqual(["replacement_tool"])
  })

  test("system_prompt_overrides: compiles to state.systemPromptOverrides", async () => {
    await writeConfig(`
system_prompt_overrides:
  - from: "old text"
    to: "new text"
  - from: "exact line"
    to: "replaced"
    method: line
`)
    await applyConfigToState()
    expect(state.systemPromptOverrides).toHaveLength(2)
    expect(state.systemPromptOverrides[0].from).toBeInstanceOf(RegExp)
    expect(state.systemPromptOverrides[0].to).toBe("new text")
    expect(state.systemPromptOverrides[1].method).toBe("line")
    expect(state.systemPromptOverrides[1].from).toBe("exact line")
  })

  test("system_prompt_overrides: absent config does not reset state", async () => {
    // Pre-populate
    setStateForTests({ systemPromptOverrides: [{ from: /pre-existing/, to: "rule" }] })

    // Write config without system_prompt_overrides
    await writeConfig("history_limit: 100\n")
    await applyConfigToState()

    // Should NOT be reset to []
    expect(state.systemPromptOverrides).toHaveLength(1)
  })
})

describe("applyConfigToState: empty / missing config", () => {
  test("empty config does not mutate state", async () => {
    // Set some non-default values
    setStateForTests({
      fetchTimeout: 99,
      modelOverrides: { opus: "custom-model" },
      systemPromptOverrides: [{ from: /test/, to: "keep" }],
      historyLimit: 500,
    })

    await writeConfig("")
    await applyConfigToState()

    // All values unchanged
    expect(state.fetchTimeout).toBe(99)
    expect(state.modelOverrides.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
    expect(state.historyLimit).toBe(500)
  })

  test("missing config file does not mutate state", async () => {
    setStateForTests({
      modelOverrides: { opus: "custom-model" },
      systemPromptOverrides: [{ from: /test/, to: "keep" }],
    })

    await removeConfig()
    await applyConfigToState()

    expect(state.modelOverrides.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
  })

  test("ordinary hot-reload remains merge-only when a key is removed outside PUT", async () => {
    await writeConfig("fetch_timeout: 123\n")
    await applyConfigToState()
    expect(state.fetchTimeout).toBe(123)

    resetConfigCache()
    await writeConfig("")
    await applyConfigToState()

    expect(state.fetchTimeout).toBe(123)
  })
})

describe("applyConfigToState: history.limit syncs to historyState", () => {
  test("updates historyState.maxEntries", async () => {
    initHistory(true, 200)
    expect(historyState.maxEntries).toBe(200)

    await writeConfig(`
history:
  limit: 50
`)
    await applyConfigToState()

    expect(state.historyLimit).toBe(50)
    expect(historyState.maxEntries).toBe(50)
  })
})

describe("config-managed defaults", () => {
  test("CONFIG_MANAGED_DEFAULTS stay aligned with initial mutable state", () => {
    expect(CONFIG_MANAGED_DEFAULTS.stripServerTools).toBe(false)
    expect(CONFIG_MANAGED_DEFAULTS.stripServerTools).toBe(state.stripServerTools)
    expect(CONFIG_MANAGED_DEFAULTS.immutableThinkingMessages).toBe(state.immutableThinkingMessages)
    expect(state.dedupToolCalls).toBe(CONFIG_MANAGED_DEFAULTS.dedupToolCalls as typeof state.dedupToolCalls)
    expect(CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags).toBe(state.stripReadToolResultTags)
    expect(state.contextEditingMode).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingMode as typeof state.contextEditingMode)
    expect(state.contextEditingTrigger).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingTrigger)
    expect(state.contextEditingKeepTools).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools)
    expect(state.contextEditingKeepThinking).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking)
    expect(state.toolSearchEnabled).toBe(CONFIG_MANAGED_DEFAULTS.toolSearchEnabled)
    expect(state.autoCacheControl).toBe(CONFIG_MANAGED_DEFAULTS.autoCacheControl)
    expect(state.nonDeferredTools).toEqual(CONFIG_MANAGED_DEFAULTS.nonDeferredTools)
    expect(state.rewriteSystemReminders).toBe(
      CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders as typeof state.rewriteSystemReminders,
    )
    expect(CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate).toBe(state.compressToolResultsBeforeTruncate)
    expect(CONFIG_MANAGED_DEFAULTS.fetchTimeout).toBe(state.fetchTimeout)
    expect(CONFIG_MANAGED_DEFAULTS.streamIdleTimeout).toBe(state.streamIdleTimeout)
    expect(CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge).toBe(state.staleRequestMaxAge)
    expect(CONFIG_MANAGED_DEFAULTS.modelRefreshInterval).toBe(state.modelRefreshInterval)
    expect(CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait).toBe(state.shutdownGracefulWait)
    expect(CONFIG_MANAGED_DEFAULTS.shutdownAbortWait).toBe(state.shutdownAbortWait)
    expect(CONFIG_MANAGED_DEFAULTS.historyLimit).toBe(state.historyLimit)
    expect(CONFIG_MANAGED_DEFAULTS.historyMinEntries).toBe(state.historyMinEntries)
    expect(CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds).toBe(state.normalizeResponsesCallIds)
    expect(CONFIG_MANAGED_DEFAULTS.systemPromptOverrides).toEqual(state.systemPromptOverrides)
  })

  test("resetConfigManagedState restores config-managed runtime defaults", () => {
    setStateForTests({
      stripServerTools: true,
      immutableThinkingMessages: true,
      dedupToolCalls: "result",
      stripReadToolResultTags: true,
      contextEditingMode: "clear-both",
      contextEditingTrigger: 777777,
      contextEditingKeepTools: 9,
      contextEditingKeepThinking: 4,
      toolSearchEnabled: false,
      autoCacheControl: false,
      nonDeferredTools: ["custom_tool"],
      rewriteSystemReminders: true,
      systemPromptOverrides: [{ from: /custom/, to: "rule" }],
      compressToolResultsBeforeTruncate: false,
      fetchTimeout: 999,
      streamIdleTimeout: 888,
      staleRequestMaxAge: 777,
      modelRefreshInterval: 666,
      shutdownGracefulWait: 66,
      shutdownAbortWait: 55,
      historyLimit: 44,
      historyMinEntries: 33,
      modelOverrides: { custom: "model" },
      normalizeResponsesCallIds: false,
    })

    resetConfigManagedState()

    expect(state.stripServerTools).toBe(CONFIG_MANAGED_DEFAULTS.stripServerTools)
    expect(state.immutableThinkingMessages).toBe(CONFIG_MANAGED_DEFAULTS.immutableThinkingMessages)
    expect(state.dedupToolCalls).toBe(CONFIG_MANAGED_DEFAULTS.dedupToolCalls as typeof state.dedupToolCalls)
    expect(state.stripReadToolResultTags).toBe(CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags)
    expect(state.contextEditingMode).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingMode as typeof state.contextEditingMode)
    expect(state.contextEditingTrigger).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingTrigger)
    expect(state.contextEditingKeepTools).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools)
    expect(state.contextEditingKeepThinking).toBe(CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking)
    expect(state.toolSearchEnabled).toBe(CONFIG_MANAGED_DEFAULTS.toolSearchEnabled)
    expect(state.autoCacheControl).toBe(CONFIG_MANAGED_DEFAULTS.autoCacheControl)
    expect(state.nonDeferredTools).toEqual(CONFIG_MANAGED_DEFAULTS.nonDeferredTools)
    expect(state.rewriteSystemReminders).toBe(
      CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders as typeof state.rewriteSystemReminders,
    )
    expect(state.systemPromptOverrides).toEqual(CONFIG_MANAGED_DEFAULTS.systemPromptOverrides)
    expect(state.compressToolResultsBeforeTruncate).toBe(CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate)
    expect(state.fetchTimeout).toBe(CONFIG_MANAGED_DEFAULTS.fetchTimeout)
    expect(state.streamIdleTimeout).toBe(CONFIG_MANAGED_DEFAULTS.streamIdleTimeout)
    expect(state.staleRequestMaxAge).toBe(CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge)
    expect(state.modelRefreshInterval).toBe(CONFIG_MANAGED_DEFAULTS.modelRefreshInterval)
    expect(state.shutdownGracefulWait).toBe(CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait)
    expect(state.shutdownAbortWait).toBe(CONFIG_MANAGED_DEFAULTS.shutdownAbortWait)
    expect(state.historyLimit).toBe(CONFIG_MANAGED_DEFAULTS.historyLimit)
    expect(state.historyMinEntries).toBe(CONFIG_MANAGED_DEFAULTS.historyMinEntries)
    expect(state.modelOverrides).toEqual(DEFAULT_MODEL_OVERRIDES)
    expect(state.normalizeResponsesCallIds).toBe(CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds)
    expect(historyState.maxEntries).toBe(CONFIG_MANAGED_DEFAULTS.historyLimit)
  })
})
