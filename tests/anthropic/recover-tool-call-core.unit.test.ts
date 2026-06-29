import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  findDowngradeMarkPos,
  isInvokeTerminal,
  isResidueWhitespaceAdjacent,
  recoverDowngradeTail,
  synthesizeToolUseId,
  type ToolParamTypes,
  validateInvokeRegion,
} from "~/lib/anthropic/recover-tool-call/core"

describe("validateInvokeRegion (whitespace-tolerant 位置不变量)", () => {
  test("真实 entry210 形态（标签间含换行）→ 通过，非贪婪取值", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">/tmp/a.ts</parameter>\n<parameter name="content">/** x */\n}\n</parameter>\n</invoke>`
    const r = validateInvokeRegion(region)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe("Write")
      expect(r.params.file_path).toBe("/tmp/a.ts")
      expect(r.params.content).toBe("/** x */\n}\n")
    }
  })

  test("content 含 </parameter> 字面量（腰斩陷阱）→ 拒绝（绝不部分成功）", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">/tmp/a.md</parameter>\n<parameter name="content">见 </parameter> 标签即闭合</parameter>\n</invoke>`
    expect(validateInvokeRegion(region).ok).toBe(false)
  })

  test("content 含配对 <parameter>X</parameter> 字面量（讲解格式的文档）→ 拒绝", () => {
    const region = `<invoke name="Write">\n<parameter name="file_path">x</parameter>\n<parameter name="content">see <parameter name="foo">bar</parameter> in docs</parameter>\n</invoke>`
    expect(validateInvokeRegion(region).ok).toBe(false)
  })

  test("合法多参数 Edit → 通过", () => {
    const region = `<invoke name="Edit">\n<parameter name="file_path">x.ts</parameter>\n<parameter name="old_string">foo</parameter>\n<parameter name="new_string">bar</parameter>\n</invoke>`
    const r = validateInvokeRegion(region)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.params)).toEqual(["file_path", "old_string", "new_string"])
  })

  test("无 invoke 包裹 → 拒绝", () => {
    expect(validateInvokeRegion("just prose").ok).toBe(false)
  })
})

