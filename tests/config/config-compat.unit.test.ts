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

import { extractAndTranslateDeprecatedWithOps } from "~/lib/config/compat"
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
  // model_overrides → model_mappings (top-level key rename, Phase 7 of the
  // anthropic↔responses direct-bridge RFC §6.2). Legacy key read-time aliased.
  test("model_overrides → model_mappings (top-level rename)", () => {
    const result = validateConfig({ model_overrides: { opus: "claude-opus-4.8" } })
    expect(result.model_mappings).toEqual({ opus: "claude-opus-4.8" })
    expect((result as Record<string, unknown>).model_overrides).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("model_overrides"))).toBe(true)
  })

  test("model_overrides → model_mappings: user-set new key wins over migrated legacy key", () => {
    const result = validateConfig({
      model_overrides: { opus: "legacy-target" },
      model_mappings: { opus: "new-target" },
    })
    expect(result.model_mappings).toEqual({ opus: "new-target" })
  })

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
    // client_websocket_keep_open → (renameSection) openai_responses.client_ws_keep_open →
    // (three-axis reorg renameLeaf, same migration pass) server.responses_ws.keep_open —
    // migrations chain within a single extractAndTranslateDeprecated() pass because
    // CONFIG_MIGRATIONS is evaluated top-down and this renameLeaf sits after renameSection.
    expect(result.server?.responses_ws?.keep_open).toBe(true)
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

  test("auto_truncate.max_retries → retry.max_reactive_retries", () => {
    const result = validateConfig({ auto_truncate: { max_retries: 8 } })
    expect(result.retry?.max_reactive_retries).toBe(8)
    expect((result as Record<string, unknown>).auto_truncate).toBeUndefined()
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
    { old: "memory_tool", new: "server_tool_memory", value: true },
    { old: "inject_claude_code_tools", new: "tool_inject_claude_code", value: false },
    { old: "dedup_tool_calls", new: "tool_dedup_calls", value: "result" },
    { old: "strip_read_tool_result_tags", new: "tool_strip_read_result_tags", value: true },
    { old: "non_deferred_tools", new: "tool_search_non_deferred", value: ["Foo"] },
    { old: "tool_non_deferred", new: "tool_search_non_deferred", value: ["Bar"] },
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

  // Response-wire fixes regrouped under `response_text_fix` / `response_tool_use_fix` (nested
  // sections). Migrations do NOT chain, so BOTH the ancestral spelling and the intermediate flat
  // `tool_*` spelling map DIRECTLY to the final nested leaf. `decode_all` is removed outright.
  const RESPONSE_FIX_RENAMES: ReadonlyArray<{ old: string; section: "response_text_fix" | "response_tool_use_fix"; leaf: string; value: unknown }> = [
    { old: "decode_tool_input_fields", section: "response_tool_use_fix", leaf: "decode_top_level_field", value: { AskUserQuestion: ["questions"] } },
    { old: "tool_decode_input_fields", section: "response_tool_use_fix", leaf: "decode_top_level_field", value: { SendMessage: ["x"] } },
    { old: "recover_tool_call_text", section: "response_text_fix", leaf: "invoke_in_text", value: true },
    { old: "tool_recover_call_text", section: "response_text_fix", leaf: "invoke_in_text", value: false },
    { old: "backfill_question_from_header", section: "response_tool_use_fix", leaf: "ask_user_question_question_missing", value: false },
    { old: "tool_backfill_question", section: "response_tool_use_fix", leaf: "ask_user_question_question_missing", value: true },
    { old: "tool_repair_malformed_input", section: "response_tool_use_fix", leaf: "malformed_input", value: "tags" },
  ]

  for (const { old: oldKey, section, leaf, value } of RESPONSE_FIX_RENAMES) {
    test(`anthropic.${oldKey} → anthropic.${section}.${leaf}`, () => {
      const result = validateConfig({ anthropic: { [oldKey]: value } })
      const anthropic = result.anthropic as Record<string, unknown> | undefined
      const sectionObj = anthropic?.[section] as Record<string, unknown> | undefined
      // malformed_input is transformed (comma-string → item array); others land verbatim.
      const expected = oldKey === "tool_repair_malformed_input" ? ["tags"] : value
      expect(sectionObj?.[leaf]).toEqual(expected)
      expect(anthropic?.[oldKey]).toBeUndefined()
    })
  }

  test("decode-ALL-tool-input-fields (both spellings) is dropped, not migrated", () => {
    for (const key of ["decode_all_tool_input_fields", "tool_decode_all_input_fields"]) {
      const result = validateConfig({ anthropic: { [key]: true } })
      const anthropic = result.anthropic as Record<string, unknown> | undefined
      expect(anthropic?.[key]).toBeUndefined()
      // Not smuggled into either nested section either.
      const toolUseFix = anthropic?.response_tool_use_fix as Record<string, unknown> | undefined
      expect(toolUseFix).toBeUndefined()
    }
    // A removal deprecation warned (message names the removed feature).
    expect(warnedMessages().some((m) => m.includes("decode-ALL-tool-input-fields"))).toBe(true)
  })

  // The web_search double-hop + server_tool_strip/rewrite config keys were RETIRED
  // (2026-07-13) → dropped with a warn-and-continue deprecation, NOT migrated.
  test("retired server-tool keys are dropped (warn-and-continue), not migrated", () => {
    const result = validateConfig({
      anthropic: { server_tool_strip: true, server_tool_rewrite: "downgrade", strip_server_tools: true },
      web_search: { enabled: true, backend: "searxng" },
      server_tool_web_search: { enabled: true, backend: "gpt-5.5" },
    })
    const cfg = result as Record<string, unknown>
    const anthropic = cfg.anthropic as Record<string, unknown> | undefined
    // Dropped from the loaded config (deprecated → warned + stripped).
    expect(anthropic?.server_tool_strip).toBeUndefined()
    expect(anthropic?.server_tool_rewrite).toBeUndefined()
    expect(anthropic?.strip_server_tools).toBeUndefined()
    expect(cfg.web_search).toBeUndefined()
    expect(cfg.server_tool_web_search).toBeUndefined()
    // memory_tool (client-tool passthrough) is UNAFFECTED — still migrated.
    const memResult = validateConfig({ anthropic: { memory_tool: true } })
    expect((memResult.anthropic as Record<string, unknown>)?.server_tool_memory).toBe(true)
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

  test("timeouts.upstream_keepalive → upstream_transport.tcp_keepalive_probe_delay", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 20 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBe(20)
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_keepalive).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("upstream_keepalive"))).toBe(true)
  })

  test("timeouts.upstream_keepalive: 0 migrates to absence (not tcp_keepalive_probe_delay: 0) so the new default (15) applies", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 0 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBeUndefined()
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_keepalive).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("upstream_keepalive"))).toBe(true)
  })

  test("timeouts.upstream_h2_ping → upstream_transport.http2.ping_interval", () => {
    const result = validateConfig({ timeouts: { upstream_h2_ping: 30 } })
    expect(result.upstream_transport?.http2?.ping_interval).toBe(30)
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_h2_ping).toBeUndefined()
  })

  test("openai_responses.client_ws_keep_open → server.responses_ws.keep_open", () => {
    const result = validateConfig({ openai_responses: { client_ws_keep_open: true } })
    expect(result.server?.responses_ws?.keep_open).toBe(true)
    expect((result.openai_responses as Record<string, unknown> | undefined)?.client_ws_keep_open).toBeUndefined()
  })

  test("openai_responses.max_ws_frame_bytes → server.responses_ws.max_frame_bytes", () => {
    const result = validateConfig({ openai_responses: { max_ws_frame_bytes: 65536 } })
    expect(result.server?.responses_ws?.max_frame_bytes).toBe(65536)
  })

  test("openai_responses.max_client_ws_connections → server.responses_ws.max_connections", () => {
    const result = validateConfig({ openai_responses: { max_client_ws_connections: 128 } })
    expect(result.server?.responses_ws?.max_connections).toBe(128)
  })

  test("openai_responses.max_upstream_ws_connections → upstream_transport.websocket.soft_max_connections", () => {
    const result = validateConfig({ openai_responses: { max_upstream_ws_connections: 64 } })
    expect(result.upstream_transport?.websocket?.soft_max_connections).toBe(64)
    expect((result.openai_responses as Record<string, unknown> | undefined)?.max_upstream_ws_connections).toBeUndefined()
  })

  test("multiple upstream_transport.http2 legacy leaves accumulate into one sub-section", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 12, upstream_h2_ping: 8 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBe(12)
    expect(result.upstream_transport?.http2?.ping_interval).toBe(8)
  })
})

