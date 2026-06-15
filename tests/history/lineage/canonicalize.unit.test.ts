import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  canonicalJson,
  canonicalizeMessages,
  sha256Hex,
} from "~/lib/history/lineage/canonicalize"

describe("sha256Hex", () => {
  test("produces lowercase hex of length 64", () => {
    const h = sha256Hex("hello")
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })

  test("is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"))
  })
})

describe("canonicalJson", () => {
  test("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
  })

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
  })

  test("nests sort recursively", () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}],"z":{"a":1,"b":2}}')
  })

  test("omits undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })

  test("encodes null and primitives", () => {
    expect(canonicalJson(null)).toBe("null")
    expect(canonicalJson(undefined)).toBe("null")
    expect(canonicalJson(true)).toBe("true")
    expect(canonicalJson(42)).toBe("42")
    expect(canonicalJson("hi")).toBe('"hi"')
  })

  test("escapes strings via JSON.stringify", () => {
    expect(canonicalJson("a\nb")).toBe(String.raw`"a\nb"`)
    expect(canonicalJson({ 'key with "quotes"': "value" })).toBe(String.raw`{"key with \"quotes\"":"value"}`)
  })

  test("is byte-deterministic across calls", () => {
    const obj = { z: 1, a: { c: 3, b: 2 } }
    const first = canonicalJson(obj)
    for (let i = 0; i < 100; i++) {
      expect(canonicalJson(obj)).toBe(first)
    }
  })
})

describe("canonicalizeMessages — cache_control stripping", () => {
  test("strips top-level message-content cache_control", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ] as any)
    expect((result[0].content as Array<{ cache_control?: unknown }>)[0]).not.toHaveProperty("cache_control")
  })

  test("strips cache_control deep inside tool_result content arrays", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_X",
            content: [{ type: "text", text: "out", cache_control: { type: "ephemeral" } }],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ] as any)
    const block = (result[0].content as unknown as Array<Record<string, unknown>>)[0]
    expect(block).not.toHaveProperty("cache_control")
    const inner = (block.content as Array<Record<string, unknown>>)[0]
    expect(inner).not.toHaveProperty("cache_control")
  })

  test("does not mutate the input", () => {
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ] as any
    canonicalizeMessages(input)
    expect(input[0].content[0]).toHaveProperty("cache_control")
  })
})

describe("canonicalizeMessages — system-reminder stripping", () => {
  test("drops whole-block <system-reminder> text blocks", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\n2026-06-15 reminder\n</system-reminder>" },
          { type: "text", text: "real user prompt" },
        ],
      },
    ] as any)
    expect(result[0].content).toEqual([{ type: "text", text: "real user prompt" }])
  })

  test("tolerates trailing whitespace after </system-reminder>", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nfoo\n</system-reminder>\n\n  \n" },
          { type: "text", text: "stable" },
        ],
      },
    ] as any)
    expect(result[0].content).toHaveLength(1)
  })

  test("does NOT drop a block that mixes reminder open with stable user text after close", () => {
    // Adversarial: reminder + extra user text in same block. RFC §3.3 says
    // we require startsWith AND endsWith </system-reminder> precisely so a
    // block like this is NOT collapsed (which would cause false-merge).
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>foo</system-reminder>\n\nreal user text" }],
      },
    ] as any)
    expect(result[0].content).toHaveLength(1)
  })

  test("does NOT drop reminders embedded INSIDE tool_result content (RFC §2.4 — empirically stable, defer to v1.1)", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_X",
            content: "Exit code 1\n<system-reminder>\nstale reminder\n</system-reminder>",
          },
        ],
      },
    ] as any)
    // tool_result block remains; the embedded reminder is preserved.
    expect((result[0].content as unknown as Array<Record<string, unknown>>)[0].type).toBe("tool_result")
  })
})

describe("canonicalizeMessages — empty text block filtering", () => {
  test("drops whitespace-only text blocks (mirrors recording.ts filter)", () => {
    const result = canonicalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   \n  " },
          { type: "text", text: "real output" },
          { type: "tool_use", id: "toolu_X", name: "X", input: {} },
        ],
      },
    ] as any)
    expect(result[0].content).toHaveLength(2)
    expect((result[0].content as Array<{ type: string }>)[0].type).toBe("text")
    expect((result[0].content as Array<{ type: string }>)[1].type).toBe("tool_use")
  })

  test("preserves text blocks whose `text` field is the empty string ONLY when the message also has other blocks (filter is per-block)", () => {
    // Two adjacent assistant turns, one with only an empty text block + a tool_use
    // (legitimate: a tool-only response), one with whitespace text. Both should
    // collapse to just the tool_use.
    const result = canonicalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: " " },
          { type: "tool_use", id: "toolu_A", name: "Read", input: { path: "/x" } },
        ],
      },
    ] as any)
    expect(result[0].content).toHaveLength(1)
  })
})

describe("canonicalizeMessages — image data digest substitution", () => {
  test("substitutes source.data with sha256 digest under _dataDigest", () => {
    const result = canonicalizeMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ] as any)
    const block = (result[0].content as unknown as Array<{ source: Record<string, unknown> }>)[0]
    expect(block.source).not.toHaveProperty("data")
    expect(block.source._dataDigest).toBe(sha256Hex("AAAA"))
    expect(block.source.media_type).toBe("image/png")
  })

  test("identical base64 → identical digest (stable across calls)", () => {
    const mkMsg = () => [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "X".repeat(1000) } }] }] as any
    const a = canonicalizeMessages(mkMsg())
    const b = canonicalizeMessages(mkMsg())
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })
})

describe("canonicalizeMessages — idempotency", () => {
  test("canonicalize(canonicalize(x)) === canonicalize(x) (byte-stable)", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nfoo\n</system-reminder>" },
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "ABC" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: " " },
          { type: "tool_use", id: "toolu_1", name: "X", input: { a: 1, b: 2 } },
        ],
      },
    ] as any

    const once = canonicalizeMessages(input)
    const twice = canonicalizeMessages(once)
    expect(canonicalJson(once)).toBe(canonicalJson(twice))
  })
})

describe("canonicalizeMessages — string content (Anthropic plain-string form)", () => {
  test("passes through string content unchanged", () => {
    const result = canonicalizeMessages([{ role: "user", content: "plain text message" }] as any)
    expect(result[0]).toEqual({ role: "user", content: "plain text message" })
  })
})
