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
  normalizeAskUserQuestionInput,
  normalizeSendMessageInput,
  SEND_MESSAGE_TOOL,
  shouldDecodeToolInput,
  tryDecodeJsonString,
  unescapeJsonUnicode,
  type DecodeToolInputConfig,
} from "~/lib/anthropic/decode-tool-input-core"

const cfg = (fields: Record<string, Array<string>>): DecodeToolInputConfig => ({ fields })

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
    const out = decodeToolUseInput("T", "a string", cfg({ T: ["x"] }))
    expect(out).toBe("a string")
  })

  test("returns null input unchanged", () => {
    const out = decodeToolUseInput("T", null, cfg({}))
    expect(out).toBeNull()
  })

  test("returns array input unchanged", () => {
    const arr = [1, 2, 3]
    const out = decodeToolUseInput("T", arr, cfg({}))
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

describe("unescapeJsonUnicode", () => {
  test(String.raw`decodes literal \uXXXX escapes to characters`, () => {
    expect(unescapeJsonUnicode(String.raw`\u8fd9\u6b21`)).toBe("这次")
  })
  test(String.raw`leaves clean text with no \u escapes unchanged`, () => {
    expect(unescapeJsonUnicode("这次重构的范围")).toBe("这次重构的范围")
  })
  test(String.raw`leaves a real backslash (not \u) untouched`, () => {
    expect(unescapeJsonUnicode(String.raw`a\path\to`)).toBe(String.raw`a\path\to`)
  })
  test(String.raw`decodes surrogate-pair \uXXXX\uXXXX`, () => {
    expect(unescapeJsonUnicode(String.raw`\ud83d\ude00`)).toBe("😀")
  })
  test(String.raw`only touches \uXXXX, leaves surrounding literals verbatim`, () => {
    expect(unescapeJsonUnicode(String.raw`x=\u4e2d?`)).toBe("x=中?")
  })
})

describe("normalizeAskUserQuestionInput", () => {
  const AUQ = "AskUserQuestion"

  test("salvages a clean top-level question into the single item; strips top-level key", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "这次范围？" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect(out.questions[0].question).toBe("这次范围？")
    expect("question" in out).toBe(false)
    expect(diag).toEqual({ salvaged: true, strippedKeys: ["question"] })
  })

  test("salvages + un-escapes a double-escaped top-level question", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: String.raw`\u8fd9\u6b21` }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect(out.questions[0].question).toBe("这次")
    expect(diag.salvaged).toBe(true)
    expect(diag.unescaped).toBe(true)
  })

  test("multi-item + top-level question: WARN-only, no hoist, still strips, fallback fills from header", () => {
    const input = {
      questions: [
        { header: "H1", multiSelect: false, options: [] },
        { header: "H2", multiSelect: false, options: [] },
      ],
      question: "ambiguous?",
    }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(out.questions[0].question).toBe("H1")
    expect(out.questions[1].question).toBe("H2")
    expect(diag.multiItemAmbiguous).toBe(true)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.strippedKeys).toContain("question")
    expect(diag.droppedQuestionValue).toBe("ambiguous?")
  })

  test("strips redundant hoisted header/multiSelect (item already has them)", () => {
    const input = {
      questions: [{ header: "推进方式", multiSelect: false, options: [] }],
      question: "怎么推进？",
      header: "推进方式",
      multiSelect: false,
    }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(Object.keys(out).sort()).toEqual(["questions"])
    expect(out.questions[0].question).toBe("怎么推进？")
  })

  test("zero-perturbation: clean valid input returns same reference", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [], question: "范围？" }] }
    expect(normalizeAskUserQuestionInput(AUQ, input)).toBe(input)
  })

  test("empty-string top-level question yields to header fallback", () => {
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "" }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(out.questions[0].question).toBe("范围")
    expect("question" in out).toBe(false)
  })

  test("trace rule: non-empty top-level question stripped without salvage records dropped value", () => {
    const input = { questions: "[{...}]", question: "real question text" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.droppedQuestionValue).toBe("real question text")
    expect(diag.salvaged).toBeUndefined()
  })

  test("non-AskUserQuestion tool is a no-op (same reference)", () => {
    const input = { question: "x", foo: 1 }
    expect(normalizeAskUserQuestionInput("Bash", input)).toBe(input)
  })

  test("degenerate: 0-item questions + top-level question traces dropped value, no salvage", () => {
    const input = { questions: [], question: "real q" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.droppedQuestionValue).toBe("real q")
  })

  test("degenerate: item non-object skips salvage, strips + traces", () => {
    const input = { questions: [42], question: "real q" }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.salvaged).toBeUndefined()
    expect(diag.droppedQuestionValue).toBe("real q")
  })

  test("non-string top-level question stripped but NOT traced", () => {
    const input = { questions: [{ header: "h", multiSelect: false, options: [], question: "q" }], question: 42 }
    let diag: any
    const out = normalizeAskUserQuestionInput(AUQ, input, (d) => (diag = d)) as any
    expect("question" in out).toBe(false)
    expect(diag.strippedKeys).toContain("question")
    expect(diag.droppedQuestionValue).toBeUndefined()
  })

  test("un-escape semantic misfire is a fixed known-limitation assertion", () => {
    const input = { questions: [{ header: "h", multiSelect: false, options: [] }], question: String.raw`use \u4e2d?` }
    const out = normalizeAskUserQuestionInput(AUQ, input) as any
    expect(out.questions[0].question).toBe("use 中?")
  })
})