describe("config compat — validateConfigInput (PUT) also migrates (C3)", () => {
  test("PUT with legacy model_overrides migrates to model_mappings", () => {
    const r = validateConfigInput({ model_overrides: { sonnet: "claude-sonnet-5" } })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.value.model_mappings).toEqual({ sonnet: "claude-sonnet-5" })
  })

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

  test("PUT legacyPathsRemoved reports the migrated legacy path", () => {
    const r = validateConfigInput({ fetch_timeout: 30 })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.legacyPathsRemoved).toContain("fetch_timeout")
  })

  test("PUT legacyPathsRemoved is empty when no legacy keys are present", () => {
    const r = validateConfigInput({ model_refresh_interval: 300 })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.legacyPathsRemoved).toEqual([])
  })

  test("PUT legacyPathsRemoved excludes in-place value migrations (anthropic.thinking_block_sanitize)", () => {
    const r = validateConfigInput({ anthropic: { thinking_block_sanitize: "empty_thinking" } })
    expect(r.valid).toBe(true)
    if (r.valid) {
      expect(r.value.anthropic?.thinking_block_sanitize).toBe("all_empty")
      expect(r.legacyPathsRemoved).not.toContain("anthropic.thinking_block_sanitize")
    }
  })
})

describe("validateConfigInput (PUT) — SOCKS session_connect_timeout=0 hard-rejects (D3 exception)", () => {
  test("rejects with structured detail naming the SOCKS caveat", () => {
    const r = validateConfigInput({
      proxy: "socks5://proxy.example:1080",
      upstream_transport: { http2: { session_connect_timeout: 0 } },
    })
    expect(r.valid).toBe(false)
    if (r.valid) return
    const detail = r.details.find((d) => d.field === "upstream_transport.http2.session_connect_timeout")
    expect(detail).toBeDefined()
    expect(detail?.message).toContain("SOCKS")
    expect(detail?.value).toBe(0)
  })

  test("accepts a positive session_connect_timeout with the same SOCKS proxy", () => {
    const r = validateConfigInput({
      proxy: "socks5://proxy.example:1080",
      upstream_transport: { http2: { session_connect_timeout: 5 } },
    })
    expect(r.valid).toBe(true)
  })
})

