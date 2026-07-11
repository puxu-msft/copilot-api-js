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
  fixBadUnicodeEscapes,
  fixBadUnicodeEscapesLossy,
  repairToolInput,
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

// Real opus-4.8 AskUserQuestion capture (req_1782778207147_144): the upstream emitted `\u9 ed8`
// (the `默` escape with a space breaking the 4 hex digits), so the stringified `questions` JSON is
// invalid at the bad `\u` escape — antml-strip is a no-op (no tags) and jsonrepair THROWS on it.
const FIXTURE_UNICODE = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", "askuserquestion-unicode-escape-1782778207147-144.json"),
      "utf8",
    ),
  ) as { raw: string }
).raw

// Two real opus-4.8 AskUserQuestion captures where a hex digit was DROPPED from a `\uXXXX` escape
// (e.g. `\u9 44` — a space plus only THREE hex digits). Unlike the whitespace-split-but-recoverable
// `\u9 ed8`, these can NOT be completed to four hex digits, so `fixBadUnicodeEscapes` (lossless) is a
// no-op and the input stays malformed. Lossless repair is impossible (the missing nibble is unknowable).
const FIXTURE_DROPPED_HEX_233 = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", "askuserquestion-dropped-hex-digit-1783388427550-233.json"),
      "utf8",
    ),
  ) as { raw: string }
).raw

const FIXTURE_DROPPED_HEX_204 = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", "askuserquestion-dropped-hex-digit-1783431413629-204.json"),
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

describe("repairToolInput — item-set cascade (canonical order, items stack)", () => {
  test('["tags"] strips antml bleed → layer "strip" (≡ legacy "tags" tier)', () => {
    const r = repairToolInput(FIXTURE_1304, ["tags"])
    expect(r).toMatchObject({ layer: "strip" })
    expect("repaired" in r && (r.repaired as { todos: Array<unknown> }).todos).toHaveLength(6)
  })

  test('["tags","jsonrepair"] repairs a structural truncation via jsonrepair → layer "jsonrepair" (≡ legacy "repair" tier)', () => {
    const r = repairToolInput(FIXTURE_JSONREPAIR, ["tags", "jsonrepair"])
    expect(r).toMatchObject({ layer: "jsonrepair" })
    expect("repaired" in r && (r.repaired as { subagent_type: string }).subagent_type).toBe("general-purpose")
  })

  test('["jsonrepair"] alone (no tags strip) still fixes a tag-free structural truncation', () => {
    // The jsonrepair fixture has no antml tags, so jsonrepair runs directly on the raw bytes.
    const r = repairToolInput(FIXTURE_JSONREPAIR, ["jsonrepair"])
    expect(r).toMatchObject({ layer: "jsonrepair" })
  })

  test('["jsonrepair"] alone on antml-bleed is unrepairable (jsonrepair throws without a prior tags strip)', () => {
    // jsonrepair raises on the antml bleed; with no `tags` item to strip first, nothing rescues it.
    expect(repairToolInput(FIXTURE_1304, ["jsonrepair"])).toEqual({ unrepairable: true })
  })

  test('["tags"] alone cannot fix a tag-free structural truncation → unrepairable', () => {
    expect(repairToolInput(FIXTURE_JSONREPAIR, ["tags"])).toEqual({ unrepairable: true })
  })

  test("empty item set never repairs → unrepairable", () => {
    expect(repairToolInput(FIXTURE_1304, [])).toEqual({ unrepairable: true })
  })

  test("already-valid input is returned via the first enabled layer (no-op transform)", () => {
    const valid = '{"a":1,"b":[1,2]}'
    const r = repairToolInput(valid, ["tags", "jsonrepair"])
    expect(r).toMatchObject({ layer: "strip" })
    expect("repaired" in r && r.repaired).toEqual({ a: 1, b: [1, 2] })
  })
})

