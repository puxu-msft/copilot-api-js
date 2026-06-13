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
      history: { limit: 100, reaper_interval: 600 },
      model_overrides: { foo: "bar" },
    }
    const result = validateConfig(input)
    expect(result.anthropic?.cache_control).toBe("proxied")
    expect(result.history?.limit).toBe(100)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("validateConfig — unknown keys", () => {
  test("unknown top-level key warns once + is stripped", () => {
    const r1 = validateConfig({ unknown_top_key: 42, history: { limit: 10 } })
    validateConfig({ unknown_top_key: 42 })
    expect((r1 as Record<string, unknown>).unknown_top_key).toBeUndefined()
    expect(r1.history?.limit).toBe(10) // valid neighbor survives
    const calls = warnedMessages().filter((m) => m.includes("unknown_top_key"))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("Unknown key")
  })

  test("unknown anthropic sub-key warns once + is stripped", () => {
    const result = validateConfig({ anthropic: { cache_contro: "proxied", api_key: "k" } })
    expect((result.anthropic as Record<string, unknown> | undefined)?.cache_contro).toBeUndefined()
    expect(result.anthropic?.api_key).toBe("k")
    const calls = warnedMessages().filter((m) => m.includes("cache_contro"))
    expect(calls.length).toBe(1)
  })

  test("free-form Record fields accept arbitrary user-defined keys", () => {
    const result = validateConfig({
      model_overrides: { "claude-3-opus": "claude-opus-4.7", "weird.dots": "x" },
      anthropic: { effort_overrides: { "claude-opus-4.7-1m-internal": ["medium", "high"] } },
    })
    expect(result.model_overrides?.["claude-3-opus"]).toBe("claude-opus-4.7")
    expect(result.anthropic?.effort_overrides?.["claude-opus-4.7-1m-internal"]).toEqual(["medium", "high"])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("validateConfig — type errors", () => {
  test("wrong type for known field warns and strips it", () => {
    const result = validateConfig({ history: { limit: "abc", reaper_interval: 600 } })
    expect(result.history?.limit).toBeUndefined()
    expect(result.history?.reaper_interval).toBe(600) // valid sibling survives
    expect(warnedMessages().some((m) => m.includes("history.limit"))).toBe(true)
  })

  test("invalid enum value warns + strips", () => {
    const result = validateConfig({ anthropic: { cache_control: "bogus" } })
    expect(result.anthropic?.cache_control).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("anthropic.cache_control"))).toBe(true)
  })

  test("negative number rejected", () => {
    const result = validateConfig({ history: { limit: -5 } })
    expect(result.history?.limit).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("history.limit"))).toBe(true)
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

  test("history.min_entries → warn only, no translation", () => {
    const result = validateConfig({ history: { min_entries: 20, limit: 100 } })
    expect((result.history as Record<string, unknown> | undefined)?.min_entries).toBeUndefined()
    expect(result.history?.limit).toBe(100)
    expect(warnedMessages().some((m) => m.includes("history.min_entries"))).toBe(true)
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
