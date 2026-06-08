import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  decodeToolUseInput,
  shouldDecodeToolInput,
  tryDecodeJsonString,
  type DecodeToolInputConfig,
} from "~/lib/anthropic/decode-tool-input-core"

const cfg = (fields: Record<string, Array<string>>, all = false): DecodeToolInputConfig => ({ fields, all })

describe("tryDecodeJsonString", () => {
  test("decodes a JSON array string to an array", () => {
    expect(tryDecodeJsonString('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  test("decodes a JSON object string to an object", () => {
    expect(tryDecodeJsonString('{"a":1}')).toEqual({ a: 1 })
  })

  test("decodes double-serialized strings iteratively", () => {
    const doubled = JSON.stringify(JSON.stringify([{ a: 1 }]))
    expect(tryDecodeJsonString(doubled)).toEqual([{ a: 1 }])
  })

  test("returns undefined for a non-JSON plain string", () => {
    expect(tryDecodeJsonString("hello world")).toBeUndefined()
  })

  test("returns undefined when the value decodes to a scalar (number)", () => {
    expect(tryDecodeJsonString("123")).toBeUndefined()
  })

  test("returns undefined when the value decodes to a scalar (quoted string)", () => {
    // '"x"' parses to the string "x" — a scalar, not an object/array
    expect(tryDecodeJsonString('"x"')).toBeUndefined()
  })

  test("returns undefined for the empty string", () => {
    expect(tryDecodeJsonString("")).toBeUndefined()
  })
})

describe("shouldDecodeToolInput", () => {
  test("true when tool is listed with at least one field", () => {
    expect(shouldDecodeToolInput("AskUserQuestion", cfg({ AskUserQuestion: ["questions"] }))).toBe(true)
  })

  test("false when tool is absent from the map", () => {
    expect(shouldDecodeToolInput("OtherTool", cfg({ AskUserQuestion: ["questions"] }))).toBe(false)
  })

  test("false when tool maps to an empty field list", () => {
    expect(shouldDecodeToolInput("Empty", cfg({ Empty: [] }))).toBe(false)
  })

  test("true for any tool when all=true", () => {
    expect(shouldDecodeToolInput("Anything", cfg({}, true))).toBe(true)
  })
})

describe("decodeToolUseInput", () => {
  test("decodes a configured stringified field", () => {
    const input = { questions: '[{"header":"h"}]' }
    const out = decodeToolUseInput("AskUserQuestion", input, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).toEqual({ questions: [{ header: "h" }] })
  })

  test("leaves a tool not in the map untouched (returns same reference)", () => {
    const input = { questions: '[{"header":"h"}]' }
    const out = decodeToolUseInput("OtherTool", input, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).toBe(input)
  })

  test("all=true decodes every top-level stringified field", () => {
    const input = { a: '{"x":1}', b: "[1,2]", c: "plain" }
    const out = decodeToolUseInput("Any", input, cfg({}, true))
    expect(out).toEqual({ a: { x: 1 }, b: [1, 2], c: "plain" })
  })

  test("preserves non-JSON string fields verbatim", () => {
    const input = { questions: "not json at all" }
    const out = decodeToolUseInput("AskUserQuestion", input, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).toBe(input)
    expect(out).toEqual({ questions: "not json at all" })
  })

  test("preserves a field that decodes to a scalar", () => {
    const input = { count: "123" }
    const out = decodeToolUseInput("T", input, cfg({ T: ["count"] }))
    expect(out).toBe(input)
    expect(out).toEqual({ count: "123" })
  })

  test("leaves non-string fields alone", () => {
    const input = { questions: [{ header: "already" }], other: 5 }
    const out = decodeToolUseInput("AskUserQuestion", input, cfg({ AskUserQuestion: ["questions", "other"] }))
    expect(out).toBe(input)
  })

  test("returns the original reference when nothing changes", () => {
    const input = { questions: [{ header: "h" }] }
    const out = decodeToolUseInput("AskUserQuestion", input, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).toBe(input)
  })

  test("does not mutate the original input on change", () => {
    const input = { questions: '[{"h":1}]' }
    const out = decodeToolUseInput("AskUserQuestion", input, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).not.toBe(input)
    expect(input.questions).toBe('[{"h":1}]')
  })

  test("returns string input unchanged", () => {
    const out = decodeToolUseInput("T", "a string", cfg({ T: ["x"] }, true))
    expect(out).toBe("a string")
  })

  test("returns null input unchanged", () => {
    const out = decodeToolUseInput("T", null, cfg({}, true))
    expect(out).toBeNull()
  })

  test("returns array input unchanged", () => {
    const arr = [1, 2, 3]
    const out = decodeToolUseInput("T", arr, cfg({}, true))
    expect(out).toBe(arr)
  })

  test("decodes only the configured subset of fields", () => {
    const input = { a: "[1]", b: "[2]" }
    const out = decodeToolUseInput("T", input, cfg({ T: ["a"] })) as Record<string, unknown>
    expect(out.a).toEqual([1])
    expect(out.b).toBe("[2]")
  })
})
