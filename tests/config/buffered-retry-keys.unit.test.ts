/**
 * P0 Task 3 — shared `buffered_retry.*` config keys + per-vendor overrides +
 * one-time legacy-key migration.
 *
 * Covers the frozen contract (plan README):
 *   resolveBufferedCaps(vendor) — priority: per-vendor override > shared
 *     `buffered_retry.*` > built-in default (3 / 16_777_216 / 15).
 *   state.chatCompletionsBufferedRetry — new mode switch, default false.
 *   Legacy `protect_streaming_{max_retries,heartbeat,buffer_cap_bytes}` migrate
 *     one-time into the shared/anthropic caps (no double-track).
 *   R1 behavior neutrality — `resolveBufferedCaps("anthropic")` reproduces the
 *     old `protectStreaming*` scalar values byte-for-byte when config is unchanged.
 *
 * Uses the same isolated tmp-dir + real applyConfigToState() path as
 * config-hot-reload.it.test.ts (loadConfig reads PATHS.CONFIG_YAML).
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
  applyConfigToState,
  clampCommitWindowSec,
  clampKeepaliveCadence,
  COMMIT_WINDOW_MAX_SEC,
  KEEPALIVE_CADENCE_MAX,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import {
  //
  resolveBufferedCaps,
  resolveContinuation,
} from "~/lib/config/model-overrides"
import { PATHS } from "~/lib/config/paths"
import {
  //
  resetConfigManagedState,
  restoreStateForTests,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"
import { CONFIG_MANAGED_DEFAULTS } from "~/lib/state-defaults"

// ============================================================================
// Isolated tmp-dir harness (mirrors config-hot-reload.it.test.ts)
// ============================================================================

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let originalState: StateSnapshot = snapshotStateForTests()

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

/** Reset config-managed state to built-in defaults, write YAML, apply it. */
async function applyYaml(content: string): Promise<void> {
  resetConfigManagedState()
  await writeConfig(content)
  resetConfigCache()
  await applyConfigToState()
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "buffered-retry-keys-"))
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

// ============================================================================
// Delayed-commit and keepalive cadence clamps
// ============================================================================

