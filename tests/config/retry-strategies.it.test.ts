/**
 * Task 4 (Commit 4) — `retry.strategies` per-strategy config opt-out (RFC 2026-07-21-retry-strategy-registry
 * §3.4, plan Task 4).
 *
 * Covers the 3 touch points (mirrors `error-shaping-config.unit.test.ts`'s structure):
 *   - schema.ts: `RetryConfigSchema.strategies` zod validation — enum-keyed record (typo'd `configKey` is a
 *     hard schema error, not a silently-ignored no-op switch), `.strict()` switch shape.
 *   - config.ts + state.ts: `applyConfigToState()` → `state.retryStrategies` wiring (config-file driven, not
 *     a direct `setStateForTests` poke — aligns with the project's config-hot-reload test convention) +
 *     retain-on-absence + `resetConfigManagedState()` reset.
 *   - end-to-end through the real registry consumer (`buildAnthropicStrategies` / `assembleRetryStrategies`):
 *     disabling a strategy via `config.yaml` actually removes it from the assembled stack, and the
 *     default-empty-config case stays byte-equivalent to the pre-Task-4 golden (16-on).
 *   - "allow + warn" (RFC §3.4 decision 2): disabling a SHARED strategy (network/serverError/tokenRefresh)
 *     is allowed but warns once per apply via `consola.warn`.
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

import type { SanitizeResult } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { RetryConfigSchema } from "~/lib/config/schema"
import { RETRY_STRATEGY_ORDER } from "~/lib/request/retry-registry"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"

/** The frozen 16-name @messages order (same fixture as the Task 1 golden / Task 2 unit test). */
const ANTHROPIC_16_NAMES = [
  "network-retry",
  "server-error-retry",
  "token-refresh",
  "effort-learning",
  "tool-field-rejection-retry",
  "body-field-rejection-retry",
  "cache-control-subfield-rejection-retry",
  "legacy-thinking-retry",
  "adaptive-thinking-rejection-retry",
  "poisoned-thinking-retry",
  "unsupported-beta-retry",
  "server-tool-rejection-retry",
  "structured-outputs-rejection-retry",
  "system-reject-retry",
  "web-search-not-found-retry",
  "deferred-tool-retry",
]

const stubResanitize = (p: MessagesPayload): SanitizeResult<MessagesPayload> => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 })
const anthropicBaseline = { model: "claude-sonnet-4", messages: [], max_tokens: 100 } as unknown as MessagesPayload

function buildAnthropic16(): Array<string> {
  return buildAnthropicStrategies({
    originalPayload: anthropicBaseline,
    resanitize: stubResanitize,
    model: undefined,
    maxRetries: 5,
    betaProbe: createBetaProbe(undefined),
  }).map((s) => s.name)
}

// ============================================================================
// Schema
// ============================================================================

describe("RetryConfigSchema.strategies", () => {
  test("has exactly 16 configKeys, one per RETRY_STRATEGY_ORDER — parity guard against retry-registry.ts drift", () => {
    // Parse a strategies map keyed by every RETRY_STRATEGY_ORDER key — if the schema's enum drifted out of
    // sync with the registry's declared configKeys, this rejects (invalid_key) BEFORE the drift ever ships.
    const allKeysMap = Object.fromEntries(Object.keys(RETRY_STRATEGY_ORDER).map((k) => [k, { enabled: false }]))
    const parsed = RetryConfigSchema.parse({ strategies: allKeysMap })
    expect(Object.keys(parsed.strategies ?? {})).toHaveLength(16)
    expect(new Set(Object.keys(parsed.strategies ?? {}))).toEqual(new Set(Object.keys(RETRY_STRATEGY_ORDER)))
  })

  test("accepts a valid configKey with enabled:false", () => {
    const parsed = RetryConfigSchema.parse({ strategies: { serverToolRejection: { enabled: false } } })
    expect(parsed.strategies).toEqual({ serverToolRejection: { enabled: false } })
  })

  test("rejects an unknown configKey (typo) — hard schema error, not a silently-ignored no-op switch", () => {
    expect(() => RetryConfigSchema.parse({ strategies: { srver_tool_rejection: { enabled: false } } })).toThrow()
  })

  test("rejects an unknown sub-field on a switch (strict shape — only `enabled` exposed, not `order`)", () => {
    expect(() => RetryConfigSchema.parse({ strategies: { network: { order: 999 } } })).toThrow()
  })

  test("absent `strategies` section parses to undefined", () => {
    const parsed = RetryConfigSchema.parse({})
    expect(parsed.strategies).toBeUndefined()
  })
})

