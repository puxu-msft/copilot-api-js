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

  test("anthropic.thinking_block_sanitize_check → thinking_block_sanitize (key rename, new-style value)", () => {
    const result = validateConfig({ anthropic: { thinking_block_sanitize_check: "signature_empty" } })
    expect(result.anthropic?.thinking_block_sanitize).toBe("signature_empty")
  })

  describe("anthropic.thinking_block_sanitize value rename (name = which empty field triggers drop)", () => {
    test('legacy "empty_thinking" → "all_empty" (text AND signature empty)', () => {
      const result = validateConfig({ anthropic: { thinking_block_sanitize: "empty_thinking" } })
      expect(result.anthropic?.thinking_block_sanitize).toBe("all_empty")
    })

    test('legacy "empty_any" → "signature_empty" (signature empty, any text)', () => {
      const result = validateConfig({ anthropic: { thinking_block_sanitize: "empty_any" } })
      expect(result.anthropic?.thinking_block_sanitize).toBe("signature_empty")
    })

    test("old key + old value chain: thinking_block_sanitize_check=empty_thinking → thinking_block_sanitize=all_empty", () => {
      const result = validateConfig({ anthropic: { thinking_block_sanitize_check: "empty_thinking" } })
      expect(result.anthropic?.thinking_block_sanitize).toBe("all_empty")
    })

    test.each(["all_empty", "signature_empty", "thinking_empty", "any_empty", false] as const)("already-valid value %p passes through unchanged", (value) => {
      const result = validateConfig({ anthropic: { thinking_block_sanitize: value } })
      // `false` (disable the pass) is kept as-is; only `null` maps to undefined via the schema transform.
      expect(result.anthropic?.thinking_block_sanitize).toBe(value)
    })
  })

  test("anthropic.system_messages_sanitize → system_default_mode", () => {
    const result = validateConfig({ anthropic: { system_messages_sanitize: "as_user" } })
    expect(result.anthropic?.system_default_mode).toBe("as_user")
    expect((result.anthropic as Record<string, unknown> | undefined)?.system_messages_sanitize).toBeUndefined()
  })

  // anthropic.* concern-prefix normalization (RFC anthropic-rewrite-reorg §6, Phase 4).
  // Per-key round-trip: legacy flat key in → new concern-prefixed key out. Guards against
  // a forgotten renameLeaf silently dropping the user's value under the strict schema
  // (the hot-reload completeness guard proves the NEW key is wired, NOT that the OLD→NEW
  // migration exists — only this round-trip does).
  const CONCERN_PREFIX_RENAMES: ReadonlyArray<{ old: string; new: string; value: unknown }> = [
    { old: "coerce_adaptive_thinking", new: "thinking_coerce_adaptive", value: "best_effort" },
    // server-tool sub-concern regrouping — both the ancient legacy names AND the
    // interim tool_* names map directly to the final server_tool_* names.
    { old: "strip_server_tools", new: "server_tool_strip", value: true },
    { old: "tool_strip_server", new: "server_tool_strip", value: true },
    { old: "rewrite_history_server_tools", new: "server_tool_rewrite", value: "downgrade" },
    { old: "tool_rewrite_history_server", new: "server_tool_rewrite", value: "downgrade" },
    { old: "memory_tool", new: "server_tool_memory", value: true },
    { old: "inject_claude_code_tools", new: "tool_inject_claude_code", value: false },
    { old: "dedup_tool_calls", new: "tool_dedup_calls", value: "result" },
    { old: "strip_read_tool_result_tags", new: "tool_strip_read_result_tags", value: true },
    { old: "non_deferred_tools", new: "tool_search_non_deferred", value: ["Foo"] },
    { old: "tool_non_deferred", new: "tool_search_non_deferred", value: ["Bar"] },
    { old: "decode_tool_input_fields", new: "tool_decode_input_fields", value: { AskUserQuestion: ["questions"] } },
    { old: "decode_all_tool_input_fields", new: "tool_decode_all_input_fields", value: true },
    { old: "recover_tool_call_text", new: "tool_recover_call_text", value: true },
    { old: "backfill_question_from_header", new: "tool_backfill_question", value: false },
    { old: "rewrite_system_reminders", new: "system_rewrite_reminders", value: true },
    { old: "strip_beta_headers", new: "beta_strip_headers", value: { "claude-x": ["foo"] } },
    { old: "strip_request_headers", new: "request_header_blacklist", value: ["x-anthropic-billing-header"] },
    { old: "reject_body_fields", new: "retry_reject_body_fields", value: { "claude-x": ["foo"] } },
    { old: "fake_sse_heartbeat", new: "stream_keepalive_ping_sec", value: 30 },
    { old: "stream_fake_sse_heartbeat", new: "stream_keepalive_ping_sec", value: 30 },
  ]

  for (const { old: oldKey, new: newKey, value } of CONCERN_PREFIX_RENAMES) {
    test(`anthropic.${oldKey} → anthropic.${newKey}`, () => {
      const result = validateConfig({ anthropic: { [oldKey]: value } })
      const anthropic = result.anthropic as Record<string, unknown> | undefined
      expect(anthropic?.[newKey]).toEqual(value)
      expect(anthropic?.[oldKey]).toBeUndefined()
    })
  }

  test("web_search → server_tool_web_search (top-level section rename)", () => {
    const result = validateConfig({ web_search: { enabled: true, backend: "searxng" } })
    const cfg = result as Record<string, unknown>
    expect(cfg.server_tool_web_search).toEqual({ enabled: true, backend: "searxng" })
    expect(cfg.web_search).toBeUndefined()
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