describe("findDowngradeMarkPos", () => {
  const tools = new Set(["Write", "Bash"])

  test(String.raw`真实 entry210 形态：散文 + call\n<invoke> → markPos 指向 call`, () => {
    const text = `分析…纯拓扑数据模型）。\n\ncall\n<invoke name="Write">\n<parameter name="file_path">x</parameter>\n</invoke>\n`
    const pos = findDowngradeMarkPos(text, tools)
    expect(pos).toBeGreaterThan(0)
    expect(text.slice(pos)).toMatch(/^call\s*<invoke/)
  })

  test("英文散文 call the function … <invoke>（实义词间隔）→ markPos 退回 <invoke> 起点", () => {
    const text = `you can call the function <invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
    const pos = findDowngradeMarkPos(text, tools)
    expect(text.slice(pos)).toMatch(/^<invoke name="Bash"/)
  })

  test("court 残留前缀紧贴 <invoke> → markPos 指向 court", () => {
    expect(findDowngradeMarkPos(`court<invoke name="Write"></invoke>`, tools)).toBe(0)
  })

  test("invoke 工具名不在工具集 → -1", () => {
    expect(findDowngradeMarkPos(`call<invoke name="Unknown"></invoke>`, tools)).toBe(-1)
  })

  test("无 invoke → -1", () => {
    expect(findDowngradeMarkPos("just talking about calling tools", tools)).toBe(-1)
  })
})

describe("recoverDowngradeTail", () => {
  const schemas = new Map<string, ToolParamTypes>([
    ["Write", { file_path: "string", content: "string" }],
    ["AskUserQuestion", { questions: "array" }],
    ["Bash", { command: "string", timeout: "number" }],
  ])

  test(String.raw`真实形态：call\n<invoke> 尾部 → 1 tool_use，参数为字符串`, () => {
    const tail = `call\n<invoke name="Write">\n<parameter name="file_path">/tmp/a.ts</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n`
    const r = recoverDowngradeTail(tail, schemas)
    expect(r.recovered).toBe(true)
    expect(r.blocks).toHaveLength(1)
    const b = r.blocks[0]
    expect(b.type).toBe("tool_use")
    if (b.type === "tool_use") {
      expect(b.name).toBe("Write")
      expect(b.input).toEqual({ file_path: "/tmp/a.ts", content: "x" })
    }
  })

  test("array 参数按 schema JSON.parse 成结构化", () => {
    const tail = `call<invoke name="AskUserQuestion"><parameter name="questions">[{"q":"x"}]</parameter></invoke>`
    const r = recoverDowngradeTail(tail, schemas)
    expect(r.recovered).toBe(true)
    if (r.blocks[0].type === "tool_use") expect(r.blocks[0].input.questions).toEqual([{ q: "x" }])
  })

  test("number 参数 → Number；非法 JSON array → 回退字符串", () => {
    const tail1 = `call<invoke name="Bash"><parameter name="command">ls</parameter><parameter name="timeout">30</parameter></invoke>`
    const r1 = recoverDowngradeTail(tail1, schemas)
    if (r1.blocks[0].type === "tool_use") expect(r1.blocks[0].input.timeout).toBe(30)
    const tail2 = `call<invoke name="AskUserQuestion"><parameter name="questions">not json</parameter></invoke>`
    const r2 = recoverDowngradeTail(tail2, schemas)
    if (r2.blocks[0].type === "tool_use") expect(r2.blocks[0].input.questions).toBe("not json")
  })

  test("腰斩（content 含 </parameter> 字面量）→ recovered:false", () => {
    const tail = `call<invoke name="Write"><parameter name="content">见 </parameter> 残</parameter></invoke>`
    expect(recoverDowngradeTail(tail, schemas).recovered).toBe(false)
  })

  test("schema 缺失工具 → 全字段字符串", () => {
    const tail = `call<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
    const r = recoverDowngradeTail(tail, new Map())
    expect(r.recovered).toBe(true)
    if (r.blocks[0].type === "tool_use") expect(r.blocks[0].input).toEqual({ command: "ls" })
  })

  test("court 残留前缀被剥除 → 1 tool_use", () => {
    const tail = `court<invoke name="Bash"><parameter name="command">ls</parameter></invoke>`
    const r = recoverDowngradeTail(tail, schemas)
    expect(r.recovered).toBe(true)
    if (r.blocks[0].type === "tool_use") expect(r.blocks[0].input).toEqual({ command: "ls" })
  })
})

describe("门控谓词", () => {
  test(String.raw`isResidueWhitespaceAdjacent: call\n<invoke> → true；call the func <invoke> → false`, () => {
    expect(isResidueWhitespaceAdjacent('x。\n\ncall\n<invoke name="Write">')).toBe(true)
    expect(isResidueWhitespaceAdjacent('you call the func <invoke name="Bash">')).toBe(false)
  })

  test("isInvokeTerminal: </invoke> 后仅空白 → true；后有散文 → false", () => {
    expect(isInvokeTerminal("…</invoke>\n")).toBe(true)
    expect(isInvokeTerminal("…</invoke>\n然后我再解释一下")).toBe(false)
  })
})

describe("synthesizeToolUseId", () => {
  test("toolu_ + 24 base62，确定性", () => {
    const id1 = synthesizeToolUseId("Write", 0, "tail-content")
    const id2 = synthesizeToolUseId("Write", 0, "tail-content")
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^toolu_[0-9A-Za-z]{24}$/)
  })

  test("不同序号 → 不同 id", () => {
    expect(synthesizeToolUseId("Write", 0, "x")).not.toBe(synthesizeToolUseId("Write", 1, "x"))
  })
})