describe(String.raw`fixBadUnicodeEscapes — conservative whitespace-broken \uXXXX repair`, () => {
  test(String.raw`a legal \uXXXX escape is returned byte-identical (no false repair)`, () => {
    const clean = String.raw`{"x":"\u9ed8\u8ba4"}` // 默认
    expect(fixBadUnicodeEscapes(clean)).toBe(clean)
  })

  test(String.raw`a space breaking the 4 hex digits is removed (\u9 ed8 → \u9ed8)`, () => {
    expect(fixBadUnicodeEscapes(String.raw`{"x":"\u9 ed8"}`)).toBe(String.raw`{"x":"\u9ed8"}`)
  })

  test(String.raw`the break can fall anywhere between the hex digits (\u9e d8 → \u9ed8)`, () => {
    expect(fixBadUnicodeEscapes(String.raw`{"x":"\u9e d8"}`)).toBe(String.raw`{"x":"\u9ed8"}`)
  })

  test("tab and newline also count as the breaking whitespace", () => {
    expect(fixBadUnicodeEscapes('{"x":"\\u9\ted8"}')).toBe(String.raw`{"x":"\u9ed8"}`)
    expect(fixBadUnicodeEscapes('{"x":"\\u9\ned8"}')).toBe(String.raw`{"x":"\u9ed8"}`)
  })

  test(String.raw`CONSERVATIVE: whitespace immediately after \u (\u 9ed8) is NOT touched`, () => {
    const input = String.raw`{"x":"\u 9ed8"}`
    expect(fixBadUnicodeEscapes(input)).toBe(input)
  })

  test(String.raw`CONSERVATIVE: too few hex digits (\u9ed) is NOT touched`, () => {
    const input = String.raw`{"x":"\u9ed"}`
    expect(fixBadUnicodeEscapes(input)).toBe(input)
  })

  test(String.raw`CONSERVATIVE: non-hex characters (\uZZZZ) are NOT touched`, () => {
    const input = String.raw`{"x":"\uZZZZ"}`
    expect(fixBadUnicodeEscapes(input)).toBe(input)
  })

  test(String.raw`a non-\u backslash escape is left alone (\n, \")`, () => {
    const input = String.raw`{"x":"line\nbreak \"q\""}`
    expect(fixBadUnicodeEscapes(input)).toBe(input)
  })

  test("multiple bad escapes in one string are all repaired", () => {
    expect(fixBadUnicodeEscapes(String.raw`{"x":"\u9 ed8\u8b a4"}`)).toBe(String.raw`{"x":"\u9ed8\u8ba4"}`)
  })

  test("idempotent: repairing an already-repaired string is a no-op", () => {
    const once = fixBadUnicodeEscapes(String.raw`{"x":"\u9 ed8"}`)
    expect(fixBadUnicodeEscapes(once)).toBe(once)
  })

  test(String.raw`real req_1782778207147_144 AskUserQuestion capture → fixes \u9 ed8 → valid JSON (independent oracle)`, () => {
    expect(() => JSON.parse(FIXTURE_UNICODE)).toThrow() // precondition: malformed at the bad escape
    const fixed = fixBadUnicodeEscapes(FIXTURE_UNICODE)
    const parsed = JSON.parse(fixed) as { questions: Array<{ options: Array<unknown> }> }
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0].options.length).toBeGreaterThan(0)
  })
})

describe("repairToolInput — unicode item", () => {
  test(String.raw`["unicode"] repairs the bad \u escape → layer "unicode"`, () => {
    const r = repairToolInput(FIXTURE_UNICODE, ["unicode"])
    expect(r).toMatchObject({ layer: "unicode" })
    expect("repaired" in r && (r.repaired as { questions: Array<unknown> }).questions).toHaveLength(1)
  })

  test('["tags","unicode","jsonrepair"] full set repairs it via the unicode item', () => {
    const r = repairToolInput(FIXTURE_UNICODE, ["tags", "unicode", "jsonrepair"])
    expect(r).toMatchObject({ layer: "unicode" })
  })

  test(String.raw`the legacy "repair" tier (["tags","jsonrepair"]) does NOT fix a bad \u escape (jsonrepair throws) → unrepairable`, () => {
    // This is exactly the req_1782778207147_144 failure: tags is a no-op, jsonrepair throws on `\u9 ed8`.
    expect(repairToolInput(FIXTURE_UNICODE, ["tags", "jsonrepair"])).toEqual({ unrepairable: true })
  })

  test(String.raw`["tags"] alone does NOT fix a bad \u escape → unrepairable`, () => {
    expect(repairToolInput(FIXTURE_UNICODE, ["tags"])).toEqual({ unrepairable: true })
  })
})