// ============================================================================
// config.ts + state.ts wiring — isolated tmp-dir harness (mirrors error-shaping-config.unit.test.ts)
// ============================================================================

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState: StateSnapshot = snapshotStateForTests()

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "retry-strategies-config-"))
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

describe("retry.strategies → state.retryStrategies (config-driven, not setStateForTests)", () => {
  test("默认无 retry.strategies → state.retryStrategies stays {} → golden 等价（16 全在）", async () => {
    await writeConfig("retry: {}\n")
    await applyConfigToState()
    expect(state.retryStrategies).toEqual({})
    expect(buildAnthropic16()).toEqual(ANTHROPIC_16_NAMES)
  })

  test("禁用 server_tool_rejection（configKey: serverToolRejection）→ 组装集少它、其余 15 顺序不变", async () => {
    await writeConfig("retry:\n  strategies:\n    serverToolRejection:\n      enabled: false\n")
    await applyConfigToState()
    expect(state.retryStrategies).toEqual({ serverToolRejection: { enabled: false } })
    const names = buildAnthropic16()
    expect(names).not.toContain("server-tool-rejection-retry")
    expect(names).toEqual(ANTHROPIC_16_NAMES.filter((n) => n !== "server-tool-rejection-retry"))
  })

  test("未知策略键（config.yaml 手改打字错）→ schema 报错、字段被剥离（warn-and-continue，不崩服务）", async () => {
    await writeConfig("retry:\n  strategies:\n    srver_tool_rejection:\n      enabled: false\n")
    await applyConfigToState()
    // cleanInvalidPaths strips the bad key on the recovery re-parse; the whole `retry` section still applies
    // (retryStrategies ends up {} — the sole offending entry was dropped, not the entire config load aborted).
    expect(state.retryStrategies).toEqual({})
    expect(buildAnthropic16()).toEqual(ANTHROPIC_16_NAMES)
  })

  test("hot-reload: retain-on-absence（第二次空 reload 保留上次值，仅 resetConfigManagedState 清空）", async () => {
    await writeConfig("retry:\n  strategies:\n    deferredTool:\n      enabled: false\n")
    await applyConfigToState()
    expect(state.retryStrategies).toEqual({ deferredTool: { enabled: false } })

    resetConfigCache()
    await writeConfig("") // second load (hot-reload) — every key absent
    await applyConfigToState()
    expect(state.retryStrategies).toEqual({ deferredTool: { enabled: false } })

    resetConfigManagedState()
    expect(state.retryStrategies).toEqual({})
  })

  test("禁用被依赖的 SHARED 策略（token_refresh）→ allow + consola.warn（internal-tool 姿态，绝不阻塞）", async () => {
    const warnSpy = spyOn(consola, "warn")
    try {
      await writeConfig("retry:\n  strategies:\n    tokenRefresh:\n      enabled: false\n")
      await applyConfigToState()
      expect(state.retryStrategies).toEqual({ tokenRefresh: { enabled: false } })
      // Allow — the request still proceeds (assembler just omits token-refresh); assert the strategy is
      // actually gone from the assembled stack (the "allow" half of allow+warn).
      expect(buildAnthropic16()).not.toContain("token-refresh")
      // Warn — at least one consola.warn call mentions the disabled shared strategy + retry.strategies.
      const messages = warnSpy.mock.calls.map((args) => String(args[0]))
      expect(messages.some((m) => m.includes("retry.strategies") && m.includes("tokenRefresh"))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("禁用 anthropic-only 策略（非 shared）→ 不触发 allow+warn（无跨协议 blast radius）", async () => {
    const warnSpy = spyOn(consola, "warn")
    try {
      await writeConfig("retry:\n  strategies:\n    deferredTool:\n      enabled: false\n")
      await applyConfigToState()
      const messages = warnSpy.mock.calls.map((args) => String(args[0]))
      expect(messages.some((m) => m.includes("retry.strategies"))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
