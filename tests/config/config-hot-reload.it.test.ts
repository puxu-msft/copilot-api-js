/**
 * Tests for applyConfigToState() — config hot-reload behavior.
 *
 * Strategy: table-driven. Every leaf key in `ConfigSchema` MUST appear either
 * in `FIELDS` (gets R1/R2/R3 unified coverage) or in `EXEMPT` (with a stated
 * reason). The completeness guard `every config key is tested or exempt`
 * fails CI whenever a new key is added without registration, closing the
 * "silently no hot-reload coverage" hole.
 *
 * R1: applying a non-default value lands in state.
 * R2: removing the key from config on next reload KEEPS the value (unified
 *     retain-on-absence semantic; reset only on resetConfigManagedState()).
 * R3: resetConfigManagedState() restores CONFIG_MANAGED_DEFAULTS.
 *
 * Special semantics that don't fit the matrix (e.g. dedup_tool_calls true →
 * "input" normalization, model_preference per-family merging) live in the
 * "Special semantics" describe block at the bottom.
 */

import {
  //
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { ConfigSchema } from "~/lib/config/schema"
import { initHistory } from "~/lib/history"
import {
  //
  CONFIG_MANAGED_DEFAULTS,
  DEFAULT_MODEL_OVERRIDES,
  onHistoryLimitChange,
  resetConfigManagedState,
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  state,
  type State,
} from "~/lib/state"

// ============================================================================
// Test harness — isolated tmp dir per test
// ============================================================================

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  // Use an EMPTY bundled-defaults fixture so the legacy hot-reload matrix
  // tests (R2: retain-on-absence) observe pure runtime state, not bundled
  // override-merging. Real bundled-merge coverage lives in
  // tests/config/config-merge.unit.test.ts.
  setBundledConfigForTests({})
  initHistory(true, 200)
})

afterEach(async () => {
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null) // re-enable real bundled load for other suites
})

// ============================================================================
// Field registry — single source of truth for hot-reload coverage
// ============================================================================

interface FieldSpec {
  /** Yaml leaf path, e.g. "anthropic.tool_search". Dot-separated, supports brackets. */
  configKey: string
  /** Corresponding state field name. */
  stateKey: keyof State
  /** Non-default value to inject for R1. Encoded as raw YAML value (no key). */
  sampleYamlValue: string
  /** Expected `state[stateKey]` after R1 apply. */
  expectedStateValue: unknown
  /** Expected `state[stateKey]` after resetConfigManagedState() (R3). */
  defaultStateValue: unknown
}

/**
 * Build the yaml document that sets only this field to its sample value.
 * Splits the dot-path into nested mappings. When `sampleYamlValue` starts
 * with a newline (multi-line nested value like a list or sub-map), each
 * content line is shifted to live at depth = parts.length * 2 spaces while
 * preserving its RELATIVE indentation (so nested sub-maps stay structured).
 *
 * The convention for multi-line sample values: write them using two-space
 * indentation as if the leaf key sat at depth 0. The shift below rebases
 * them to the actual depth.
 */
function yamlForField(f: FieldSpec): string {
  const parts = f.configKey.split(".")
  const leaf = parts.at(-1) ?? f.configKey
  let yaml = ""
  for (let i = 0; i < parts.length - 1; i++) {
    yaml += `${"  ".repeat(i)}${parts[i]}:\n`
  }
  const leafDepth = parts.length - 1
  const leafIndent = "  ".repeat(leafDepth)
  const value = f.sampleYamlValue
  if (value.startsWith("\n")) {
    // Find the minimum leading-space depth across non-empty content lines
    // (the original "base" depth the value was written at), then shift each
    // line so that base depth becomes (leafDepth + 1) * 2 spaces.
    const lines = value
      .slice(1)
      .split("\n")
      .filter((l) => l.trim().length > 0)
    const baseSpaces = Math.min(...lines.map((l) => /^(\s*)/.exec(l)?.[1].length ?? 0))
    const targetSpaces = (leafDepth + 1) * 2
    const shift = targetSpaces - baseSpaces
    yaml += `${leafIndent}${leaf}:\n`
    for (const line of lines) {
      const leadingSpaces = /^(\s*)/.exec(line)?.[1].length ?? 0
      const newIndent = " ".repeat(Math.max(0, leadingSpaces + shift))
      yaml += `${newIndent}${line.trimStart()}\n`
    }
  } else {
    yaml += `${leafIndent}${leaf}: ${value}\n`
  }
  return yaml
}