const FFFD = "�"

describe(String.raw`fixBadUnicodeEscapesLossy — best-effort (lossy) \uXXXX repair for un-completable escapes`, () => {
  test(String.raw`a legal \uXXXX escape is returned byte-identical (no false repair)`, () => {
    const clean = String.raw`{"x":"默认"}` // 默认
    expect(fixBadUnicodeEscapesLossy(clean)).toBe(clean)
  })

  test(String.raw`a whitespace-split-but-recoverable escape is completed losslessly (\u9 ed8 → 默), NOT replaced`, () => {
    // Delegates to the strict path for anything recoverable to four hex digits — lossy replacement
    // is the LAST resort, never applied when the four digits can be recovered. Escaped form preserved.
    const out = fixBadUnicodeEscapesLossy(String.raw`{"x":"\u9 ed8"}`)
    expect((JSON.parse(out) as { x: string }).x).toBe("默") // recovered losslessly to 默
    expect(out).not.toContain(FFFD) // no garbling when the 4 hex digits are recoverable
  })

  test(String.raw`a dropped-hex-digit escape (only 2-3 hex, quote-terminated) is replaced with U+FFFD`, () => {
    // `\u9 4` cannot be completed to 4 hex → the whole broken `\u…` run becomes one replacement char.
    const out = fixBadUnicodeEscapesLossy(String.raw`{"x":"\u9 4"}`)
    expect(out).toBe(`{"x":"${FFFD}"}`)
    expect((JSON.parse(out) as { x: string }).x).toBe(FFFD)
  })

  test(String.raw`the dropped-hex run stops at the first non-hex terminator (real \u9 44\u… shape)`, () => {
    // Mirrors the real capture: `\u9 44` (3 hex) followed by the next escape's backslash → un-completable.
    const out = fixBadUnicodeEscapesLossy(String.raw`{"x":"a\u9 44认"}`)
    expect((JSON.parse(out) as { x: string }).x).toBe(`a${FFFD}认`) // 认 = 认 survives
  })

  test(String.raw`RECOVERS more than the strict pass: leading-ws-but-4-hex (\u 9ed8) → 默 losslessly`, () => {
    // The strict `fixBadUnicodeEscapes` conservatively skips a leading space, but the lossy pass
    // collects the four hex digits (skipping any whitespace) and recovers the char — replacement is
    // reserved for genuinely un-completable escapes (fewer than four hex digits).
    const out = fixBadUnicodeEscapesLossy(String.raw`{"x":"\u 9ed8"}`)
    expect((JSON.parse(out) as { x: string }).x).toBe("默") // 4 hex recovered despite leading space
    expect(out).not.toContain(FFFD)
  })

  test(String.raw`\u immediately followed by a non-hex terminator (\u") → single U+FFFD, terminator kept`, () => {
    const out = fixBadUnicodeEscapesLossy(String.raw`{"x":"a\ub"}`)
    // `\ub` = 1 hex then quote → un-completable → FFFD; the trailing `b"` structure survives.
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).toContain(FFFD)
  })

  test(String.raw`a non-\u backslash escape is left alone (\n, \")`, () => {
    const input = String.raw`{"x":"line\nbreak \"q\""}`
    expect(fixBadUnicodeEscapesLossy(input)).toBe(input)
  })

  test("idempotent: a U+FFFD introduced by a prior pass is not re-processed", () => {
    const once = fixBadUnicodeEscapesLossy(String.raw`{"x":"\u9 4"}`)
    expect(fixBadUnicodeEscapesLossy(once)).toBe(once)
  })

  test("real req_1783388427550_233 dropped-hex capture → valid JSON, exactly 1 garbled char, structure intact", () => {
    expect(() => JSON.parse(FIXTURE_DROPPED_HEX_233)).toThrow() // precondition: malformed
    expect(() => JSON.parse(fixBadUnicodeEscapes(FIXTURE_DROPPED_HEX_233))).toThrow() // lossless can't fix it

    const parsed = JSON.parse(fixBadUnicodeEscapesLossy(FIXTURE_DROPPED_HEX_233)) as {
      questions: Array<{ header: string; options: Array<{ label: string }> }>
    }
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0].header).toBe("vertex 清洗模式")
    expect(parsed.questions[0].options.map((o) => o.label)).toEqual(["可配旋钮，默认 as_user（推荐）", "固定 as_user"])
    // Only the un-completable escape is lost — one replacement char, everything else preserved.
    expect((JSON.stringify(parsed).match(/�/g) ?? []).length).toBe(1)
  })

  test("real req_1783431413629_204 dropped-hex capture → valid JSON, 2 garbled chars, structure intact", () => {
    expect(() => JSON.parse(FIXTURE_DROPPED_HEX_204)).toThrow() // precondition: malformed

    const parsed = JSON.parse(fixBadUnicodeEscapesLossy(FIXTURE_DROPPED_HEX_204)) as {
      questions: Array<{ header: string; options: Array<{ label: string }> }>
    }
    expect(parsed.questions).toHaveLength(2)
    expect(parsed.questions[0].header).toBe("命名定稿")
    expect(parsed.questions[0].options.map((o) => o.label)).toEqual(["全采纳", "effectiveSource 改名", "peer 前缀再议"])
    expect(parsed.questions[1].header).toBe("下一步")
    expect((JSON.stringify(parsed).match(/�/g) ?? []).length).toBe(2)
  })
})

