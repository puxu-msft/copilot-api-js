import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  parseJson,
  unescapeJsonString,
} from "@/lib/json-tools"

describe("unescapeJsonString", () => {
  it("decodes a bare escaped body (tool_call arguments shape)", () => {
    const r = unescapeJsonString(String.raw`{\"name\":\"foo\",\"n\":1}`)
    expect(r).toEqual({ ok: true, value: '{"name":"foo","n":1}' })
  })

  it("decodes a quoted JSON string literal", () => {
    const r = unescapeJsonString(String.raw`"{\"a\":1}"`)
    expect(r).toEqual({ ok: true, value: '{"a":1}' })
  })

  it(String.raw`decodes escape sequences (\n, \t, \\) once`, () => {
    const r = unescapeJsonString(String.raw`line1\nline2\tend\\done`)
    expect(r).toEqual({ ok: true, value: "line1\nline2\tend\\done" })
  })

  it("decodes unicode escapes", () => {
    const r = unescapeJsonString(String.raw`\u4f60\u597d`)
    expect(r).toEqual({ ok: true, value: "你好" })
  })

  it("is single-level: one pass decodes an escaped backslash, leaving the next layer intact", () => {
    // Raw body `a\\nb` (escaped backslash + literal n) decodes once to `a\nb`
    // (backslash + n), NOT to a newline — a second pass would be needed for that.
    const r = unescapeJsonString(String.raw`a\\nb`)
    expect(r).toEqual({ ok: true, value: String.raw`a\nb` })
  })

  it("is single-level: a doubly-escaped JSON body decodes to a still-escaped body", () => {
    // `{\\\"a\\\":1}` → one pass → `{\"a\":1}` (still escaped; a second pass
    // would be needed to reach `{"a":1}`).
    const r = unescapeJsonString(String.raw`{\\\"a\\\":1}`)
    expect(r).toEqual({ ok: true, value: String.raw`{\"a\":1}` })
  })

  it("errors on empty input", () => {
    expect(unescapeJsonString("   ")).toEqual({ ok: false, error: "输入为空" })
  })

  it("errors on an un-decodable body", () => {
    const r = unescapeJsonString('{"a":1}')
    expect(r.ok).toBe(false)
  })
})

describe("parseJson", () => {
  it("parses an object", () => {
    expect(parseJson('{"a":[1,2],"b":null}')).toEqual({ ok: true, value: { a: [1, 2], b: null } })
  })

  it("tolerates surrounding whitespace", () => {
    expect(parseJson("  [1, 2, 3]  ")).toEqual({ ok: true, value: [1, 2, 3] })
  })

  it("errors on empty input", () => {
    expect(parseJson("")).toEqual({ ok: false, error: "输入为空" })
  })

  it("errors on invalid JSON", () => {
    const r = parseJson("{not json}")
    expect(r.ok).toBe(false)
  })
})
