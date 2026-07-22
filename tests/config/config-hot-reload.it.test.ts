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
 * Special semantics that don't fit the matrix (e.g. tool_dedup_calls true →
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
  DEFAULT_MODEL_MAPPINGS,
  DEFAULT_MODEL_TRANSLATION,
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
  await initHistory(true, 200)
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
  // ── telemetry.* (分层遥测) — 样本值避开 apply 层回落分支（γ≥0.005、resolution 整除 60） ──
  { configKey: "telemetry.enabled", stateKey: "telemetryEnabled", sampleYamlValue: "false", expectedStateValue: false, defaultStateValue: true },
  {
    configKey: "telemetry.db_path",
    stateKey: "telemetryDbPath",
    sampleYamlValue: "/tmp/tel-test.db",
    expectedStateValue: "/tmp/tel-test.db",
    defaultStateValue: "",
  },
  { configKey: "telemetry.persist_interval", stateKey: "telemetryPersistInterval", sampleYamlValue: "30", expectedStateValue: 30, defaultStateValue: 60 },
  { configKey: "telemetry.rollup_interval", stateKey: "telemetryRollupInterval", sampleYamlValue: "1800", expectedStateValue: 1800, defaultStateValue: 3600 },
  { configKey: "telemetry.cardinality_cap", stateKey: "telemetryCardinalityCap", sampleYamlValue: "100", expectedStateValue: 100, defaultStateValue: 200 },
  { configKey: "telemetry.sketch_gamma", stateKey: "telemetrySketchGamma", sampleYamlValue: "0.02", expectedStateValue: 0.02, defaultStateValue: 0.01 },
  { configKey: "telemetry.cumulative", stateKey: "telemetryCumulative", sampleYamlValue: "false", expectedStateValue: false, defaultStateValue: true },
  {
    configKey: "telemetry.tiers.raw.resolution_minutes",
    stateKey: "telemetryRawResolutionMinutes",
    sampleYamlValue: "10",
    expectedStateValue: 10,
    defaultStateValue: 5,
  },
  {
    configKey: "telemetry.tiers.raw.retention_days",
    stateKey: "telemetryRawRetentionDays",
    sampleYamlValue: "14",
    expectedStateValue: 14,
    defaultStateValue: 7,
  },
  {
    configKey: "telemetry.tiers.hourly.retention_days",
    stateKey: "telemetryHourlyRetentionDays",
    sampleYamlValue: "30",
    expectedStateValue: 30,
    defaultStateValue: 90,
  },
  {
    configKey: "telemetry.tiers.daily.retention_days",
    stateKey: "telemetryDailyRetentionDays",
    sampleYamlValue: "180",
    expectedStateValue: 180,
    defaultStateValue: 0,
  },
  // ── Top-level scalars ───────────────────────────────────────────────
  {
    configKey: "timeouts.response_header",
    stateKey: "responseHeaderTimeout",
    sampleYamlValue: "30",
    expectedStateValue: 30,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responseHeaderTimeout,
  },
  {
    configKey: "timeouts.stream_idle",
    stateKey: "streamIdleTimeout",
    sampleYamlValue: "60",
    expectedStateValue: 60,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
  },
  {
    configKey: "timeouts.stream_idle_overrides",
    stateKey: "streamIdleTimeoutOverrides",
    // normalizeModelKeyedRecord folds the "." in "gpt-5.5" to "gpt-5-5" (state
    // stores the normalized key; findMostSpecific normalizes the query too, so
    // resolveStreamIdleTimeout("gpt-5.5") still matches).
    sampleYamlValue: `\n  "gpt-5.5":\n    600`,
    expectedStateValue: { "gpt-5-5": 600 },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamIdleTimeoutOverrides,
  },
  {
    configKey: "timeouts.response_header_overrides",
    stateKey: "responseHeaderTimeoutOverrides",
    sampleYamlValue: `\n  "gpt-5.5":\n    500`,
    expectedStateValue: { "gpt-5-5": 500 },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responseHeaderTimeoutOverrides,
  },
  {
    configKey: "upstream_transport.tcp_keepalive_probe_delay",
    stateKey: "upstreamKeepaliveDelay",
    sampleYamlValue: "20",
    expectedStateValue: 20,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
  },
  {
    configKey: "upstream_transport.http2.ping_interval",
    stateKey: "upstreamH2PingInterval",
    sampleYamlValue: "20",
    expectedStateValue: 20,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,
  },
  {
    configKey: "upstream_transport.http2.session_connect_timeout",
    stateKey: "sessionConnectTimeout",
    sampleYamlValue: "5",
    expectedStateValue: 5,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.sessionConnectTimeout,
  },
  {
    configKey: "upstream_transport.http2.max_concurrent_streams_per_session",
    stateKey: "maxConcurrentStreamsPerSession",
    sampleYamlValue: "4",
    expectedStateValue: 4,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxConcurrentStreamsPerSession,
  },
  {
    configKey: "upstream_transport.http2.idle_session_timeout",
    stateKey: "h2IdleSessionTimeout",
    sampleYamlValue: "120",
    expectedStateValue: 120,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.h2IdleSessionTimeout,
  },
  {
    configKey: "upstream_transport.websocket.pooled_connection_idle_timeout",
    stateKey: "pooledConnectionIdleTimeout",
    sampleYamlValue: "60",
    expectedStateValue: 60,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.pooledConnectionIdleTimeout,
  },
  {
    configKey: "upstream_transport.websocket.soft_max_connections",
    stateKey: "softMaxUpstreamWsConnections",
    sampleYamlValue: "16",
    expectedStateValue: 16,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.softMaxUpstreamWsConnections,
  },
  {
    configKey: "timeouts.stale_request_max_age",
    stateKey: "staleRequestMaxAge",
    sampleYamlValue: "1234",
    expectedStateValue: 1234,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
  },
  {
    configKey: "timeouts.request_deadline",
    stateKey: "requestDeadline",
    sampleYamlValue: "1800",
    expectedStateValue: 1800,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.requestDeadline,
  },
  {
    configKey: "model_refresh_interval",
    stateKey: "modelRefreshInterval",
    sampleYamlValue: "120",
    expectedStateValue: 120,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  },
  {
    configKey: "sanitize_tool_names",
    stateKey: "sanitizeToolNames",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.sanitizeToolNames,
  },
  {
    configKey: "forward_client_query",
    stateKey: "forwardClientQuery",
    // Default is true, so sample MUST differ (false) to prove the wiring.
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.forwardClientQuery,
  },
  {
    configKey: "forward_client_query_exclude",
    stateKey: "forwardClientQueryExclude",
    // Default is [], so sample MUST be non-empty to prove R1/R2 wiring.
    sampleYamlValue: `\n  - x-trace-id`,
    expectedStateValue: ["x-trace-id"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.forwardClientQueryExclude,
  },
  {
    configKey: "anthropic.use_upstream_count_tokens",
    stateKey: "useUpstreamCountTokens",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.useUpstreamCountTokens,
  },
  {
    configKey: "retry.max_reactive_retries",
    stateKey: "maxReactiveRetries",
    sampleYamlValue: "7",
    expectedStateValue: 7,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxReactiveRetries,
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
    configKey: "anthropic.strict_response_headers",
    stateKey: "strictResponseHeaders",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.strictResponseHeaders,
  },
  {
    configKey: "anthropic.response_header_blacklist",
    stateKey: "responseHeaderBlacklist",
    // Sample MUST differ from the (empty) default so R1/R2 prove the wiring.
    sampleYamlValue: `\n  - x-resp-drop`,
    expectedStateValue: ["x-resp-drop"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responseHeaderBlacklist,
  },
  {
    configKey: "anthropic.response_header_whitelist",
    stateKey: "responseHeaderWhitelist",
    // Sample MUST differ from the (non-empty) default so R1/R2 prove the wiring.
    sampleYamlValue: `\n  - x-only-resp`,
    expectedStateValue: ["x-only-resp"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responseHeaderWhitelist,
  },
  {
    configKey: "anthropic.strict_request_headers",
    stateKey: "strictRequestHeaders",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.strictRequestHeaders,
  },
  {
    configKey: "anthropic.request_header_blacklist",
    stateKey: "requestHeaderBlacklist",
    // Sample MUST differ from the (non-empty) default ["x-anthropic-billing-header"]
    // so R1/R2 prove the wiring rather than coincidentally matching the default.
    sampleYamlValue: `\n  - x-custom-attr`,
    expectedStateValue: ["x-custom-attr"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.requestHeaderBlacklist,
  },
  {
    configKey: "anthropic.request_header_whitelist",
    stateKey: "requestHeaderWhitelist",
    // Sample MUST differ from the (non-empty) default so R1/R2 prove the wiring.
    sampleYamlValue: `\n  - x-only-this`,
    expectedStateValue: ["x-only-this"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.requestHeaderWhitelist,
  },
  {
    configKey: "anthropic.strip_attribution_header",
    stateKey: "stripAttributionHeader",
    // Sample MUST differ from the default (true) so R1/R2 prove the wiring.
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripAttributionHeader,
  },
  {
    configKey: "anthropic.stream_keepalive_ping_sec",
    stateKey: "streamKeepalivePingSec",
    sampleYamlValue: "15",
    expectedStateValue: 15,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamKeepalivePingSec,
  },
  {
    configKey: "anthropic.stream_keepalive_mode",
    stateKey: "streamKeepaliveMode",
    sampleYamlValue: "ping",
    expectedStateValue: "ping",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode,
  },
  {
    configKey: "anthropic.stream_commit_after_sec",
    stateKey: "streamCommitAfterSec",
    sampleYamlValue: "15",
    expectedStateValue: 15,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec,
  },
  {
    configKey: "anthropic.protect_streaming_generation",
    stateKey: "protectStreamingGeneration",
    sampleYamlValue: "tool_use_only",
    expectedStateValue: "tool_use_only",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration,
  },
  // NOTE: the former protect_streaming_{max_retries,heartbeat,buffer_cap_bytes} scalar
  // FieldSpecs moved out of this registry — they are now the object-shaped
  // bufferedRetryShared / bufferedRetryOverrides state (vendor-neutral shared caps +
  // per-vendor overrides), which the scalar registry can't express. R1/R2/R3 (apply /
  // retain / reset) + legacy-key migration coverage lives in
  // tests/config/buffered-retry-keys.test.ts.
  {
    configKey: "anthropic.protect_streaming_escalate_context",
    stateKey: "protectStreamingEscalateContext",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.protectStreamingEscalateContext,
  },
  {
    configKey: "anthropic.model_capabilities.context_editing",
    stateKey: "contextEditingModels",
    sampleYamlValue: `\n  - claude-opus-4.9\n  - claude-sonnet-5`,
    expectedStateValue: ["claude-opus-4.9", "claude-sonnet-5"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.contextEditingModels,
  },
  {
    configKey: "anthropic.model_capabilities.tool_search_overrides",
    stateKey: "toolSearchOverrides",
    sampleYamlValue: `\n  claude-opus-4.9: true\n  "*": false`,
    // Keys are normalized (dots→dashes) by normalizeModelKeyedRecord; "*" is preserved verbatim.
    expectedStateValue: { "claude-opus-4-9": true, "*": false },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.toolSearchOverrides,
  },
  {
    configKey: "anthropic.model_capabilities.extended_cache_ttl",
    stateKey: "extendedCacheTtlModels",
    sampleYamlValue: `\n  - claude-opus-4.9`,
    expectedStateValue: ["claude-opus-4.9"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlModels,
  },
  {
    configKey: "anthropic.model_capabilities.memory",
    stateKey: "memoryModels",
    sampleYamlValue: `\n  - claude-opus-4.9`,
    expectedStateValue: ["claude-opus-4.9"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.memoryModels,
  },
  {
    configKey: "anthropic.server_tool_memory",
    stateKey: "memoryToolEnabled",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.memoryToolEnabled,
  },
  {
    configKey: "anthropic.extended_cache_ttl.enabled",
    stateKey: "extendedCacheTtlEnabled",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlEnabled,
  },
  {
    configKey: "anthropic.extended_cache_ttl.tools_system_ttl",
    stateKey: "extendedCacheTtlToolsSystem",
    sampleYamlValue: "5m",
    expectedStateValue: "5m",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlToolsSystem,
  },
  {
    configKey: "anthropic.extended_cache_ttl.messages_ttl",
    stateKey: "extendedCacheTtlMessages",
    sampleYamlValue: "1h",
    expectedStateValue: "1h",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.extendedCacheTtlMessages,
  },
  {
    configKey: "anthropic.model_capabilities.interleaved_thinking",
    stateKey: "interleavedThinkingModels",
    sampleYamlValue: `\n  - claude-sonnet-5`,
    expectedStateValue: ["claude-sonnet-5"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.interleavedThinkingModels,
  },
  {
    configKey: "anthropic.model_capabilities.adaptive_thinking",
    stateKey: "adaptiveThinkingModels",
    sampleYamlValue: `\n  - claude-opus-4.9`,
    expectedStateValue: ["claude-opus-4.9"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.adaptiveThinkingModels,
  },
  {
    configKey: "anthropic.tool_inject_claude_code",
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
    configKey: "anthropic.thinking_destack_strategy",
    stateKey: "thinkingDestackStrategy",
    // Sample MUST differ from the default (move_blocks) so R1/R2 prove the wiring.
    sampleYamlValue: "insert_text",
    expectedStateValue: "insert_text",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingDestackStrategy,
  },
  {
    configKey: "anthropic.strip_thinking_on_reject",
    stateKey: "stripThinkingOnReject",
    // Sample MUST differ from the default (true) so R1/R2 prove the wiring.
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripThinkingOnReject,
  },
  {
    configKey: "anthropic.poisoned_thinking_quarantine",
    stateKey: "poisonedThinkingQuarantine",
    // Sample MUST differ from the default (true) so R1/R2 prove the wiring.
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.poisonedThinkingQuarantine,
  },
  {
    configKey: "anthropic.poisoned_thinking_ttl_hours",
    stateKey: "poisonedThinkingTtlHours",
    // Sample MUST differ from the default (72) so R1/R2 prove the wiring.
    sampleYamlValue: "24",
    expectedStateValue: 24,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.poisonedThinkingTtlHours,
  },
  {
    configKey: "anthropic.thinking_block_sanitize",
    stateKey: "thinkingBlockSanitizeCheck",
    sampleYamlValue: "signature_empty",
    expectedStateValue: "signature_empty",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingBlockSanitizeCheck,
  },
  {
    configKey: "anthropic.thinking_coerce_adaptive",
    stateKey: "coerceAdaptiveThinking",
    sampleYamlValue: "best_effort",
    expectedStateValue: "best_effort",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.coerceAdaptiveThinking,
  },
  {
    configKey: "anthropic.system_default_mode",
    stateKey: "systemDefaultMode",
    sampleYamlValue: "merge",
    expectedStateValue: "merge",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.systemDefaultMode,
  },
  {
    configKey: "anthropic.system_reject_models",
    stateKey: "systemRejectModels",
    // Sample MUST differ from the (non-empty) default so R1/R2 prove the wiring.
    sampleYamlValue: `\n  - foo-model`,
    expectedStateValue: ["foo-model"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.systemRejectModels,
  },
  {
    configKey: "anthropic.system_reject_mode",
    stateKey: "systemRejectMode",
    sampleYamlValue: "merge",
    expectedStateValue: "merge",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.systemRejectMode,
  },
  {
    configKey: "anthropic.thinking_signature_compat",
    stateKey: "thinkingSignatureCompat",
    sampleYamlValue: "redacted_thinking",
    expectedStateValue: "redacted_thinking",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.thinkingSignatureCompat,
  },
  {
    configKey: "anthropic.tool_dedup_calls",
    stateKey: "dedupToolCalls",
    sampleYamlValue: "result",
    expectedStateValue: "result",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
  },
  {
    configKey: "anthropic.tool_strip_read_result_tags",
    stateKey: "stripReadToolResultTags",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
  },
  // system_rewrite_reminders covered as boolean here; array case in special-semantics.
  {
    configKey: "anthropic.system_rewrite_reminders",
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
    configKey: "anthropic.tool_search_non_deferred",
    stateKey: "nonDeferredTools",
    sampleYamlValue: `\n  - first_tool\n  - second_tool`,
    expectedStateValue: ["first_tool", "second_tool"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.nonDeferredTools,
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
    configKey: "anthropic.effort_overrides",
    stateKey: "effortsOverrides",
    sampleYamlValue: `\n  "claude-opus-*":\n    - high`,
    expectedStateValue: { "claude-opus-*": ["high"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.effortsOverrides,
  },
  {
    configKey: "anthropic.beta_strip_headers",
    stateKey: "stripBetaHeaders",
    sampleYamlValue: `\n  "*":\n    - context-management-2025-06-27`,
    expectedStateValue: { "*": ["context-management-2025-06-27"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripBetaHeaders,
  },
  {
    configKey: "anthropic.cache_control_strip_subfields",
    stateKey: "stripCacheControlSubfields",
    sampleYamlValue: `\n  "*":\n    - scope`,
    expectedStateValue: { "*": ["scope"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripCacheControlSubfields,
  },
  {
    configKey: "anthropic.partner_strip_features",
    stateKey: "stripPartnerFeatures",
    sampleYamlValue: `\n  "*":\n    - structured_outputs`,
    expectedStateValue: { "*": ["structured_outputs"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripPartnerFeatures,
  },
  {
    configKey: "anthropic.tool_strip_fields",
    stateKey: "stripToolFields",
    sampleYamlValue: `\n  "*":\n    - eager_input_streaming`,
    expectedStateValue: { "*": ["eager_input_streaming"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripToolFields,
  },
  {
    configKey: "anthropic.tool_keep_fields",
    stateKey: "keepToolFields",
    sampleYamlValue: `\n  "*":\n    - eager_input_streaming`,
    expectedStateValue: { "*": ["eager_input_streaming"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.keepToolFields,
  },
  {
    configKey: "anthropic.retry_reject_body_fields",
    stateKey: "rejectBodyFields",
    sampleYamlValue: `\n  "*":\n    - thinking`,
    expectedStateValue: { "*": ["thinking"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.rejectBodyFields,
  },
  {
    configKey: "anthropic.response_tool_use_fix.decode_top_level_field",
    stateKey: "decodeToolInputFields",
    sampleYamlValue: `\n  "MyTool":\n    - foo`,
    expectedStateValue: { MyTool: ["foo"] },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.decodeToolInputFields,
  },
  {
    configKey: "anthropic.response_text_fix.invoke_in_text",
    stateKey: "recoverToolCallText",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.recoverToolCallText,
  },
  {
    configKey: "anthropic.response_tool_use_fix.send_message_to_missing",
    stateKey: "fixSendMessageRecipient",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.fixSendMessageRecipient,
  },
  {
    configKey: "anthropic.response_tool_use_fix.malformed_input",
    stateKey: "toolRepairMalformedInput",
    sampleYamlValue: "tags,jsonrepair",
    expectedStateValue: ["tags", "jsonrepair"],
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.toolRepairMalformedInput,
  },
  {
    configKey: "anthropic.refusal_sse_rewrite",
    stateKey: "refusalSseRewrite",
    sampleYamlValue: "refusal",
    expectedStateValue: "refusal",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalSseRewrite,
  },
  {
    configKey: "anthropic.refusal_end_turn_text",
    stateKey: "refusalEndTurnText",
    sampleYamlValue: "custom {model}",
    expectedStateValue: "custom {model}",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalEndTurnText,
  },
  {
    configKey: "anthropic.refusal_error_message",
    stateKey: "refusalErrorMessage",
    sampleYamlValue: "err {model}",
    expectedStateValue: "err {model}",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalErrorMessage,
  },
  {
    configKey: "anthropic.refusal_error_type",
    stateKey: "refusalErrorType",
    sampleYamlValue: "custom_type",
    expectedStateValue: "custom_type",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalErrorType,
  },
  {
    configKey: "anthropic.error_shaping_enabled",
    stateKey: "errorShapingEnabled",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.errorShapingEnabled,
  },
  {
    configKey: "anthropic.error_ask_user_question",
    stateKey: "errorAskUserQuestion",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.errorAskUserQuestion,
  },
  {
    configKey: "anthropic.error_auq_template",
    stateKey: "errorAuqTemplate",
    sampleYamlValue: "model={model} status={status}",
    expectedStateValue: "model={model} status={status}",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.errorAuqTemplate,
  },
  {
    configKey: "anthropic.error_selfheal_delegate",
    stateKey: "errorSelfhealDelegate",
    sampleYamlValue: `\n  "adaptive-thinking-rejection-retry": delegate`,
    expectedStateValue: { "adaptive-thinking-rejection-retry": "delegate" },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.errorSelfhealDelegate,
  },
  {
    configKey: "anthropic.response_tool_use_fix.ask_user_question_question_missing",
    stateKey: "backfillQuestionFromHeader",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.backfillQuestionFromHeader,
  },

  // ── model_mappings / model_preference / disabled_models ───────────
  {
    configKey: "model_mappings",
    stateKey: "modelMappings",
    sampleYamlValue: `\n  custom-alias: claude-opus-4.6`,
    // merged on top of DEFAULT_MODEL_MAPPINGS
    expectedStateValue: { ...DEFAULT_MODEL_MAPPINGS, "custom-alias": "claude-opus-4.6" },
    defaultStateValue: DEFAULT_MODEL_MAPPINGS,
  },
  {
    // model_translation: retain-on-absence (mirrors model_mappings), but the config
    // schema (RFC 2026-07-14-anthropic-responses-direct-bridge §6.1, Phase 7) is a
    // per-ingress list of rules, not a flat scalar map — applyConfigToState() REPLACES
    // wholesale (no per-key merge like model_mappings; every declared ingress is
    // user-owned) so expectedStateValue is exactly the sample, not merged with any
    // built-in default (DEFAULT_MODEL_TRANSLATION is `{}`).
    configKey: "model_translation",
    stateKey: "modelTranslation",
    sampleYamlValue: `\n  anthropic-messages:\n    - match: gpt-5.5@openai-responses\n      features:\n        - strip-thinking-signature`,
    expectedStateValue: { "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }] },
    defaultStateValue: DEFAULT_MODEL_TRANSLATION,
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
    configKey: "history.raw_capture.enabled",
    stateKey: "historyRawCaptureEnabled",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyRawCaptureEnabled,
  },
  {
    configKey: "history.raw_capture.db_path",
    stateKey: "historyRawCaptureDbPath",
    sampleYamlValue: '"/tmp/raw-hot-reload.db"',
    expectedStateValue: "/tmp/raw-hot-reload.db",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyRawCaptureDbPath,
  },
  {
    configKey: "history.raw_capture.max_object_bytes",
    stateKey: "historyRawCaptureMaxObjectBytes",
    sampleYamlValue: "1048576",
    expectedStateValue: 1048576,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.historyRawCaptureMaxObjectBytes,
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

  // ── hooks.* (declarative only — see applyConfigToState) ─────────────
  {
    configKey: "hooks.upstream_module",
    stateKey: "hooksUpstreamModule",
    sampleYamlValue: '"./exp/my-hook.ts"',
    expectedStateValue: "./exp/my-hook.ts",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.hooksUpstreamModule,
  },
  {
    configKey: "hooks.enabled",
    stateKey: "hooksEnabled",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.hooksEnabled,
  },

  // ── openai_responses.* ─────────────────────────────────────────────
  {
    configKey: "openai_responses.normalize_call_ids",
    stateKey: "normalizeResponsesCallIds",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  },
  {
    configKey: "openai_responses.upstream_ws",
    stateKey: "upstreamWebSocket",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
  },
  {
    configKey: "openai_responses.buffered_retry",
    stateKey: "responsesBufferedRetry",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry,
  },
  {
    configKey: "openai_responses.fix_stream_ids",
    stateKey: "fixResponsesStreamIds",
    sampleYamlValue: "false",
    expectedStateValue: false,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
  },
  {
    configKey: "openai_responses.strip_image_generation_tool",
    stateKey: "stripImageGenerationTool",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
  },
  {
    configKey: "openai_responses.buffered_merge.event_compaction",
    stateKey: "responsesBufferedMergeEventCompaction",
    sampleYamlValue: "item-summary",
    expectedStateValue: "item-summary",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeEventCompaction,
  },
  {
    configKey: "openai_responses.buffered_merge.completed_output",
    stateKey: "responsesBufferedMergeCompletedOutput",
    sampleYamlValue: "rebuild",
    expectedStateValue: "rebuild",
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.responsesBufferedMergeCompletedOutput,
  },
  {
    configKey: "server.responses_ws.keep_open",
    stateKey: "clientWebsocketKeepOpen",
    sampleYamlValue: "true",
    expectedStateValue: true,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
  },
  {
    configKey: "server.responses_ws.max_frame_bytes",
    stateKey: "maxWsFrameBytes",
    sampleYamlValue: "2097152",
    expectedStateValue: 2097152,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
  },
  {
    configKey: "server.responses_ws.max_connections",
    stateKey: "maxClientWsConnections",
    sampleYamlValue: "128",
    expectedStateValue: 128,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
  },
  {
    // days → ms in config.ts (0 → Infinity).
    configKey: "negotiation_learning.default_ttl_days",
    stateKey: "negotiationDefaultTtlMs",
    sampleYamlValue: "7",
    expectedStateValue: 7 * 86_400_000,
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.negotiationDefaultTtlMs,
  },
  {
    // ttl_days keyed by internal category id (camelCase); the whole overrides map
    // is replaced, so only toolFields remains after applying this sample.
    configKey: "negotiation_learning.ttl_days",
    stateKey: "negotiationTtlOverridesMs",
    sampleYamlValue: `\n  toolFields: 10`,
    expectedStateValue: { toolFields: 10 * 86_400_000 },
    defaultStateValue: CONFIG_MANAGED_DEFAULTS.negotiationTtlOverridesMs,
  },
]

interface ExemptField {
  configKey: string
  reason: string
}

const EXEMPT: ReadonlyArray<ExemptField> = [
  {
    configKey: "logging.terminal_level",
    reason: "nested state.logging field; dedicated structured logging config test below covers apply/retain/reset",
  },
  {
    configKey: "logging.file_level",
    reason: "see logging.terminal_level",
  },
  {
    configKey: "logging.file.enabled",
    reason: "startup artifact policy nested under state.logging; dedicated structured logging config test",
  },
  {
    configKey: "logging.file.directory",
    reason: "see logging.file.enabled",
  },
  {
    configKey: "logging.file.max_size_mb",
    reason: "see logging.file.enabled",
  },
  {
    configKey: "logging.file.max_files_per_process",
    reason: "see logging.file.enabled",
  },
  {
    configKey: "logging.file.retention_days",
    reason: "see logging.file.enabled",
  },
  {
    configKey: "tui.enabled",
    reason: "startup capability nested as state.tuiEnabled; dedicated structured logging config test",
  },
  {
    configKey: "unknown_endpoint_logging.not_found",
    reason:
      "nested object sub-key → state.unknownEndpointLogging.notFound; config→state + null-delete + default(warn) + retain-on-absence in unknown-endpoint-logging-config.unit.test.ts, PUT-write path in config-yaml-routes.http.test.ts",
  },
  {
    configKey: "unknown_endpoint_logging.method_not_allowed",
    reason: "see unknown_endpoint_logging.not_found — same dedicated + PUT-write test files",
  },
  {
    configKey: "history.enabled",
    reason:
      "STARTUP-ONLY master switch: applied to state.historyEnabled only at boot (hasApplied=false); read once in start.ts to gate initHistory. A runtime change warns + requires a restart (mirrors proxy / ghc_api_base_url). Boot-apply + hot-reload-warn covered in tests/config/history-enabled-config.unit.test.ts",
  },
  {
    configKey: "history.limit",
    reason:
      "Deprecated legacy key; no dedicated state field — falls back to success_limit/failure_limit (covered by the 'legacy history.limit falls back' test)",
  },
  {
    configKey: "history.persist_retry.max_attempts",
    reason:
      "DI-5 module-local retry budget fed directly to setV3PersistRetryConfig (no state field, avoids a store→state cycle). config→setter wiring covered by tests/config/history-persist-retry-config.unit.test.ts; setter→retry behavior by tests/history/v3/transient-retry.it.test.ts",
  },
  {
    configKey: "history.persist_retry.backoff_ms",
    reason: "DI-5 module-local retry budget — see history.persist_retry.max_attempts above (same setV3PersistRetryConfig wiring)",
  },
  {
    configKey: "history.persist_retry.max_total_ms",
    reason: "DI-5-followup-2 module-local retry budget — see history.persist_retry.max_attempts above (same setV3PersistRetryConfig wiring)",
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
    configKey: "pidfile",
    reason: "Graceful-restart bare-metal pidfile path override; read once at boot (Task 12 wiring), not part of hot reload",
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
    configKey: "rate_limiter.recovery_interval",
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
  // Buffered-retry caps + mode switches map to the object-shaped bufferedRetryShared /
  // bufferedRetryOverrides state (+ per-vendor `enabled`), which the scalar FieldSpec
  // registry can't express. R1/R2/R3 + legacy-key migration coverage lives in
  // tests/config/buffered-retry-keys.test.ts.
  { configKey: "buffered_retry.enabled", reason: "shared caps have no mode switch; `enabled` ignored — see buffered-retry-keys.test.ts" },
  { configKey: "buffered_retry.max_retries", reason: "vendor-neutral shared cap → bufferedRetryShared; see buffered-retry-keys.test.ts" },
  { configKey: "buffered_retry.buffer_cap_bytes", reason: "vendor-neutral shared cap → bufferedRetryShared; see buffered-retry-keys.test.ts" },
  { configKey: "buffered_retry.heartbeat_sec", reason: "vendor-neutral shared cap → bufferedRetryShared; see buffered-retry-keys.test.ts" },
  {
    configKey: "anthropic.buffered_retry.enabled",
    reason: "Anthropic's switch is protect_streaming_generation; `enabled` ignored — see buffered-retry-keys.test.ts",
  },
  { configKey: "anthropic.buffered_retry.max_retries", reason: "per-vendor cap override → bufferedRetryOverrides.anthropic; see buffered-retry-keys.test.ts" },
  {
    configKey: "anthropic.buffered_retry.buffer_cap_bytes",
    reason: "per-vendor cap override → bufferedRetryOverrides.anthropic; see buffered-retry-keys.test.ts",
  },
  {
    configKey: "anthropic.buffered_retry.heartbeat_sec",
    reason: "per-vendor cap override → bufferedRetryOverrides.anthropic; see buffered-retry-keys.test.ts",
  },
  {
    configKey: "chat_completions.buffered_retry",
    reason: "bool|map mode switch + caps → chatCompletionsBufferedRetry + bufferedRetryOverrides.chat_completions; see buffered-retry-keys.test.ts",
  },
  // Generation runtime is an object-shaped, relation-validated patch (total >= active,
  // primary + secondary <= active), so it cannot use the scalar FieldSpec registry.
  // Parsing, frozen per-request snapshots, disabled-timeout fallback, and state reset are
  // covered by generation-runtime-config.unit.test.ts.
  { configKey: "generation.hedge.enabled", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.hedge.threshold_sec", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.hedge.max_secondary_candidates", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.hedge.allow_server_tools", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.recovery.max_candidates", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.max_active_candidates", reason: "relation-validated generation budget; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.max_active_dispatches", reason: "relation-validated generation budget; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.max_total_candidates", reason: "relation-validated generation budget; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.max_total_dispatches", reason: "relation-validated generation budget; see generation-runtime-config.unit.test.ts" },
  { configKey: "generation.cleanup_grace_sec", reason: "object-shaped generation runtime; see generation-runtime-config.unit.test.ts" },
  {
    configKey: "retry.strategies",
    reason:
      "enum-keyed Record<configKey,{enabled}> (RFC 2026-07-21-retry-strategy-registry §3.4, plan Task 4) — apply/retain-on-absence/reset + typo'd-key schema rejection + allow-and-warn-on-shared-strategy-disable + end-to-end assembleRetryStrategies wiring all covered in tests/config/retry-strategies.it.test.ts",
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
  beforeAll(async () => {
    // initHistory must run before any test that calls applyConfigToState() with
    // history settings — the per-test beforeEach already does this, but
    // beforeAll documents intent for the suite.
    await initHistory(true, 200)
  })

  test("structured logging and tui config apply, retain on absence, and reset", async () => {
    await writeConfig(`
logging:
  terminal_level: trace
  file_level: error
  file:
    enabled: false
    directory: /tmp/diagnostic-test
    max_size_mb: 0
    max_files_per_process: 2
    retention_days: 30
tui:
  enabled: false
`)
    await applyConfigToState()
    expect(state.logging).toEqual({
      terminalLevel: "trace",
      fileLevel: "error",
      fileEnabled: false,
      fileDirectory: "/tmp/diagnostic-test",
      fileMaxSizeMb: 0,
      fileMaxFilesPerProcess: 2,
      retentionDays: 30,
    })
    expect(state.tuiEnabled).toBe(false)

    resetConfigCache()
    await writeConfig(`
logging:
  terminal_level: warn
  file:
    enabled: true
    directory: /tmp/must-not-activate
tui:
  enabled: true
`)
    await applyConfigToState()
    expect(state.logging.terminalLevel).toBe("warn") // level is live
    expect(state.logging.fileEnabled).toBe(false) // writer shape stays frozen
    expect(state.logging.fileDirectory).toBe("/tmp/diagnostic-test")
    expect(state.tuiEnabled).toBe(false)

    resetConfigCache()
    await writeConfig("")
    await applyConfigToState()
    expect(state.logging.terminalLevel).toBe("warn")
    expect(state.tuiEnabled).toBe(false)

    resetConfigManagedState()
    expect(state.logging).toEqual(CONFIG_MANAGED_DEFAULTS.logging)
    expect(state.tuiEnabled).toBe(CONFIG_MANAGED_DEFAULTS.tuiEnabled)
  })

  test("tool_dedup_calls: true normalizes to 'input'", async () => {
    await writeConfig("anthropic:\n  tool_dedup_calls: true\n")
    await applyConfigToState()
    expect(state.dedupToolCalls).toBe("input")
  })

  test("system_rewrite_reminders: array compiles to CompiledRewriteRule[]", async () => {
    await writeConfig(`
anthropic:
  system_rewrite_reminders:
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

  test("model_refresh_interval: 0 disables the refresh loop", async () => {
    await writeConfig("model_refresh_interval: 0\n")
    await applyConfigToState()
    expect(state.modelRefreshInterval).toBe(0)
  })

  test("empty config does not mutate any pre-existing runtime state", async () => {
    setStateForTests({
      responseHeaderTimeout: 99,
      modelMappings: { opus: "custom-model" },
      systemPromptOverrides: [{ from: /test/, to: "keep" }],
      disabledModels: ["foo"],
    })
    await writeConfig("")
    await applyConfigToState()

    expect(state.responseHeaderTimeout).toBe(99)
    expect(state.modelMappings.opus).toBe("custom-model")
    expect(state.systemPromptOverrides).toHaveLength(1)
    expect(state.disabledModels).toEqual(["foo"])
  })

  test("missing config file does not mutate state", async () => {
    setStateForTests({ modelMappings: { opus: "custom-model" } })
    await removeConfig()
    await applyConfigToState()
    expect(state.modelMappings.opus).toBe("custom-model")
  })

  test("disabled_models retain semantic: writing one field doesn't wipe a previously-set list", async () => {
    // Regression guard for the Part-A behaviour change.
    await writeConfig("disabled_models:\n  - foo\n")
    await applyConfigToState()
    expect(state.disabledModels).toEqual(["foo"])

    resetConfigCache()
    await writeConfig("timeouts:\n  response_header: 30\n")
    await applyConfigToState()

    expect(state.responseHeaderTimeout).toBe(30)
    expect(state.disabledModels).toEqual(["foo"]) // NOT cleared
  })

  test("resetConfigManagedState restores model_mappings to DEFAULT_MODEL_MAPPINGS", () => {
    setStateForTests({ modelMappings: { custom: "model" } })
    resetConfigManagedState()
    expect(state.modelMappings).toEqual(DEFAULT_MODEL_MAPPINGS)
  })

  test("system_reject_* defaults are the empirically-confirmed reject set + as_user", () => {
    resetConfigManagedState()
    expect(state.systemRejectModels).toEqual(["claude-sonnet-4.6", "claude-haiku-4.5"])
    expect(state.systemRejectMode).toBe("as_user")
  })

  test("CONFIG_MANAGED_DEFAULTS stays aligned with initial mutable state", () => {
    // Sanity guard against drift in state.ts initializer.
    expect(state.thinkingBlockMessagePolicy).toBe(CONFIG_MANAGED_DEFAULTS.thinkingBlockMessagePolicy)
    expect(state.responseHeaderTimeout).toBe(CONFIG_MANAGED_DEFAULTS.responseHeaderTimeout)
    expect(state.streamIdleTimeout).toBe(CONFIG_MANAGED_DEFAULTS.streamIdleTimeout)
  })
})