describe("repairToolInput — unicode-lossy item (best-effort last resort)", () => {
  test(String.raw`["unicode-lossy"] rescues a dropped-hex escape the lossless items can't → layer "unicode-lossy"`, () => {
    const r = repairToolInput(FIXTURE_DROPPED_HEX_233, ["unicode-lossy"])
    expect(r).toMatchObject({ layer: "unicode-lossy" })
    expect("repaired" in r && (r.repaired as { questions: Array<unknown> }).questions).toHaveLength(1)
  })

  test("full set with unicode-lossy last: a truly-lossless-unrepairable input is rescued lossily", () => {
    const r = repairToolInput(FIXTURE_DROPPED_HEX_204, ["tags", "unicode", "jsonrepair", "unicode-lossy"])
    expect(r).toMatchObject({ layer: "unicode-lossy" })
  })

  test("unicode-lossy runs AFTER the lossless items — a recoverable escape wins via lossless unicode, not lossy", () => {
    // FIXTURE_UNICODE is losslessly recoverable (\u9 ed8), so the `unicode` item must claim it first.
    const r = repairToolInput(FIXTURE_UNICODE, ["unicode", "unicode-lossy"])
    expect(r).toMatchObject({ layer: "unicode" })
  })

  test("without unicode-lossy, a dropped-hex escape stays unrepairable (current prod behavior)", () => {
    expect(repairToolInput(FIXTURE_DROPPED_HEX_233, ["tags", "unicode", "jsonrepair"])).toEqual({ unrepairable: true })
  })

  test("unicode-lossy handles a dropped-hex escape AND a structural truncation together (lossy replace + jsonrepair close)", () => {
    // `\u9 4` (un-completable) inside an input whose closing `]}` is also truncated → the lossy pass
    // replaces the escape with U+FFFD, then the trailing jsonrepair closes the structure.
    const combined = String.raw`{"questions":[{"header":"a\u9 4b","options":[{"label":"x"}`
    expect(() => JSON.parse(combined)).toThrow()
    const r = repairToolInput(combined, ["unicode-lossy"])
    expect(r).toMatchObject({ layer: "unicode-lossy" })
    const q = "repaired" in r ? (r.repaired as { questions: Array<{ header: string; options: Array<unknown> }> }).questions : []
    expect(q).toHaveLength(1)
    expect(q[0].header).toContain(FFFD)
    expect(q[0].options).toHaveLength(1)
  })
})