describe("config compat — extractAndTranslateDeprecatedWithOps (legacyPathsRemoved tracking)", () => {
  test("renameLeaf migration reports the legacy dot-path in legacyPathsRemoved", () => {
    const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ fetch_timeout: 200 })
    expect((value.timeouts as Record<string, unknown> | undefined)?.response_header).toBe(200)
    expect(legacyPathsRemoved).toContain("fetch_timeout")
  })

  test("removeKey migration (pure removal, no replacement) reports the legacy path too", () => {
    const { legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ history: { min_entries: 5 } })
    expect(legacyPathsRemoved).toContain("history.min_entries")
  })

  test("renameSection migration reports the legacy section path", () => {
    const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ "openai-responses": { upstream_websocket: true } })
    expect((value.openai_responses as Record<string, unknown> | undefined)?.upstream_ws).toBe(true)
    expect(legacyPathsRemoved).toContain("openai-responses")
  })

  test("migrateValue (in-place value consolidation, SAME key) does NOT report a legacy path", () => {
    const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ anthropic: { thinking_block_sanitize: "empty_thinking" } })
    expect((value.anthropic as Record<string, unknown> | undefined)?.thinking_block_sanitize).toBe("all_empty")
    // The key never relocates — deleting it from the on-disk YAML would only
    // drop the user's comment/position for no reason (see plan-3 §Architecture).
    expect(legacyPathsRemoved).not.toContain("anthropic.thinking_block_sanitize")
  })

  test("already-valid migrateValue-gated value passes through with no legacyPathsRemoved entry", () => {
    const { legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ anthropic: { thinking_block_sanitize: "all_empty" } })
    expect(legacyPathsRemoved).toEqual([])
  })

  test("legacy value of 0 on a transform-gated renameLeaf (0→absence) still reports the legacy path, even though no new value is written", () => {
    const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps({ timeouts: { upstream_keepalive: 0 } })
    expect((value.upstream_transport as Record<string, unknown> | undefined)?.tcp_keepalive_probe_delay).toBeUndefined()
    expect(legacyPathsRemoved).toContain("timeouts.upstream_keepalive")
  })

  test("no legacy keys present → empty legacyPathsRemoved, value unchanged (deep-cloned)", () => {
    const input = { proxy: "http://x" }
    const { value, legacyPathsRemoved } = extractAndTranslateDeprecatedWithOps(input)
    expect(legacyPathsRemoved).toEqual([])
    expect(value).toEqual(input)
    expect(value).not.toBe(input)
  })
})