describe("stream commit and keepalive clamps", () => {
  test("commit-window and keepalive clamps each emit their own first warning", () => {
    const warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
    try {
      expect(clampCommitWindowSec(COMMIT_WINDOW_MAX_SEC + 1)).toBe(COMMIT_WINDOW_MAX_SEC)
      expect(clampKeepaliveCadence(KEEPALIVE_CADENCE_MAX + 1)).toBe(KEEPALIVE_CADENCE_MAX)
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy.mock.calls[0]?.[0]).toContain("delayed-commit window")
      expect(warnSpy.mock.calls[1]?.[0]).toContain("keepalive interval")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("commit-window ceiling sits under Q1's measured CC pre-header limit, independently of keepalive cadence", async () => {
    // Q1 measured the pre-header abort at ~300s (undici's default headersTimeout, not any
    // Anthropic-level timer — exp/silence-recovery-gates/FINDINGS.md). The ceiling keeps a
    // deliberate margin under it: hitting it aborts the whole attempt.
    expect(COMMIT_WINDOW_MAX_SEC).toBe(240)
    expect(KEEPALIVE_CADENCE_MAX).toBe(40)
    expect(clampCommitWindowSec(241)).toBe(COMMIT_WINDOW_MAX_SEC)
    expect(clampKeepaliveCadence(50)).toBe(KEEPALIVE_CADENCE_MAX)

    await applyYaml(``)
    expect(state.streamCommitAfterSec).toBe(180)

    await applyYaml(`anthropic:\n  stream_commit_after_sec: 241\n  stream_keepalive_ping_sec: 50\n`)
    expect(state.streamCommitAfterSec).toBe(COMMIT_WINDOW_MAX_SEC)
    expect(state.streamKeepalivePingSec).toBe(KEEPALIVE_CADENCE_MAX)
  })

  test("the default commit window stays clear of the measured pre-header limit", () => {
    // The window and the limit are on the same clock: the proxy sends nothing until it commits,
    // so a default at or above the limit would abort every slow request instead of committing.
    const MEASURED_PRE_HEADER_ABORT_SEC = 300
    expect(CONFIG_MANAGED_DEFAULTS.streamCommitAfterSec).toBeLessThan(COMMIT_WINDOW_MAX_SEC)
    expect(COMMIT_WINDOW_MAX_SEC).toBeLessThan(MEASURED_PRE_HEADER_ABORT_SEC)
  })
})

// ============================================================================
// Priority: per-vendor override > shared > built-in default
// ============================================================================

describe("resolveBufferedCaps priority", () => {
  test("per-vendor override > shared > builtin default", async () => {
    await applyYaml(`buffered_retry:\n  max_retries: 5\nanthropic:\n  buffered_retry:\n    max_retries: 9\n`)
    expect(resolveBufferedCaps("anthropic").maxRetries).toBe(9) // per-vendor override
    expect(resolveBufferedCaps("responses").maxRetries).toBe(5) // shared
    expect(resolveBufferedCaps("chat_completions").bufferCapBytes).toBe(16_777_216) // builtin default
  })

  test("built-in defaults with no config", async () => {
    await applyYaml(``)
    for (const vendor of ["anthropic", "responses", "chat_completions", "responses_ws"]) {
      expect(resolveBufferedCaps(vendor)).toEqual({ maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 })
    }
  })

  test("shared caps apply to every vendor without an override", async () => {
    await applyYaml(`buffered_retry:\n  max_retries: 7\n  buffer_cap_bytes: 1024\n  heartbeat_sec: 25\n`)
    for (const vendor of ["anthropic", "responses", "chat_completions"]) {
      expect(resolveBufferedCaps(vendor)).toEqual({ maxRetries: 7, bufferCapBytes: 1024, heartbeatSec: 25 })
    }
  })

  test("per-vendor override only shadows the fields it sets", async () => {
    await applyYaml(`buffered_retry:\n  max_retries: 7\n  heartbeat_sec: 25\nopenai_responses:\n  buffered_retry:\n    buffer_cap_bytes: 2048\n`)
    // responses override only sets buffer_cap_bytes; max_retries/heartbeat fall through to shared.
    expect(resolveBufferedCaps("responses")).toEqual({ maxRetries: 7, bufferCapBytes: 2048, heartbeatSec: 25 })
    // anthropic (no override) = pure shared.
    expect(resolveBufferedCaps("anthropic")).toEqual({ maxRetries: 7, bufferCapBytes: 16_777_216, heartbeatSec: 25 })
  })

  test("a per-vendor override of 0 (unlimited / no-retry) is preserved, NOT treated as unset", async () => {
    // 0 is a meaningful value (buffer_cap_bytes 0 = unlimited; max_retries 0 = no retry). The
    // resolver uses `??` (nullish), so a falsy 0 must shadow the shared default rather than fall through.
    await applyYaml(`buffered_retry:\n  max_retries: 5\n  buffer_cap_bytes: 999\nanthropic:\n  buffered_retry:\n    max_retries: 0\n    buffer_cap_bytes: 0\n`)
    expect(resolveBufferedCaps("anthropic").maxRetries).toBe(0)
    expect(resolveBufferedCaps("anthropic").bufferCapBytes).toBe(0)
  })
})

// ============================================================================
// enabled mode switches (responses / chat_completions)
// ============================================================================

describe("buffered_retry.enabled mode switches", () => {
  // 2026-07-14 P3 default flip: chat_completions.buffered_retry now defaults to
  // true (buffering/generation-preservation over the downstream streaming UX).
  test("chat_completions default on", async () => {
    await applyYaml(``)
    expect(state.chatCompletionsBufferedRetry).toBe(true)
  })

  test("chat_completions can opt back into live (unbuffered) forwarding via explicit false", async () => {
    await applyYaml(`chat_completions:\n  buffered_retry: false\n`)
    expect(state.chatCompletionsBufferedRetry).toBe(false)
  })

  test("openai_responses.buffered_retry boolean shorthand = enabled", async () => {
    await applyYaml(`openai_responses:\n  buffered_retry: true\n`)
    expect(state.responsesBufferedRetry).toBe(true)
  })

  test("openai_responses.buffered_retry map with enabled + caps", async () => {
    await applyYaml(`openai_responses:\n  buffered_retry:\n    enabled: true\n    max_retries: 4\n`)
    expect(state.responsesBufferedRetry).toBe(true)
    expect(resolveBufferedCaps("responses").maxRetries).toBe(4)
  })

  test("chat_completions.buffered_retry map with enabled + caps", async () => {
    await applyYaml(`chat_completions:\n  buffered_retry:\n    enabled: true\n    buffer_cap_bytes: 512\n`)
    expect(state.chatCompletionsBufferedRetry).toBe(true)
    expect(resolveBufferedCaps("chat_completions").bufferCapBytes).toBe(512)
  })

  test("chat_completions.buffered_retry boolean shorthand = enabled", async () => {
    await applyYaml(`chat_completions:\n  buffered_retry: true\n`)
    expect(state.chatCompletionsBufferedRetry).toBe(true)
  })
})

// ============================================================================
// One-time legacy-key migration
// ============================================================================

describe("legacy protect_streaming_* key migration", () => {
  test("protect_streaming_max_retries migrates to shared buffered_retry.max_retries", async () => {
    await applyYaml(`anthropic:\n  protect_streaming_max_retries: 7\n`)
    expect(resolveBufferedCaps("anthropic").maxRetries).toBe(7)
  })

  test("protect_streaming_heartbeat migrates (with keepalive clamp) to anthropic override heartbeat_sec", async () => {
    await applyYaml(`anthropic:\n  protect_streaming_heartbeat: 30\n`)
    expect(resolveBufferedCaps("anthropic").heartbeatSec).toBe(30)
  })

  test("a heartbeat above the keepalive-cadence ceiling is clamped (in mapBufferedCaps)", async () => {
    // clampKeepaliveCadence ceiling = CLIENT_IDLE_DEADLINE_SEC(60) - 20 = 40. Locks that the
    // clamp lives in the config-read path (mapBufferedCaps), covering both the shared key and
    // the migrated legacy key (same clamp).
    await applyYaml(`buffered_retry:\n  heartbeat_sec: 50\n`)
    expect(resolveBufferedCaps("anthropic").heartbeatSec).toBe(40)
    await applyYaml(`anthropic:\n  protect_streaming_heartbeat: 55\n`)
    expect(resolveBufferedCaps("anthropic").heartbeatSec).toBe(40)
  })

  test("protect_streaming_buffer_cap_bytes migrates to anthropic override buffer_cap_bytes", async () => {
    await applyYaml(`anthropic:\n  protect_streaming_buffer_cap_bytes: 8388608\n`)
    expect(resolveBufferedCaps("anthropic").bufferCapBytes).toBe(8_388_608)
  })

  test("a user-set new key wins over the migrated legacy value (missing-only merge)", async () => {
    await applyYaml(`anthropic:\n  protect_streaming_max_retries: 7\n  buffered_retry:\n    max_retries: 2\n`)
    expect(resolveBufferedCaps("anthropic").maxRetries).toBe(2)
  })
})

// ============================================================================
// R1 behavior neutrality — resolveBufferedCaps("anthropic") reproduces the old
// protectStreaming* scalar defaults when config is unchanged.
// ============================================================================

describe("R1 behavior neutrality", () => {
  test("unchanged config → anthropic caps === old scalar defaults", async () => {
    await applyYaml(``)
    expect(resolveBufferedCaps("anthropic")).toEqual({
      maxRetries: 3, // old protectStreamingMaxRetries default
      bufferCapBytes: 16_777_216, // old protectStreamingBufferCapBytes default
      heartbeatSec: 15, // old protectStreamingHeartbeat default
    })
  })
})

// ============================================================================
// Retain-on-absence (R2) + reset-to-default (R3) for the object-shaped state
// (these moved out of the scalar hot-reload FieldSpec registry).
// ============================================================================

describe("retain-on-absence + reset", () => {
  test("applying a config WITHOUT buffered_retry retains the prior runtime value (no reset between applies)", async () => {
    // First apply sets a shared override + a per-vendor override.
    resetConfigManagedState()
    await writeConfig(`buffered_retry:\n  max_retries: 8\nanthropic:\n  buffered_retry:\n    heartbeat_sec: 40\n`)
    resetConfigCache()
    await applyConfigToState()
    expect(resolveBufferedCaps("anthropic")).toEqual({ maxRetries: 8, bufferCapBytes: 16_777_216, heartbeatSec: 40 })

    // Second apply (NO reset) omits the keys entirely → prior runtime values retained.
    await writeConfig(`sanitize_tool_names: true\n`)
    resetConfigCache()
    await applyConfigToState()
    expect(resolveBufferedCaps("anthropic")).toEqual({ maxRetries: 8, bufferCapBytes: 16_777_216, heartbeatSec: 40 })
  })

  test("resetConfigManagedState() restores built-in defaults", async () => {
    // chat_completions.buffered_retry built-in default is now `true` (2026-07-14 flip); explicitly
    // set `false` first so this test can prove reset restores the built-in default (true), not just
    // hold a value steady.
    await applyYaml(`buffered_retry:\n  max_retries: 8\nchat_completions:\n  buffered_retry: false\n`)
    expect(resolveBufferedCaps("anthropic").maxRetries).toBe(8)
    expect(state.chatCompletionsBufferedRetry).toBe(false)

    resetConfigManagedState()
    expect(resolveBufferedCaps("anthropic")).toEqual({ maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 })
    expect(state.bufferedRetryOverrides).toEqual({})
    expect(state.chatCompletionsBufferedRetry).toBe(true)
  })
})

// ============================================================================
// Continuation settings (spec 2026-07-22): shared + per-vendor, full apply path
// ============================================================================

describe("resolveContinuation via applyConfigToState", () => {
  test("built-in defaults with no config: enabled true, default message, every vendor", async () => {
    await applyYaml(``)
    for (const vendor of ["anthropic", "responses", "chat_completions"]) {
      expect(resolveContinuation(vendor)).toEqual({ enabled: true, message: "network issue. please continue" })
    }
  })

  test("shared continuation applies to every vendor without an override", async () => {
    await applyYaml(`buffered_retry:\n  continuation:\n    message: "please continue"\n`)
    expect(resolveContinuation("responses").message).toBe("please continue")
    expect(resolveContinuation("chat_completions").message).toBe("please continue")
    expect(resolveContinuation("responses").enabled).toBe(true) // untouched default
  })

  test("per-vendor override > shared > default", async () => {
    await applyYaml(`buffered_retry:\n  continuation:\n    message: "shared"\nanthropic:\n  buffered_retry:\n    continuation:\n      enabled: false\n`)
    expect(resolveContinuation("anthropic")).toEqual({ enabled: false, message: "shared" })
    expect(resolveContinuation("responses").message).toBe("shared") // shared, no anthropic override
  })

  test("resetConfigManagedState restores continuation defaults", async () => {
    await applyYaml(`buffered_retry:\n  continuation:\n    enabled: false\n    message: "x"\n`)
    expect(resolveContinuation("responses")).toEqual({ enabled: false, message: "x" })
    resetConfigManagedState()
    expect(resolveContinuation("responses")).toEqual({ enabled: true, message: "network issue. please continue" })
  })
})
