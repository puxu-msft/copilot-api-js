import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  alignMessages,
  alignWithModified,
  messageText,
} from "~/lib/diff/block-align"

describe("messageText (compact projection)", () => {
  test("string content is returned verbatim", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("hello")
  })

  test("array content serializes COMPACT (no pretty-print whitespace)", () => {
    const text = messageText({ role: "user", content: [{ type: "text", text: "hi" }] })
    expect(text).toBe('[{"type":"text","text":"hi"}]')
    expect(text).not.toContain("\n")
  })

  test("null content serializes as null", () => {
    expect(messageText({ role: "assistant", content: null })).toBe("null")
  })
})

describe("alignMessages", () => {
  test("identical sequences are all `same` with both sides set", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    const rows = alignMessages(msgs, msgs)
    expect(rows.map((r) => r.kind)).toEqual(["same", "same"])
    expect(rows[0]).toEqual({ kind: "same", left: "a", right: "a" })
  })

  test("appended message is `added` (right-only)", () => {
    const left = [{ role: "user", content: "a" }]
    const right = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    const rows = alignMessages(left, right)
    expect(rows.map((r) => r.kind)).toEqual(["same", "added"])
    const added = rows[1]
    expect(added.kind).toBe("added")
    expect(added.right).toBe("b")
    expect(added.left).toBeUndefined()
  })

  test("dropped message is `removed` (left-only)", () => {
    const left = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    const right = [{ role: "user", content: "a" }]
    const rows = alignMessages(left, right)
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed"])
    const removed = rows[1]
    expect(removed.kind).toBe("removed")
    expect(removed.left).toBe("b")
    expect(removed.right).toBeUndefined()
  })

  test("same-role changed text pairs in place as `modified` (both sides set)", () => {
    const left = [{ role: "assistant", content: "before" }]
    const right = [{ role: "assistant", content: "after" }]
    const rows = alignMessages(left, right)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ kind: "modified", left: "before", right: "after" })
  })

  test("different-role change is removed + added, not modified", () => {
    const left = [{ role: "user", content: "x" }]
    const right = [{ role: "assistant", content: "y" }]
    const rows = alignMessages(left, right)
    const kinds = rows.map((r) => r.kind).sort()
    expect(kinds).toEqual(["added", "removed"])
    expect(rows.some((r) => r.kind === "modified")).toBe(false)
  })
})

describe("NUL separator prevents false role/content merge", () => {
  // With a space separator, role "a" + content "b" and role "a b" + content ""
  // would collide; the NUL key keeps them distinct. Verify they are NOT aligned
  // as `same`.
  test("role+content boundary is unambiguous", () => {
    const left = [{ role: "a", content: "b" }]
    const right = [{ role: "a b", content: "" }]
    const rows = alignMessages(left, right)
    expect(rows.every((r) => r.kind !== "same")).toBe(true)
  })
})

describe("alignWithModified generic core", () => {
  test("aligns arbitrary items by keyOf, pairs modified by groupOf", () => {
    type Frame = { type: string; raw: string }
    const upstream: Array<Frame> = [
      { type: "delta", raw: "1" },
      { type: "delta", raw: "2" },
    ]
    const forwarded: Array<Frame> = [
      { type: "delta", raw: "1" },
      { type: "delta", raw: "2-rewritten" },
    ]
    const rows = alignWithModified(
      upstream,
      forwarded,
      (f) => `${f.type}\0${f.raw}`,
      (f) => f.type,
    )
    expect(rows.map((r) => r.kind)).toEqual(["same", "modified"])
    expect(rows[1].left?.raw).toBe("2")
    expect(rows[1].right?.raw).toBe("2-rewritten")
  })
})
