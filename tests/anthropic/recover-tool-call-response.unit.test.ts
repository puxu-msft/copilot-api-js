import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { recoverToolCallTextInResponse } from "~/lib/anthropic/recover-tool-call"
import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"

const schemas = extractToolParamTypes([{ name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } }])
const toolNames = new Set(["Write"])

describe("recoverToolCallTextInResponse", () => {
  test("档 B：end_turn + 降级 text block → 重建 tool_use + stop_reason→tool_use", () => {
    const resp = {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "…", signature: "x" },
        {
          type: "text",
          text: `先写文件。\ncall\n<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n`,
        },
      ],
    } as any
    const out = recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })
    expect(out.stop_reason).toBe("tool_use")
    const types = (out.content as Array<any>).map((b: any) => b.type)
    expect(types).toContain("tool_use")
    const tu = (out.content as Array<any>).find((b: any) => b.type === "tool_use")
    expect(tu.name).toBe("Write")
    expect(tu.input).toEqual({ file_path: "/a", content: "x" })
    expect(tu.id).toMatch(/^toolu_[0-9A-Za-z]{24}$/)
    expect(out.content.some((b: any) => b.type === "text" && b.text.includes("先写文件"))).toBe(true)
  })

  test("enabled:false → 原样返回（同引用）", () => {
    const resp = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: `call<invoke name="Write"><parameter name="content">x</parameter></invoke>` }],
    } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: false, toolNames, toolSchemas: schemas })).toBe(resp)
  })

  test("误报防线：已有真实 tool_use block → 不处理（P3）", () => {
    const resp = {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "toolu_real", name: "Write", input: {} },
        { type: "text", text: `call<invoke name="Write"><parameter name="content">x</parameter></invoke>` },
      ],
    } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })).toBe(resp)
  })

  test("腰斩 text → 不改写（原引用）", () => {
    const resp = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: `call<invoke name="Write"><parameter name="content">见 </parameter> 残</parameter></invoke>` }],
    } as any
    expect(recoverToolCallTextInResponse(resp, { enabled: true, toolNames, toolSchemas: schemas })).toBe(resp)
  })
})
