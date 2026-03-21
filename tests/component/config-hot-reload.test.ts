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
import { DEFAULT_MODEL_OVERRIDES, state } from "~/lib/state"

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

/** Save and restore original state values */
function snapshotState() {
  return {
    stripServerTools: state.stripServerTools,
    fetchTimeout: state.fetchTimeout,
    streamIdleTimeout: state.streamIdleTimeout,
    dedupToolCalls: state.dedupToolCalls,
    stripReadToolResultTags: state.stripReadToolResultTags,
    rewriteSystemReminders: state.rewriteSystemReminders,
    modelOverrides: { ...state.modelOverrides },
    compressToolResultsBeforeTruncate: state.compressToolResultsBeforeTruncate,
    systemPromptOverrides: [...state.systemPromptOverrides],
    historyLimit: state.historyLimit,
    shutdownGracefulWait: state.shutdownGracefulWait,
    shutdownAbortWait: state.shutdownAbortWait,
    staleRequestMaxAge: state.staleRequestMaxAge,
    normalizeResponsesCallIds: state.normalizeResponsesCallIds,
  }
}

function restoreState(snapshot: ReturnType<typeof snapshotState>) {
  state.stripServerTools = snapshot.stripServerTools
  state.fetchTimeout = snapshot.fetchTimeout
  state.streamIdleTimeout = snapshot.streamIdleTimeout
  state.dedupToolCalls = snapshot.dedupToolCalls
  state.stripReadToolResultTags = snapshot.stripReadToolResultTags
  state.rewriteSystemReminders = snapshot.rewriteSystemReminders
  state.modelOverrides = snapshot.modelOverrides
  state.compressToolResultsBeforeTruncate = snapshot.compressToolResultsBeforeTruncate
  state.systemPromptOverrides = snapshot.systemPromptOverrides
  state.historyLimit = snapshot.historyLimit
  state.shutdownGracefulWait = snapshot.shutdownGracefulWait
  state.shutdownAbortWait = snapshot.shutdownAbortWait
  state.staleRequestMaxAge = snapshot.staleRequestMaxAge
  state.normalizeResponsesCallIds = snapshot.normalizeResponsesCallIds
}

let originalState: ReturnType<typeof snapshotState>

beforeEach(async () => {
  originalState = snapshotState()
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
  restoreState(originalState)
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
  strip_read_tool_result_tags: true
fetch_timeout: 30
stream_idle_timeout: 60
`)
    await applyConfigToState()

    expect(state.stripServerTools).toBe(false)
    expect(state.fetchTimeout).toBe(30)
    expect(state.streamIdleTimeout).toBe(60)
    expect(state.stripReadToolResultTags).toBe(true)
  })

  test("leaves state unchanged when config has no anthropic section", async () => {
    state.fetchTimeout = 42
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
    state.shutdownGracefulWait = 45
    state.shutdownAbortWait = 90
    await writeConfig("history_limit: 100\n")
    await applyConfigToState()

    expect(state.shutdownGracefulWait).toBe(45)
    expect(state.shutdownAbortWait).toBe(90)
  })

  test("applies openai-responses.normalize_call_ids", async () => {
    state.normalizeResponsesCallIds = false
    await writeConfig(`
openai-responses:
  normalize_call_ids: true
`)
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(true)
  })

  test("applies openai-responses.normalize_call_ids: false", async () => {
    state.normalizeResponsesCallIds = true
    await writeConfig(`
openai-responses:
  normalize_call_ids: false
`)
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(false)
  })

  test("leaves normalizeResponsesCallIds unchanged when config has no openai-responses section", async () => {
    state.normalizeResponsesCallIds = true
    await writeConfig("fetch_timeout: 30\n")
    await applyConfigToState()
    expect(state.normalizeResponsesCallIds).toBe(true)
  })

  test("applies stale_request_max_age", async () => {
    await writeConfig("stale_request_max_age: 300\n")
    await applyConfigToState()
    expect(state.staleRequestMaxAge).toBe(300)
  })

  test("leaves staleRequestMaxAge unchanged when absent", async () => {
    state.staleRequestMaxAge = 900
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
    state.systemPromptOverrides = [{ from: /pre-existing/, to: "rule" }]

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
    state.fetchTimeout = 99
    state.modelOverrides = { opus: "custom-model" }
    state.systemPromptOverrides = [{ from: /test/, to: "keep" }]
    state.historyLimit = 500

    await writeConfig("")
    await applyConfigToState()

    // All values unchanged
    expect(state.fetchTimeout).toBe(99)
    expect(state.modelOverrides.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
    expect(state.historyLimit).toBe(500)
  })

  test("missing config file does not mutate state", async () => {
    state.modelOverrides = { opus: "custom-model" }
    state.systemPromptOverrides = [{ from: /test/, to: "keep" }]

    await removeConfig()
    await applyConfigToState()

    expect(state.modelOverrides.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
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
