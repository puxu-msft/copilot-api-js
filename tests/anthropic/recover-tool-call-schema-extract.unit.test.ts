import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"

describe("extractToolParamTypes", () => {
  test("提取已知字段类型，忽略未知 type", () => {
    const tools = [
      {
        name: "AskUserQuestion",
        input_schema: { properties: { questions: { type: "array" }, note: { type: "string" }, weird: { type: "null" } } },
      },
      { name: "Bash", input_schema: { properties: { command: { type: "string" }, timeout: { type: "number" } } } },
    ]
    const map = extractToolParamTypes(tools)
    expect(map.get("AskUserQuestion")).toEqual({ questions: "array", note: "string" })
    expect(map.get("Bash")).toEqual({ command: "string", timeout: "number" })
  })

  test("无 input_schema / 无 properties → 空对象（工具仍登记）", () => {
    const map = extractToolParamTypes([{ name: "NoSchema" }, { name: "NoProps", input_schema: {} }])
    expect(map.get("NoSchema")).toEqual({})
    expect(map.get("NoProps")).toEqual({})
  })

  test("undefined tools → 空 map", () => {
    expect(extractToolParamTypes(undefined).size).toBe(0)
  })
})
