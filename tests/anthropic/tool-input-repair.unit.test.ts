import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  //
  stripAntmlTagsOutsideStrings,
  tryJsonRepair,
} from "~/lib/anthropic/tool-input-repair"

const FIXTURE_1304 = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", "todowrite-antml-bleed-1304.json"), "utf8"),
  ) as { raw: string }
).raw

const FIXTURE_JSONREPAIR = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", "task-truncated-jsonrepair-1782641593660-64.json"),
      "utf8",
    ),
  ) as { raw: string }
).raw

describe("stripAntmlTagsOutsideStrings — Layer 1 structure-aware antml-tag stripping", () => {
  test("real 1304 TodoWrite antml-bleed → strips tags → valid JSON, semantically intact", () => {
    // The captured input is `{"todos":[...]` + `</parameter>\n</invoke>\n` + `}` (mid-structure bleed).
    expect(() => JSON.parse(FIXTURE_1304)).toThrow() // precondition: raw bytes are malformed

    const stripped = stripAntmlTagsOutsideStrings(FIXTURE_1304)
    const parsed = JSON.parse(stripped) as { todos: Array<{ content: string; status: string; activeForm: string }> }

    expect(Array.isArray(parsed.todos)).toBe(true)
    expect(parsed.todos).toHaveLength(6)
    expect(parsed.todos[0]?.status).toBe("in_progress")
    expect(parsed.todos[5]?.content).toBe("提交")
    // No antml residue survived outside strings.
    expect(stripped).not.toContain("</parameter>")
    expect(stripped).not.toContain("</invoke>")
  })

  test("does NOT touch antml-looking text inside a string value (no false strip)", () => {
    const input = '{"text":"remember to close </parameter> and </invoke> tags","ok":true}'
    const out = stripAntmlTagsOutsideStrings(input)
    // The literal tags live inside the string value → must survive byte-for-byte.
    expect(out).toBe(input)
    expect((JSON.parse(out) as { text: string }).text).toContain("</parameter>")
  })

  test("mid-object bleed between a value and a comma", () => {
    expect(stripAntmlTagsOutsideStrings('{"a":1</parameter>,"b":2}')).toBe('{"a":1,"b":2}')
  })

  test("single-level object with trailing closing tags", () => {
    expect(stripAntmlTagsOutsideStrings('{"a":1</parameter></invoke>}')).toBe('{"a":1}')
  })

  test("strips opening tags with attributes (inner quotes don't confuse the scanner)", () => {
    expect(stripAntmlTagsOutsideStrings('{"a":<parameter name="todos">1}')).toBe('{"a":1}')
    expect(stripAntmlTagsOutsideStrings('<invoke name="TodoWrite">{"a":1}')).toBe('{"a":1}')
  })

  test("happy-path valid JSON with no antml tags is returned byte-identical", () => {
    const clean = '{"todos":[{"content":"x","status":"pending","activeForm":"y"}],"n":3}'
    expect(stripAntmlTagsOutsideStrings(clean)).toBe(clean)
  })

  test("a string value containing a lone '<' is preserved", () => {
    const input = '{"expr":"a < b && c > d"}'
    expect(stripAntmlTagsOutsideStrings(input)).toBe(input)
  })

  test("multiple independent malformed inputs each strip cleanly", () => {
    expect(stripAntmlTagsOutsideStrings('{"x":"a"}</parameter>')).toBe('{"x":"a"}')
    expect(stripAntmlTagsOutsideStrings('</invoke>{"y":2}')).toBe('{"y":2}')
    expect(stripAntmlTagsOutsideStrings('{"z":[1,2]</parameter></invoke>}')).toBe('{"z":[1,2]}')
  })
})

describe("tryJsonRepair — Layer 2 jsonrepair-backed structural repair", () => {
  test(String.raw`real structurally-truncated tool input → repaired to valid JSON, CJK preserved, no literal \u`, () => {
    expect(() => JSON.parse(FIXTURE_JSONREPAIR)).toThrow() // precondition: raw bytes are malformed
    // Layer 1 alone cannot fix a missing closing structure (no antml tags here).
    expect(() => JSON.parse(stripAntmlTagsOutsideStrings(FIXTURE_JSONREPAIR))).toThrow()

    const repaired = tryJsonRepair(FIXTURE_JSONREPAIR)
    expect(repaired).toBeDefined()
    const parsed = JSON.parse(repaired!) as { subagent_type: string; description: string; prompt: string }
    expect(Object.keys(parsed).sort()).toEqual(["description", "prompt", "subagent_type"])
    // jsonrepair completes the structure WITHOUT mangling real Chinese into `\uXXXX`.
    expect(parsed.prompt).toContain("请给出")
    expect(repaired).not.toMatch(/\\u[0-9a-fA-F]{4}/)
  })

  test("antml-bleed input makes jsonrepair throw → swallowed → undefined", () => {
    // jsonrepair raises `JSONRepairError: Colon expected` on the 1304 antml bleed;
    // tryJsonRepair must catch it and report failure rather than propagate.
    expect(tryJsonRepair(FIXTURE_1304)).toBeUndefined()
  })

  test("already-valid JSON passes the re-parse gate unchanged", () => {
    const valid = '{"a":1,"b":[1,2],"c":"x"}'
    expect(tryJsonRepair(valid)).toBe(valid)
  })

  test("irrecoverable garbage that re-parse gate rejects → undefined", () => {
    // Defensive: even if jsonrepair returns without throwing, the re-parse gate
    // guards against a heuristic result that still isn't valid JSON.
    expect(tryJsonRepair("")).toBeUndefined()
  })
})