describe("normalizeSendMessageInput", () => {
  test("SEND_MESSAGE_TOOL is the SendMessage tool name", () => {
    expect(SEND_MESSAGE_TOOL).toBe("SendMessage")
  })

  test("recovers a missing `to` from a misnamed `agentId` and drops the alias", () => {
    const input = { agentId: "planner", content: "hi" }
    const out = normalizeSendMessageInput("SendMessage", input) as Record<string, unknown>
    expect(out).toEqual({ to: "planner", content: "hi" })
    expect(Object.hasOwn(out, "agentId")).toBe(false)
  })

  test("fires the diag exactly once, naming the alias used", () => {
    const diags: Array<unknown> = []
    normalizeSendMessageInput("SendMessage", { agentId: "planner" }, (d) => diags.push(d))
    expect(diags).toEqual([{ renamedRecipient: true, fromAlias: "agentId" }])
  })

  test("recovers from the `agent_id` alias too", () => {
    const out = normalizeSendMessageInput("SendMessage", { agent_id: "planner", content: "hi" }) as Record<string, unknown>
    expect(out).toEqual({ to: "planner", content: "hi" })
  })

  test("recovers from the `agent` alias too", () => {
    const out = normalizeSendMessageInput("SendMessage", { agent: "planner" }) as Record<string, unknown>
    expect(out).toEqual({ to: "planner" })
  })

  test("alias precedence: agentId wins over agent_id/agent, and ALL alias keys are dropped", () => {
    const diags: Array<unknown> = []
    const out = normalizeSendMessageInput("SendMessage", { agent: "z", agent_id: "y", agentId: "x", content: "hi" }, (d) => diags.push(d)) as Record<
      string,
      unknown
    >
    expect(out).toEqual({ to: "x", content: "hi" })
    expect(Object.hasOwn(out, "agentId")).toBe(false)
    expect(Object.hasOwn(out, "agent_id")).toBe(false)
    expect(Object.hasOwn(out, "agent")).toBe(false)
    expect(diags).toEqual([{ renamedRecipient: true, fromAlias: "agentId" }])
  })

  test("falls through to a later alias when an earlier one is empty/non-string", () => {
    const out = normalizeSendMessageInput("SendMessage", { agentId: "", agent_id: 42, agent: "planner" }) as Record<string, unknown>
    expect(out).toEqual({ to: "planner" })
  })

  test("no-op (same reference) when `to` is already present — even alongside a stray agentId", () => {
    const input = { to: "planner", agentId: "other" }
    expect(normalizeSendMessageInput("SendMessage", input)).toBe(input)
  })

  test("no-op when `to` is present-but-empty (the client's own valid-shape choice)", () => {
    const input = { to: "", agentId: "planner" }
    const out = normalizeSendMessageInput("SendMessage", input)
    expect(out).toBe(input)
  })

  test("no-op when agentId is absent", () => {
    const input = { content: "hi" }
    expect(normalizeSendMessageInput("SendMessage", input)).toBe(input)
  })

  test("no-op when agentId is an empty string (can't produce a valid recipient)", () => {
    const input = { agentId: "" }
    expect(normalizeSendMessageInput("SendMessage", input)).toBe(input)
  })

  test("no-op when agentId is non-string", () => {
    const input = { agentId: 42 }
    expect(normalizeSendMessageInput("SendMessage", input)).toBe(input)
  })

  test("no-op for a non-SendMessage tool (returns same reference)", () => {
    const input = { agentId: "planner" }
    expect(normalizeSendMessageInput("OtherTool", input)).toBe(input)
  })

  test("no-op for non-plain-object input", () => {
    expect(normalizeSendMessageInput("SendMessage", null)).toBeNull()
    const arr = [{ agentId: "x" }]
    expect(normalizeSendMessageInput("SendMessage", arr)).toBe(arr)
    expect(normalizeSendMessageInput("SendMessage", "str")).toBe("str")
  })

  test("does not mutate the original input on change", () => {
    const input = { agentId: "planner" }
    const out = normalizeSendMessageInput("SendMessage", input)
    expect(out).not.toBe(input)
    expect(input).toEqual({ agentId: "planner" })
  })
})