const FIELDS: ReadonlyArray<FieldSpec> = [
  // ── Top-level scalars ───────────────────────────────────────────────
  {
    configKey: "fetch_timeout",
    stateKey: "fetchTimeout",
    sampleYamlValue: "30",
    expectedStateValue: 30,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
  },
  {
    configKey: "stream_idle_timeout",
    stateKey: "streamIdleTimeout",
    sampleYamlValue: "60",
    expectedStateValue: 60,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
  },
  {
    configKey: "stale_request_max_age",
    stateKey: "staleRequestMaxAge",
    sampleYamlValue: "1234",
    expectedStateValue: 1234,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
  },
  {
    configKey: "model_refresh_interval",
    stateKey: "modelRefreshInterval",
    sampleYamlValue: "120",
    expectedStateValue: 120,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  },
  {
    configKey: "compress_tool_results_before_truncate",
    stateKey: "compressToolResultsBeforeTruncate",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate,
  },
  {
    configKey: "sanitize_tool_names",
    stateKey: "sanitizeToolNames",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
  },
  {
    configKey: "auto_truncate.enabled",
    stateKey: "autoTruncate",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.autoTruncate,
  },
  {
    configKey: "auto_truncate.target_factor",
    stateKey: "autoTruncateTargetFactor",
    sampleYamlValue: "0.5",
    expectedStateValue: 0.5,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.autoTruncateTargetFactor,
  },
  {
    configKey: "auto_truncate.max_retries",
    stateKey: "autoTruncateMaxRetries",
    sampleYamlValue: "7",
    expectedStateValue: 7,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.autoTruncateMaxRetries,
  },
  {
    configKey: "auto_truncate.compress_threshold",
    stateKey: "autoTruncateCompressThreshold",
    sampleYamlValue: "5000",
    expectedStateValue: 5000,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.autoTruncateCompressThreshold,
  },

  // ── system_prompt_overrides (array; sample is a single rule) ────────
  {
    configKey: "system_prompt_overrides",
    stateKey: "systemPromptOverrides",
    sampleYamlValue: `\n  - from: "old text"\n    to: "new text"`,
    // Verified via length/contents in special-semantics block. Here we only
    // assert length to keep the matrix simple.
    expectedStateValue: 1,
    defaultStateValue: 0,
  },

  // ── anthropic.* scalars ────────────────────────────────────────────
  {
    configKey: "anthropic.strip_server_tools",
    stateKey: "stripServerTools",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripServerTools,
  },
  {
    configKey: "anthropic.inject_claude_code_tools",
    stateKey: "injectClaudeCodeOfficialTools",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.injectClaudeCodeOfficialTools,
  },
  {
    configKey: "anthropic.thinking_block_message_policy",
    stateKey: "thinkingBlockMessagePolicy",
    sampleYamlValue: "stripped",
    expectedStateValue: "stripped",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy,
  },
  {
    configKey: "anthropic.thinking_block_sanitize_check",
    stateKey: "thinkingBlockSanitizeCheck",
    sampleYamlValue: "empty_any",
    expectedStateValue: "empty_any",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
  },
  {
    configKey: "anthropic.coerce_adaptive_thinking",
    stateKey: "coerceAdaptiveThinking",
    sampleYamlValue: "best_effort",
    expectedStateValue: "best_effort",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
  },
  {
    configKey: "anthropic.thinking_signature_compat",
    stateKey: "thinkingSignatureCompat",
    sampleYamlValue: "redacted_thinking",
    expectedStateValue: "redacted_thinking",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
  },
  {
    configKey: "anthropic.dedup_tool_calls",
    stateKey: "dedupToolCalls",
    sampleYamlValue: "result",
    expectedStateValue: "result",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
  },
  {
    configKey: "anthropic.strip_read_tool_result_tags",
    stateKey: "stripReadToolResultTags",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
  },
  // rewrite_system_reminders covered as boolean here; array case in special-semantics.
  {
    configKey: "anthropic.rewrite_system_reminders",
    stateKey: "rewriteSystemReminders",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
  },
  {
    configKey: "anthropic.context_editing",
    stateKey: "contextEditingMode",
    sampleYamlValue: "clear-both",
    expectedStateValue: "clear-both",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
  },
  {
    configKey: "anthropic.context_editing_trigger",
    stateKey: "contextEditingTrigger",
    sampleYamlValue: "200000",
    expectedStateValue: 200000,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.contextEditingTrigger,
  },
  {
    configKey: "anthropic.context_editing_keep_tools",
    stateKey: "contextEditingKeepTools",
    sampleYamlValue: "5",
    expectedStateValue: 5,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.contextEditingKeepTools,
  },
  {
    configKey: "anthropic.context_editing_keep_thinking",
    stateKey: "contextEditingKeepThinking",
    sampleYamlValue: "2",
    expectedStateValue: 2,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.contextEditingKeepThinking,
  },
  {
    configKey: "anthropic.tool_search",
    stateKey: "toolSearchEnabled",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.toolSearchEnabled,
  },
  {
    configKey: "anthropic.cache_control",
    stateKey: "cacheControlMode",
    sampleYamlValue: "disabled",
    expectedStateValue: "disabled",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.cacheControlMode,
  },
  {
    configKey: "anthropic.non_deferred_tools",
    stateKey: "nonDeferredTools",
    sampleYamlValue: `\n  - first_tool\n  - second_tool`,
    expectedStateValue: ["first_tool", "second_tool"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.nonDeferredTools,
  },
  {
    configKey: "anthropic.api_key",
    stateKey: "anthropicApiKey",
    sampleYamlValue: '"sk-test-123"',
    expectedStateValue: "sk-test-123",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.anthropicApiKey,
  },
  {
    configKey: "anthropic.warmup",
    stateKey: "warmupPolicy",
    sampleYamlValue: "fake",
    expectedStateValue: "fake",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.warmupPolicy,
  },

  // ── anthropic.* free-form Records (whole-map leaves) ───────────────
  {
    configKey: "anthropic.efforts_overrides",
    stateKey: "effortsOverrides",
    sampleYamlValue: `\n  "claude-opus-*":\n    - high`,
    expectedStateValue: { "claude-opus-*": ["high"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.effortsOverrides,
  },
  {
    configKey: "anthropic.strip_beta_headers",
    stateKey: "stripBetaHeaders",
    sampleYamlValue: `\n  "*":\n    - context-management-2025-06-27`,
    expectedStateValue: { "*": ["context-management-2025-06-27"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripBetaHeaders,
  },
  {
    configKey: "anthropic.reject_body_fields",
    stateKey: "rejectBodyFields",
    sampleYamlValue: `\n  "*":\n    - thinking`,
    expectedStateValue: { "*": ["thinking"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.rejectBodyFields,
  },
  {
    configKey: "anthropic.decode_tool_input_fields",
    stateKey: "decodeToolInputFields",
    sampleYamlValue: `\n  "MyTool":\n    - foo`,
    expectedStateValue: { MyTool: ["foo"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.decodeToolInputFields,
  },
  {
    configKey: "anthropic.decode_all_tool_input_fields",
    stateKey: "decodeAllToolInputFields",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.decodeAllToolInputFields,
  },

  // ── model_overrides / model_preference / disabled_models ───────────
  {
    configKey: "model_overrides",
    stateKey: "modelOverrides",
    sampleYamlValue: `\n  custom-alias: claude-opus-4.6`,
    // merged on top of DEFAULT_MODEL_OVERRIDES
    expectedStateValue: { ...DEFAULT_MODEL_OVERRIDES, "custom-alias": "claude-opus-4.6" },
    defaultStateValue: DEFAULT_MODEL_OVERRIDES,
  },
  {
    configKey: "disabled_models",
    stateKey: "disabledModels",
    // Sample written in dot form; state stores the normalized (hyphen) form so
    // disabling matches the upstream id regardless of spelling.
    sampleYamlValue: `\n  - claude-opus-4.5`,
    expectedStateValue: ["claude-opus-4-5"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.disabledModels,
  },

  // ── history.* ──────────────────────────────────────────────────────
  {
    configKey: "history.success_limit",
    stateKey: "historySuccessLimit",
    sampleYamlValue: "500",
    expectedStateValue: 500,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historySuccessLimit,
  },
  {
    configKey: "history.failure_limit",
    stateKey: "historyFailureLimit",
    sampleYamlValue: "300",
    expectedStateValue: 300,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyFailureLimit,
  },
  {
    configKey: "history.reaper_interval",
    stateKey: "historyReaperInterval",
    sampleYamlValue: "120",
    expectedStateValue: 120,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyReaperInterval,
  },
  {
    configKey: "history.db_path",
    stateKey: "historyDbPath",
    sampleYamlValue: '"/tmp/custom.db"',
    expectedStateValue: "/tmp/custom.db",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyDbPath,
  },

  // ── web_search.* ───────────────────────────────────────────────────
  {
    configKey: "web_search.enabled",
    stateKey: "webSearchEnabled",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.webSearchEnabled,
  },
  {
    configKey: "web_search.backend",
    stateKey: "webSearchBackend",
    sampleYamlValue: '"searxng"',
    expectedStateValue: "searxng",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.webSearchBackend,
  },

  // ── shutdown.* ─────────────────────────────────────────────────────
  {
    configKey: "shutdown.graceful_wait",
    stateKey: "shutdownGracefulWait",
    sampleYamlValue: "33",
    expectedStateValue: 33,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
  },
  {
    configKey: "shutdown.abort_wait",
    stateKey: "shutdownAbortWait",
    sampleYamlValue: "66",
    expectedStateValue: 66,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  },

  // ── openai-responses.* ─────────────────────────────────────────────
  {
    configKey: "openai-responses.normalize_call_ids",
    stateKey: "normalizeResponsesCallIds",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  },
  {
    configKey: "openai-responses.upstream_websocket",
    stateKey: "upstreamWebSocket",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
  },
  {
    configKey: "openai-responses.fix_stream_ids",
    stateKey: "fixResponsesStreamIds",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  },
  {
    configKey: "openai-responses.client_websocket_keep_open",
    stateKey: "clientWebsocketKeepOpen",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
  },
  {
    configKey: "openai-responses.max_ws_frame_bytes",
    stateKey: "maxWsFrameBytes",
    sampleYamlValue: "2097152",
    expectedStateValue: 2097152,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
  },
  {
    configKey: "openai-responses.max_client_ws_connections",
    stateKey: "maxClientWsConnections",
    sampleYamlValue: "128",
    expectedStateValue: 128,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
  },
  {
    configKey: "openai-responses.max_upstream_ws_connections",
    stateKey: "maxUpstreamWsConnections",
    sampleYamlValue: "16",
    expectedStateValue: 16,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,
  },
]

interface ExemptField {
  configKey: string
  reason: string
}

const EXEMPT: ReadonlyArray<ExemptField> = [
  {
    configKey: "history.limit",
    reason:
      "Deprecated legacy key; no dedicated state field — falls back to success_limit/failure_limit (covered by the 'legacy history.limit falls back' test)",
  },
  {
    configKey: "proxy",
    reason: "initProxy() runs once in start.ts before any network requests; changes require restart",
  },
  {
    configKey: "ghc_api_base_url",
    reason: "Read once in start.ts; switching upstream mid-flight would mis-route active requests, so changes require restart",
  },
  {
    configKey: "rate_limiter.retry_interval",
    reason: "AdaptiveRateLimiter is a stateful singleton constructed once in start.ts; not re-init on hot reload",
  },
  {
    configKey: "rate_limiter.request_interval",
    reason: "see rate_limiter.retry_interval",
  },
  {
    configKey: "rate_limiter.recovery_timeout",
    reason: "see rate_limiter.retry_interval",
  },
  {
    configKey: "rate_limiter.consecutive_successes",
    reason: "see rate_limiter.retry_interval",
  },
  {
    configKey: "system_prompt_prepend",
    reason: "Reserved key; not yet wired into applyConfigToState (no state field exists)",
  },
  {
    configKey: "system_prompt_append",
    reason: "Reserved key; not yet wired into applyConfigToState (no state field exists)",
  },
]

// ============================================================================
// Leaf-key enumerator over ConfigSchema's JSON Schema projection
// ============================================================================

interface JsonSchemaNode {
  anyOf?: Array<JsonSchemaNode>
  type?: string | Array<string>
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: JsonSchemaNode | boolean
  items?: JsonSchemaNode
}

/**
 * Pick the first non-null branch of an `anyOf` (Zod's nullable() emits
 * `anyOf: [actualType, {type: "null"}]`).
 */
function unwrapNullable(node: JsonSchemaNode): JsonSchemaNode {
  if (!node.anyOf) return node
  const nonNull = node.anyOf.find((b) => b.type !== "null") ?? node.anyOf[0]
  return unwrapNullable(nonNull)
}

/**
 * Walk the JSON Schema produced by ConfigSchema and emit leaf paths.
 *
 * A node is treated as a LEAF when:
 *  - it has no `properties` (scalars, arrays, free-form Records via
 *    `additionalProperties`), OR
 *  - it's a recognised "whole-map" object (object with `additionalProperties`
 *    and no `properties`).
 *
 * Nodes with `properties` are recursed into to yield nested leaves like
 * `anthropic.tool_search` and `model_preference.opus`.
 */
function enumerateLeafKeys(schema: z.ZodObject): Set<string> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as JsonSchemaNode

  const leaves = new Set<string>()
  function walk(node: JsonSchemaNode, prefix: string): void {
    const inner = unwrapNullable(node)
    if (inner.properties) {
      for (const [key, child] of Object.entries(inner.properties)) {
        walk(child, prefix === "" ? key : `${prefix}.${key}`)
      }
      return
    }
    // Leaf: scalar, array, or free-form Record (additionalProperties without properties)
    leaves.add(prefix)
  }
  walk(json, "")
  return leaves
}

/** Read a state field by its dynamic name. Allows the matrix to span fields of varying types. */
function readState(stateKey: keyof State): unknown {
  return (state as unknown as Record<string, unknown>)[stateKey]
}

// ============================================================================
// R1: applies sample value
// ============================================================================

describe.each(FIELDS as Array<FieldSpec>)("hot-reload R1: $configKey", (f) => {
  test("sample value lands in state", async () => {
    await writeConfig(yamlForField(f))
    await applyConfigToState()
    const actual = f.configKey === "system_prompt_overrides" ? (state.systemPromptOverrides.length as unknown) : readState(f.stateKey)
    expect(actual).toEqual(f.expectedStateValue as never)
  })
})

// ============================================================================
// R2: retain-on-absence (unified semantic)
// ============================================================================

describe.each(FIELDS as Array<FieldSpec>)("hot-reload R2: $configKey", (f) => {
  test("value retained when key absent on subsequent reload", async () => {
    await writeConfig(yamlForField(f))
    await applyConfigToState()

    resetConfigCache()
    await writeConfig("") // empty yaml — every key absent
    await applyConfigToState()

    const actual = f.configKey === "system_prompt_overrides" ? (state.systemPromptOverrides.length as unknown) : readState(f.stateKey)
    expect(actual).toEqual(f.expectedStateValue as never)
  })
})

// ============================================================================
// R3: resetConfigManagedState restores defaults
// ============================================================================

describe.each(FIELDS as Array<FieldSpec>)("hot-reload R3: $configKey", (f) => {
  test("resetConfigManagedState() restores built-in default", async () => {
    // Set non-default value via apply path
    await writeConfig(yamlForField(f))
    await applyConfigToState()

    resetConfigManagedState()

    const actual = f.configKey === "system_prompt_overrides" ? (state.systemPromptOverrides.length as unknown) : readState(f.stateKey)
    expect(actual).toEqual(f.defaultStateValue as never)
  })
})

// ============================================================================
// Completeness guard — fail when a new ConfigSchema key isn't registered
// ============================================================================

describe("Coverage completeness", () => {
  test("every ConfigSchema leaf key is either tested or explicitly exempt", () => {
    const allLeaves = enumerateLeafKeys(ConfigSchema)
    const known = new Set<string>([...FIELDS.map((f) => f.configKey), ...EXEMPT.map((e) => e.configKey)])
    const orphans = [...allLeaves].filter((k) => !known.has(k)).sort()
    expect(orphans).toEqual([])
  })

  test("EXEMPT entries don't overlap with FIELDS", () => {
    const tested = new Set(FIELDS.map((f) => f.configKey))
    const duplicates = EXEMPT.filter((e) => tested.has(e.configKey))
    expect(duplicates).toEqual([])
  })
})

// ============================================================================
// Special semantics — non-typical branches that don't fit the matrix
// ============================================================================

describe("Special semantics", () => {
  beforeAll(() => {
    // initHistory must run before any test that calls applyConfigToState() with
    // history settings — the per-test beforeEach already does this, but
    // beforeAll documents intent for the suite.
    initHistory(true, 200)
  })

  test("dedup_tool_calls: true normalizes to 'input'", async () => {
    await writeConfig("anthropic:\n  dedup_tool_calls: true\n")
    await applyConfigToState()
    expect(state.dedupToolCalls).toBe("input")
  })

  test("rewrite_system_reminders: array compiles to CompiledRewriteRule[]", async () => {
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
      expect(rules[1].to).toBe("replacement")
    }
  })

  test("system_prompt_overrides: compiles to runtime rules with regex `from`", async () => {
    await writeConfig(`
system_prompt_overrides:
  - from: "old"
    to: "new"
  - from: "exact line"
    to: "replaced"
    method: line
`)
    await applyConfigToState()
    expect(state.systemPromptOverrides).toHaveLength(2)
    expect(state.systemPromptOverrides[0].from).toBeInstanceOf(RegExp)
    expect(state.systemPromptOverrides[1].method).toBe("line")
    expect(state.systemPromptOverrides[1].from).toBe("exact line")
  })

  test("history.success_limit also syncs setHistoryMaxEntries (side effect)", async () => {
    // initHistory at default; apply changes success limit to 50.
    initHistory(true, 200)
    await writeConfig("history:\n  success_limit: 50\n")
    await applyConfigToState()
    expect(state.historySuccessLimit).toBe(50)
    // setHistoryMaxEntries effect verified indirectly — historySuccessLimit reflects it.
  })

  test("legacy history.limit falls back to both success and failure limits", async () => {
    initHistory(true, 200)
    await writeConfig("history:\n  limit: 77\n")
    await applyConfigToState()
    expect(state.historySuccessLimit).toBe(77)
    expect(state.historyFailureLimit).toBe(77)
  })

  test("dedicated limits override legacy history.limit fallback", async () => {
    await writeConfig("history:\n  limit: 77\n  success_limit: 10\n  failure_limit: 20\n")
    await applyConfigToState()
    expect(state.historySuccessLimit).toBe(10)
    expect(state.historyFailureLimit).toBe(20)
  })

  test("changing only reaper_interval retunes the reaper (listener fires)", async () => {
    // Register a listener AFTER the initial sync so we only observe the
    // interval-triggered notification, not the synchronous registration call.
    let fired = 0
    const unsubscribe = onHistoryLimitChange(() => {
      fired++
    })
    fired = 0 // discard the synchronous on-register invocation
    await writeConfig("history:\n  reaper_interval: 999\n")
    await applyConfigToState()
    unsubscribe()
    expect(state.historyReaperInterval).toBe(999)
    expect(fired).toBeGreaterThan(0)
  })

  test("model_refresh_interval: 0 disables the refresh loop", async () => {
    await writeConfig("model_refresh_interval: 0\n")
    await applyConfigToState()
    expect(state.modelRefreshInterval).toBe(0)
  })

  test("empty config does not mutate any pre-existing runtime state", async () => {
    setStateForTests({
      fetchTimeout: 99,
      modelOverrides: { opus: "custom-model" },
      systemPromptOverrides: [{ from: /test/, to: "keep" }],
      historySuccessLimit: 500,
      disabledModels: ["foo"],
    })
    await writeConfig("")
    await applyConfigToState()

    expect(state.fetchTimeout).toBe(99)
    expect(state.modelOverrides.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
    expect(state.historySuccessLimit).toBe(500)
    expect(state.disabledModels).toEqual(["foo"])
  })

  test("missing config file does not mutate state", async () => {
    setStateForTests({ modelOverrides: { opus: "custom-model" } })
    await removeConfig()
    await applyConfigToState()
    expect(state.modelOverrides.opus).toBe("custom-model")
  })

  test("disabled_models retain semantic: writing one field doesn't wipe a previously-set list", async () => {
    // Regression guard for the Part-A behaviour change.
    await writeConfig("disabled_models:\n  - foo\n")
    await applyConfigToState()
    expect(state.disabledModels).toEqual(["foo"])

    resetConfigCache()
    await writeConfig("fetch_timeout: 30\n")
    await applyConfigToState()

    expect(state.fetchTimeout).toBe(30)
    expect(state.disabledModels).toEqual(["foo"]) // NOT cleared
  })

  test("resetConfigManagedState restores model_overrides to DEFAULT_MODEL_OVERRIDES", () => {
    setStateForTests({ modelOverrides: { custom: "model" } })
    resetConfigManagedState()
    expect(state.modelOverrides).toEqual(DEFAULT_MODEL_OVERRIDES)
  })

  test("CONFIG_MANAGED_DEFAULTS stays aligned with initial mutable state", () => {
    // Sanity guard against drift in state.ts initializer.
    expect(state.stripServerTools).toBe(CONFIG_MANAGED_DEFAULTS.stripServerTools)
    expect(state.thinkingBlockMessagePolicy).toBe(CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy)
    expect(state.fetchTimeout).toBe(CONFIG_MANAGED_DEFAULTS.fetchTimeout)
    expect(state.streamIdleTimeout).toBe(CONFIG_MANAGED_DEFAULTS.streamIdleTimeout)
    expect(state.historySuccessLimit).toBe(CONFIG_MANAGED_DEFAULTS.historySuccessLimit)
    expect(state.historyFailureLimit).toBe(CONFIG_MANAGED_DEFAULTS.historyFailureLimit)
  })
})
