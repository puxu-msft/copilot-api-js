/**
 * Tests for the backward-compatibility redirect layer (src/lib/config/compat.ts)
 * exercised end-to-end through validateConfig (file load) and validateConfigInput
 * (HTTP PUT). Verifies that every legacy key migrates to its current name/shape,
 * the legacy key is stripped, and a deprecation warning fires once.
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

import {
  //
  _resetConfigValidationWarnTrackingForTests,
  validateConfig,
  validateConfigInput,
} from "~/lib/config/config"

let warnSpy: ReturnType<typeof spyOn<typeof consola, "warn">>

beforeEach(() => {
  _resetConfigValidationWarnTrackingForTests()
  warnSpy = spyOn(consola, "warn").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.warn)
})

afterEach(() => {
  warnSpy.mockRestore()
})

function warnedMessages(): Array<string> {
  return warnSpy.mock.calls.map((call: Array<unknown>) => String(call[0]))
}

describe("config compat — legacy key migration (file load)", () => {
  test("rate_limiter.recovery_timeout (minutes) → recovery_interval (seconds, ×60)", () => {
    const result = validateConfig({ rate_limiter: { recovery_timeout: 10 } })
    // 10 minutes → 600 seconds (the unit unification)
    expect(result.rate_limiter?.recovery_interval).toBe(600)
    expect((result.rate_limiter as Record<string, unknown> | undefined)?.recovery_timeout).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("recovery_timeout"))).toBe(true)
  })

  test("openai-responses section → openai_responses with inner ws field renames", () => {
    const result = validateConfig({
      "openai-responses": {
        upstream_websocket: true,
        client_websocket_keep_open: true,
        normalize_call_ids: false,
      },
    })
    expect(result.openai_responses?.upstream_ws).toBe(true)
    expect(result.openai_responses?.client_ws_keep_open).toBe(true)
    // un-renamed inner field preserved verbatim
    expect(result.openai_responses?.normalize_call_ids).toBe(false)
    expect((result as Record<string, unknown>)["openai-responses"]).toBeUndefined()
  })

  test("top-level timeout keys all merge into the timeouts section", () => {
    const result = validateConfig({
      stream_idle_timeout: 100,
      fetch_timeout: 200,
      stale_request_max_age: 300,
    })
    expect(result.timeouts).toEqual({
      stream_idle: 100,
      response_header: 200,
      stale_request_max_age: 300,
    })
    expect((result as Record<string, unknown>).fetch_timeout).toBeUndefined()
    expect((result as Record<string, unknown>).stream_idle_timeout).toBeUndefined()
  })

  test("compress_tool_results_before_truncate → auto_truncate.compress_tool_results", () => {
    const result = validateConfig({ compress_tool_results_before_truncate: false })
    expect(result.auto_truncate?.compress_tool_results).toBe(false)
    expect((result as Record<string, unknown>).compress_tool_results_before_truncate).toBeUndefined()
  })

  test("compress migrates in while a sibling auto_truncate field is preserved", () => {
    const result = validateConfig({
      compress_tool_results_before_truncate: true,
      auto_truncate: { enabled: true },
    })
    expect(result.auto_truncate?.compress_tool_results).toBe(true)
    expect(result.auto_truncate?.enabled).toBe(true)
  })

  test("anthropic.efforts_overrides → effort_overrides", () => {
    const result = validateConfig({ anthropic: { efforts_overrides: { "claude-x": ["high"] } } })
    expect(result.anthropic?.effort_overrides).toEqual({ "claude-x": ["high"] })
  })

  test("anthropic.thinking_block_sanitize_check → thinking_block_sanitize", () => {
    const result = validateConfig({ anthropic: { thinking_block_sanitize_check: "empty_any" } })
    expect(result.anthropic?.thinking_block_sanitize).toBe("empty_any")
  })

  test("user-set NEW key wins over migrated legacy key (missing-only merge)", () => {
    const result = validateConfig({ fetch_timeout: 200, timeouts: { response_header: 999 } })
    expect(result.timeouts?.response_header).toBe(999)
  })

  test("each migrated key warns exactly once", () => {
    validateConfig({ fetch_timeout: 100 })
    const calls = warnedMessages().filter((m) => m.includes("fetch_timeout"))
    expect(calls.length).toBe(1)
  })

  test("recovery_timeout: null is preserved (delete semantic), not multiplied", () => {
    const result = validateConfig({ rate_limiter: { recovery_timeout: null } })
    // null → undefined via schema transform; no NaN from null*60
    expect(result.rate_limiter?.recovery_interval).toBeUndefined()
  })
})

describe("config compat — historical migrations still work", () => {
  test("immutable_thinking_messages → thinking_block_message_policy", () => {
    expect(validateConfig({ anthropic: { immutable_thinking_messages: true } }).anthropic?.thinking_block_message_policy).toBe("preserve")
    expect(validateConfig({ anthropic: { immutable_thinking_messages: false } }).anthropic?.thinking_block_message_policy).toBe("stripped")
  })

  test("auto_cache_control → cache_control", () => {
    expect(validateConfig({ anthropic: { auto_cache_control: true } }).anthropic?.cache_control).toBe("proxied")
    expect(validateConfig({ anthropic: { auto_cache_control: false } }).anthropic?.cache_control).toBe("disabled")
  })

  test("history.min_entries removed (warn-only, valid neighbor survives)", () => {
    const result = validateConfig({ history: { min_entries: 5, limit: 10 } })
    expect((result.history as Record<string, unknown> | undefined)?.min_entries).toBeUndefined()
    expect(result.history?.limit).toBe(10)
  })
})

describe("config compat — validateConfigInput (PUT) also migrates (C3)", () => {
  test("PUT with legacy fetch_timeout is accepted (not 400) and migrated to timeouts.response_header", () => {
    const r = validateConfigInput({ fetch_timeout: 30 })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.value.timeouts?.response_header).toBe(30)
  })

  test("PUT with legacy openai-responses section migrates to openai_responses + upstream_ws", () => {
    const r = validateConfigInput({ "openai-responses": { upstream_websocket: true } })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.value.openai_responses?.upstream_ws).toBe(true)
  })

  test("PUT recovery_timeout migrates ×60 to recovery_interval", () => {
    const r = validateConfigInput({ rate_limiter: { recovery_timeout: 5 } })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.value.rate_limiter?.recovery_interval).toBe(300)
  })

  test("PUT still hard-fails on a genuinely invalid value after migration", () => {
    const r = validateConfigInput({ fetch_timeout: -1 })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.details[0].field).toBe("timeouts.response_header")
  })
})
