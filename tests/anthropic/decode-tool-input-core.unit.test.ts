import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  ASK_USER_QUESTION_TOOL,
  backfillAskUserQuestionHeaders,
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

describe("backfillAskUserQuestionHeaders", () => {
  test("ASK_USER_QUESTION_TOOL is the AskUserQuestion tool name", () => {
    expect(ASK_USER_QUESTION_TOOL).toBe("AskUserQuestion")
  })

  test("backfills question from header when question is absent", () => {
    const input = { questions: [{ header: "Pick a color", options: [{ label: "Red" }] }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input) as { questions: Array<Record<string, unknown>> }
    expect(out.questions[0].question).toBe("Pick a color")
    expect(out.questions[0].header).toBe("Pick a color")
    expect(out.questions[0].options).toEqual([{ label: "Red" }])
  })

  test("backfills each missing item independently, leaving present ones intact", () => {
    const input = {
      questions: [{ header: "A" }, { header: "B", question: "Keep me" }, { header: "C" }],
    }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input) as { questions: Array<Record<string, unknown>> }
    expect(out.questions[0].question).toBe("A")
    expect(out.questions[1].question).toBe("Keep me")
    expect(out.questions[2].question).toBe("C")
  })

  test("leaves a present-but-empty question untouched (only absence triggers)", () => {
    const input = { questions: [{ header: "H", question: "" }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input)
    expect(out).toBe(input)
  })

  test("skips an item whose header is missing", () => {
    const input = { questions: [{ options: [] }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input)
    expect(out).toBe(input)
  })

  test("skips an item whose header is an empty string", () => {
    const input = { questions: [{ header: "" }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input)
    expect(out).toBe(input)
  })

  test("skips an item whose header is non-string", () => {
    const input = { questions: [{ header: 42 }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input)
    expect(out).toBe(input)
  })

  test("no-op for a non-AskUserQuestion tool (returns same reference)", () => {
    const input = { questions: [{ header: "H" }] }
    const out = backfillAskUserQuestionHeaders("OtherTool", input)
    expect(out).toBe(input)
  })

  test("returns same reference when questions is not an array", () => {
    const input = { questions: "not an array" }
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", input)).toBe(input)
  })

  test("returns same reference when input has no questions field", () => {
    const input = { other: 1 }
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", input)).toBe(input)
  })

  test("skips non-object items inside questions", () => {
    const input = { questions: ["string", 5, null, { header: "ok" }] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input) as { questions: Array<unknown> }
    expect(out.questions[0]).toBe("string")
    expect(out.questions[3]).toEqual({ header: "ok", question: "ok" })
  })

  test("returns string / null / array input unchanged", () => {
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", "s")).toBe("s")
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", null)).toBeNull()
    const arr = [1, 2]
    expect(backfillAskUserQuestionHeaders("AskUserQuestion", arr)).toBe(arr)
  })

  test("does not mutate the original input or its items on change", () => {
    const item = { header: "H" }
    const input = { questions: [item] }
    const out = backfillAskUserQuestionHeaders("AskUserQuestion", input)
    expect(out).not.toBe(input)
    expect(item).toEqual({ header: "H" }) // original item untouched
    expect(Object.hasOwn(item, "question")).toBe(false)
  })
})
