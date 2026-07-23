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
} from "~/lib/config/config"
import { warnProtectStreamingHeartbeatOnce } from "~/lib/config/validation"

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

describe("validateConfig — happy paths", () => {
  test("empty config returns {}", () => {
    expect(validateConfig({})).toEqual({})
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("non-object input returns {}", () => {
    expect(validateConfig(null)).toEqual({})
    expect(validateConfig(undefined)).toEqual({})
    expect(validateConfig("foo")).toEqual({})
    expect(validateConfig([1, 2])).toEqual({})
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("fully-valid config passes through unchanged", () => {
    const input = {
      proxy: "http://p:8080",
      anthropic: {
        cache_control: "proxied",
        thinking_block_message_policy: "preserve",
        effort_overrides: { "claude-opus-4.7": ["medium"] },
      },
      history: { raw_capture: { enabled: false, max_object_bytes: 100 } },
      model_mappings: { foo: "bar" },
    }
    const result = validateConfig(input)
    expect(result.anthropic?.cache_control).toBe("proxied")
    expect(result.history?.raw_capture?.max_object_bytes).toBe(100)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("validateConfig — unknown keys", () => {
  test("unknown top-level key warns once + is stripped", () => {
    const r1 = validateConfig({ unknown_top_key: 42, history: { raw_capture: { max_object_bytes: 10 } } })
    validateConfig({ unknown_top_key: 42 })
    expect((r1 as Record<string, unknown>).unknown_top_key).toBeUndefined()
    expect(r1.history?.raw_capture?.max_object_bytes).toBe(10)
    const calls = warnedMessages().filter((m) => m.includes("unknown_top_key"))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("Unknown key")
  })

  test("unknown anthropic sub-key warns once + is stripped", () => {
    const result = validateConfig({ anthropic: { cache_contro: "proxied", warmup: "allow" } })
    expect((result.anthropic as Record<string, unknown> | undefined)?.cache_contro).toBeUndefined()
    expect(result.anthropic?.warmup).toBe("allow")
    const calls = warnedMessages().filter((m) => m.includes("cache_contro"))
    expect(calls.length).toBe(1)
  })

  test("free-form Record fields accept arbitrary user-defined keys", () => {
    const result = validateConfig({
      model_mappings: { "claude-3-opus": "claude-opus-4.7", "weird.dots": "x" },
      anthropic: { effort_overrides: { "claude-opus-4.7-1m-internal": ["medium", "high"] } },
    })
    expect(result.model_mappings?.["claude-3-opus"]).toBe("claude-opus-4.7")
    expect(result.anthropic?.effort_overrides?.["claude-opus-4.7-1m-internal"]).toEqual(["medium", "high"])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("validateConfig — type errors", () => {
  test("wrong type for known field warns and strips it", () => {
    const result = validateConfig({ history: { raw_capture: { max_object_bytes: "abc", enabled: false } } })
    expect(result.history?.raw_capture?.max_object_bytes).toBeUndefined()
    expect(result.history?.raw_capture?.enabled).toBe(false)
    expect(warnedMessages().some((m) => m.includes("max_object_bytes"))).toBe(true)
  })

  test("invalid enum value warns + strips", () => {
    const result = validateConfig({ anthropic: { cache_control: "bogus" } })
    expect(result.anthropic?.cache_control).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("anthropic.cache_control"))).toBe(true)
  })

  test("openai_responses.buffered_merge.event_compaction: invalid value is stripped + warned, config falls back to default", () => {
    const result = validateConfig({ openai_responses: { buffered_merge: { event_compaction: "not-a-real-mode" } } })
    expect(result.openai_responses?.buffered_merge?.event_compaction).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("buffered_merge"))).toBe(true)
  })

  test("response_tool_use_fix.malformed_input: comma-separated item set parsed (dedup + canonical order); invalid stripped", () => {
    const parse = (v: unknown) =>
      validateConfig({ anthropic: { response_tool_use_fix: { malformed_input: v } } }).anthropic?.response_tool_use_fix?.malformed_input
    expect(parse("tags")).toEqual(["tags"])
    expect(parse("tags,jsonrepair")).toEqual(["tags", "jsonrepair"])
    // spelling order ignored → canonical order; duplicates collapsed
    expect(parse("jsonrepair,tags,tags")).toEqual(["tags", "jsonrepair"])
    // hyphenated `unicode-lossy` token accepted and lands LAST in canonical order regardless of spelling
    expect(parse("unicode-lossy,jsonrepair,unicode")).toEqual(["unicode", "jsonrepair", "unicode-lossy"])
    // empty string == off (empty set)
    expect(parse("")).toEqual([])
    // clean break (project unreleased): the legacy "repair" tier and boolean `false` are no longer valid → stripped + warn
    expect(parse("repair")).toBeUndefined()
    expect(parse(false)).toBeUndefined()
    expect(parse("tags,bogus")).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("malformed_input"))).toBe(true)
  })

  test("negative number rejected", () => {
    const result = validateConfig({ history: { raw_capture: { max_object_bytes: -5 } } })
    expect(result.history?.raw_capture?.max_object_bytes).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("max_object_bytes"))).toBe(true)
  })

  test("upstream_transport.http2.favor: boolean accepted, non-boolean stripped + warned", () => {
    expect(validateConfig({ upstream_transport: { http2: { favor: false } } }).upstream_transport?.http2?.favor).toBe(false)
    expect(validateConfig({ upstream_transport: { http2: { favor: true } } }).upstream_transport?.http2?.favor).toBe(true)
    const bad = validateConfig({ upstream_transport: { http2: { favor: "no" } } })
    expect(bad.upstream_transport?.http2?.favor).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("favor"))).toBe(true)
  })
})

describe("validateConfig — deprecated keys", () => {
  test("anthropic.immutable_thinking_messages: true → translates to preserve + warns once", () => {
    const r1 = validateConfig({ anthropic: { immutable_thinking_messages: true } })
    const r2 = validateConfig({ anthropic: { immutable_thinking_messages: true } })
    expect(r1.anthropic?.thinking_block_message_policy).toBe("preserve")
    expect(r2.anthropic?.thinking_block_message_policy).toBe("preserve")
    const calls = warnedMessages().filter((m) => m.includes("immutable_thinking_messages"))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("thinking_block_message_policy")
  })

  test("anthropic.immutable_thinking_messages: false → translates to stripped", () => {
    const result = validateConfig({ anthropic: { immutable_thinking_messages: false } })
    expect(result.anthropic?.thinking_block_message_policy).toBe("stripped")
  })

  test("explicit valid policy takes precedence over deprecated bool", () => {
    const result = validateConfig({
      anthropic: {
        immutable_thinking_messages: true, // would translate to "preserve"
        thinking_block_message_policy: "stripped", // explicit valid value wins
      },
    })
    expect(result.anthropic?.thinking_block_message_policy).toBe("stripped")
    // Deprecation warning still fires for the bool
    expect(warnedMessages().some((m) => m.includes("immutable_thinking_messages"))).toBe(true)
  })

  test('thinking_block_message_policy "immutable" → consolidated to "preserve" + warns once', () => {
    const r1 = validateConfig({ anthropic: { thinking_block_message_policy: "immutable" } })
    const r2 = validateConfig({ anthropic: { thinking_block_message_policy: "immutable" } })
    expect(r1.anthropic?.thinking_block_message_policy).toBe("preserve")
    expect(r2.anthropic?.thinking_block_message_policy).toBe("preserve")
    const calls = warnedMessages().filter((m) => m.includes("thinking_block_message_policy"))
    expect(calls.length).toBe(1)
  })

  test('thinking_block_message_policy "fixed-index" → consolidated to "preserve"', () => {
    const result = validateConfig({ anthropic: { thinking_block_message_policy: "fixed-index" } })
    expect(result.anthropic?.thinking_block_message_policy).toBe("preserve")
  })

  test('thinking_block_message_policy "preserve" passes through with NO warn', () => {
    const result = validateConfig({ anthropic: { thinking_block_message_policy: "preserve" } })
    expect(result.anthropic?.thinking_block_message_policy).toBe("preserve")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('thinking_block_message_policy "stripped" passes through with NO warn', () => {
    const result = validateConfig({ anthropic: { thinking_block_message_policy: "stripped" } })
    expect(result.anthropic?.thinking_block_message_policy).toBe("stripped")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("anthropic.auto_cache_control: true → translates to proxied", () => {
    const result = validateConfig({ anthropic: { auto_cache_control: true } })
    expect(result.anthropic?.cache_control).toBe("proxied")
    expect(warnedMessages().some((m) => m.includes("auto_cache_control"))).toBe(true)
  })

  test("anthropic.auto_cache_control: false → translates to disabled", () => {
    const result = validateConfig({ anthropic: { auto_cache_control: false } })
    expect(result.anthropic?.cache_control).toBe("disabled")
  })

  test("anthropic.refusal_recover_text: true → translates to refusal_sse_rewrite end_turn", () => {
    const result = validateConfig({ anthropic: { refusal_recover_text: true } })
    expect(result.anthropic?.refusal_sse_rewrite).toBe("end_turn")
    expect(warnedMessages().some((m) => m.includes("refusal_recover_text"))).toBe(true)
  })

  test("anthropic.refusal_recover_text: false → translates to refusal_sse_rewrite refusal", () => {
    const result = validateConfig({ anthropic: { refusal_recover_text: false } })
    expect(result.anthropic?.refusal_sse_rewrite).toBe("refusal")
  })

  test("history.min_entries → warn only, no translation", () => {
    const result = validateConfig({ history: { min_entries: 20, raw_capture: { max_object_bytes: 100 } } })
    expect((result.history as Record<string, unknown> | undefined)?.min_entries).toBeUndefined()
    expect(result.history?.raw_capture?.max_object_bytes).toBe(100)
    expect(warnedMessages().some((m) => m.includes("history.min_entries"))).toBe(true)
  })

  test("anthropic.model_capabilities.tool_search (removed list) → warn + drop, siblings preserved", () => {
    const result = validateConfig({
      anthropic: { model_capabilities: { tool_search: ["claude-opus-4.9"], context_editing: ["claude-opus-4.6"] } },
    })
    const mc = result.anthropic?.model_capabilities as Record<string, unknown> | undefined
    expect(mc?.tool_search).toBeUndefined()
    // A sibling capability list under the same section survives the removal.
    expect(mc?.context_editing).toEqual(["claude-opus-4.6"])
    expect(warnedMessages().some((m) => m.includes("anthropic.model_capabilities.tool_search"))).toBe(true)
  })

  test("anthropic.api_key (retired) → warn + drop, siblings preserved", () => {
    const result = validateConfig({
      anthropic: { api_key: "sk-test-123", warmup: "allow" },
    })
    expect((result.anthropic as Record<string, unknown> | undefined)?.api_key).toBeUndefined()
    // A sibling anthropic key survives the removal.
    expect(result.anthropic?.warmup).toBe("allow")
    expect(warnedMessages().some((m) => m.includes("anthropic.api_key"))).toBe(true)
  })
})

describe("validateConfig — warn-once semantics", () => {
  test("each distinct key warns once regardless of invocation count", () => {
    validateConfig({ foo: 1, anthropic: { weird_key: 2 } })
    validateConfig({ foo: 1, anthropic: { weird_key: 2 } })
    validateConfig({ foo: 1, anthropic: { weird_key: 2 } })
    const fooCount = warnedMessages().filter((m) => m.includes("foo")).length
    const weirdCount = warnedMessages().filter((m) => m.includes("anthropic.weird_key")).length
    expect(fooCount).toBe(1)
    expect(weirdCount).toBe(1)
  })

  test("reset helper clears the dedup tracking", () => {
    validateConfig({ foo: 1 })
    _resetConfigValidationWarnTrackingForTests()
    validateConfig({ foo: 1 })
    expect(warnedMessages().filter((m) => m.includes("foo")).length).toBe(2)
  })
})

describe("validateConfig — SOCKS session_connect_timeout=0 rejection (D3 exception)", () => {
  test("SOCKS proxy + session_connect_timeout: 0 is stripped (falls back to default 10) + warns", () => {
    const result = validateConfig({
      proxy: "socks5://proxy.example:1080",
      upstream_transport: { http2: { session_connect_timeout: 0 } },
    })
    expect(result.upstream_transport?.http2?.session_connect_timeout).toBeUndefined() // stripped → schema default (10) applies downstream
    expect(warnedMessages().some((m) => m.includes("upstream_transport.http2.session_connect_timeout") && m.includes("SOCKS"))).toBe(true)
  })

  test("SOCKS proxy + session_connect_timeout: 5 (positive) passes through unchanged", () => {
    const result = validateConfig({
      proxy: "socks5://proxy.example:1080",
      upstream_transport: { http2: { session_connect_timeout: 5 } },
    })
    expect(result.upstream_transport?.http2?.session_connect_timeout).toBe(5)
    expect(warnedMessages().some((m) => m.includes("session_connect_timeout"))).toBe(false)
  })

  test("HTTP CONNECT proxy (non-SOCKS) + session_connect_timeout: 0 passes through unchanged (real disable)", () => {
    const result = validateConfig({
      proxy: "http://proxy.example:8080",
      upstream_transport: { http2: { session_connect_timeout: 0 } },
    })
    expect(result.upstream_transport?.http2?.session_connect_timeout).toBe(0)
  })

  test("no proxy configured + session_connect_timeout: 0 passes through unchanged (direct connection, real disable)", () => {
    const result = validateConfig({ upstream_transport: { http2: { session_connect_timeout: 0 } } })
    expect(result.upstream_transport?.http2?.session_connect_timeout).toBe(0)
  })
})

describe("warnProtectStreamingHeartbeatOnce — L2 buffered keepalive cross-field guard", () => {
  test("buffered ON + both heartbeats 0 → warns", () => {
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "on", fakeHeartbeat: 0, protectHeartbeat: 0 })
    expect(warnedMessages().some((m) => m.includes("protect_streaming_generation is enabled") && m.includes("no keepalive"))).toBe(true)
  })

  test("buffered OFF → never warns (even with both heartbeats 0)", () => {
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: false, fakeHeartbeat: 0, protectHeartbeat: 0 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("buffered ON but protect heartbeat > 0 → no warn", () => {
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "tool_use_only", fakeHeartbeat: 0, protectHeartbeat: 15 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("buffered ON but fake heartbeat > 0 → no warn", () => {
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "on", fakeHeartbeat: 120, protectHeartbeat: 0 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("warns ONCE across repeated applies (hot-reload), re-warns after reset", () => {
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "on", fakeHeartbeat: 0, protectHeartbeat: 0 })
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "on", fakeHeartbeat: 0, protectHeartbeat: 0 })
    expect(warnedMessages().filter((m) => m.includes("no keepalive")).length).toBe(1)
    _resetConfigValidationWarnTrackingForTests()
    warnProtectStreamingHeartbeatOnce({ protectStreamingGeneration: "on", fakeHeartbeat: 0, protectHeartbeat: 0 })
    expect(warnedMessages().filter((m) => m.includes("no keepalive")).length).toBe(2)
  })
})
