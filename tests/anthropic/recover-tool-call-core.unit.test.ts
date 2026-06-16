import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { validateInvokeRegion } from "~/lib/anthropic/recover-tool-call/core"

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
