/**
 * Exhaustive pure-logic tests for the layered block-diff utility.
 *
 * Asserts real diff output (jsdiff-backed leaf diff + domain aligner), not
 * trivial mocks: every case checks the actual added/removed flags, alignment
 * kinds, paired "modified" rows, gutter line numbers, and summary counts.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageContent } from "@/lib/content/types"
import type { SseEventRecord } from "@/types"

import {
  //
  alignWithModified,
  diffLinesRich,
  diffMessageList,
  diffSseFrames,
  diffStats,
  diffText,
} from "@/lib/diff/block-diff"

// ── helpers ──

const msg = (role: string, content: string): MessageContent => ({ role, content })
const frame = (type: string, raw: string, offsetMs = 0): SseEventRecord => ({ offsetMs, type, raw })

// ── L3: diffText ──

describe("diffText", () => {
  test("flags the changed word as removed+added, keeps the shared prefix unchanged", () => {
    // Arrange
    const a = "foo bar"
    const b = "foo baz"

    // Act
    const parts = diffText(a, b)

    // Assert: a shared unchanged part exists (no added/removed flags).
    const shared = parts.filter((p) => !p.added && !p.removed)
    expect(shared.length).toBeGreaterThan(0)
    expect(shared.map((p) => p.value).join("")).toContain("foo")

    // The changed word surfaces as a removed part and an added part.
    const removed = parts.filter((p) => p.removed === true)
    const added = parts.filter((p) => p.added === true)
    expect(removed.length).toBeGreaterThan(0)
    expect(added.length).toBeGreaterThan(0)
    expect(removed.map((p) => p.value).join("")).toContain("bar")
    expect(added.map((p) => p.value).join("")).toContain("baz")

    // Reconstructing only old (shared+removed) yields the original `a`.
    expect(
      parts
        .filter((p) => !p.added)
        .map((p) => p.value)
        .join(""),
    ).toBe(a)
    // Reconstructing only new (shared+added) yields `b`.
    expect(
      parts
        .filter((p) => !p.removed)
        .map((p) => p.value)
        .join(""),
    ).toBe(b)
  })

  test("identical strings produce no added/removed parts", () => {
    // Arrange / Act
    const parts = diffText("same text", "same text")

    // Assert
    expect(parts.some((p) => p.added || p.removed)).toBe(false)
    expect(parts.map((p) => p.value).join("")).toBe("same text")
  })
})

// ── Generic domain aligner: all four kinds ──

describe("alignWithModified", () => {
  // Minimal item: key drives equality, group drives "same slot".
  interface Item {
    k: string
    g: string
  }
  const keyOf = (t: Item) => t.k
  const groupOf = (t: Item) => t.g

  test("pure same: identical sequences → every row is `same` carrying both sides", () => {
    // Arrange
    const left: Array<Item> = [
      { k: "a", g: "x" },
      { k: "b", g: "y" },
    ]
    const right: Array<Item> = [
      { k: "a", g: "x" },
      { k: "b", g: "y" },
    ]

    // Act
    const rows = alignWithModified(left, right, keyOf, groupOf)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "same"])
    expect(rows[0].left).toEqual({ k: "a", g: "x" })
    expect(rows[0].right).toEqual({ k: "a", g: "x" })
  })

  test("pure added: right longer, new tail item → `added` row with only `right`", () => {
    // Arrange
    const left: Array<Item> = [{ k: "a", g: "x" }]
    const right: Array<Item> = [
      { k: "a", g: "x" },
      { k: "b", g: "y" },
    ]

    // Act
    const rows = alignWithModified(left, right, keyOf, groupOf)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "added"])
    const addedRow = rows[1]
    expect(addedRow.right).toEqual({ k: "b", g: "y" })
    expect(addedRow.left).toBeUndefined()
  })

  test("pure removed: left longer, dropped tail item → `removed` row with only `left`", () => {
    // Arrange
    const left: Array<Item> = [
      { k: "a", g: "x" },
      { k: "b", g: "y" },
    ]
    const right: Array<Item> = [{ k: "a", g: "x" }]

    // Act
    const rows = alignWithModified(left, right, keyOf, groupOf)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed"])
    const removedRow = rows[1]
    expect(removedRow.left).toEqual({ k: "b", g: "y" })
    expect(removedRow.right).toBeUndefined()
  })

  test("modified: adjacent removed→added run sharing `groupOf` pairs into `modified`", () => {
    // Arrange: same slot (group "x"), but different key → in-place change.
    const left: Array<Item> = [{ k: "old", g: "x" }]
    const right: Array<Item> = [{ k: "new", g: "x" }]

    // Act
    const rows = alignWithModified(left, right, keyOf, groupOf)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["modified"])
    expect(rows[0].left).toEqual({ k: "old", g: "x" })
    expect(rows[0].right).toEqual({ k: "new", g: "x" })
  })

  test("removed→added run with DIFFERENT groups stays remove+add (no spurious pairing)", () => {
    // Arrange: differing key AND group → must not be paired as modified.
    const left: Array<Item> = [{ k: "old", g: "x" }]
    const right: Array<Item> = [{ k: "new", g: "z" }]

    // Act
    const rows = alignWithModified(left, right, keyOf, groupOf)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["removed", "added"])
  })
})

// ── L1: diffMessageList ──

describe("diffMessageList", () => {
  test("same role, changed content → one `modified` row with non-empty textDiff", () => {
    // Arrange
    const left = [msg("user", "hello world")]
    const right = [msg("user", "hello there")]

    // Act
    const rows = diffMessageList(left, right)

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("modified")
    expect(rows[0].role).toBe("user")
    expect(rows[0].textDiff).toBeDefined()
    expect(rows[0].textDiff!.length).toBeGreaterThan(0)
    // The word diff carries the actual change.
    expect(rows[0].textDiff!.some((p) => p.removed && p.value.includes("world"))).toBe(true)
    expect(rows[0].textDiff!.some((p) => p.added && p.value.includes("there"))).toBe(true)
  })

  test("an added role surfaces as `added` (right-only), no textDiff", () => {
    // Arrange
    const left = [msg("user", "hi")]
    const right = [msg("user", "hi"), msg("assistant", "yo")]

    // Act
    const rows = diffMessageList(left, right)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "added"])
    const addedRow = rows[1]
    expect(addedRow.role).toBe("assistant")
    expect(addedRow.right).toEqual(msg("assistant", "yo"))
    expect(addedRow.left).toBeUndefined()
    expect(addedRow.textDiff).toBeUndefined()
  })

  test("a removed role surfaces as `removed` (left-only), no textDiff", () => {
    // Arrange
    const left = [msg("user", "hi"), msg("assistant", "bye")]
    const right = [msg("user", "hi")]

    // Act
    const rows = diffMessageList(left, right)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed"])
    const removedRow = rows[1]
    expect(removedRow.role).toBe("assistant")
    expect(removedRow.left).toEqual(msg("assistant", "bye"))
    expect(removedRow.right).toBeUndefined()
    expect(removedRow.textDiff).toBeUndefined()
  })

  test("array content is serialized for equality + diff", () => {
    // Arrange: same role, content blocks differ by one field.
    const left: Array<MessageContent> = [{ role: "assistant", content: [{ type: "text", text: "a" }] }]
    const right: Array<MessageContent> = [{ role: "assistant", content: [{ type: "text", text: "b" }] }]

    // Act
    const rows = diffMessageList(left, right)

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("modified")
    expect(rows[0].textDiff!.length).toBeGreaterThan(0)
  })

  test("an injective separator prevents role/content boundary key collisions", () => {
    // Arrange: `{role:"a b", content:"c"}` and `{role:"a", content:"b c"}` would
    // collide if the key joined role+content with a plain space ("a b c" both).
    // The NUL separator keeps the keys distinct, so these are two DISTINCT
    // messages — not a false `same`/`modified` pairing.
    const left = [msg("a b", "c")]
    const right = [msg("a", "b c")]

    // Act
    const rows = diffMessageList(left, right)

    // Assert: a real change (removed + added), never collapsed to one `same` row.
    expect(rows.map((r) => r.kind)).toEqual(["removed", "added"])
    expect(rows.some((r) => r.kind === "same")).toBe(false)
  })
})

// ── L4: diffSseFrames ──

describe("diffSseFrames", () => {
  test("same type, different raw → `modified` with non-empty rawDiff", () => {
    // Arrange: thinking-signature shim style in-place rewrite.
    const upstream = [frame("content_block_start", '{"signature":"A"}')]
    const forwarded = [frame("content_block_start", '{"signature":"B"}')]

    // Act
    const rows = diffSseFrames(upstream, forwarded)

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("modified")
    expect(rows[0].type).toBe("content_block_start")
    expect(rows[0].upstream).toEqual(upstream[0])
    expect(rows[0].forwarded).toEqual(forwarded[0])
    expect(rows[0].rawDiff).toBeDefined()
    expect(rows[0].rawDiff!.length).toBeGreaterThan(0)
    expect(rows[0].rawDiff!.some((p) => p.removed && p.value.includes("A"))).toBe(true)
    expect(rows[0].rawDiff!.some((p) => p.added && p.value.includes("B"))).toBe(true)
  })

  test("an upstream-only frame (filtered) → `removed`", () => {
    // Arrange
    const upstream = [frame("ping", "{}"), frame("filtered", "{}")]
    const forwarded = [frame("ping", "{}")]

    // Act
    const rows = diffSseFrames(upstream, forwarded)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed"])
    const removedRow = rows[1]
    expect(removedRow.type).toBe("filtered")
    expect(removedRow.upstream).toEqual(frame("filtered", "{}"))
    expect(removedRow.forwarded).toBeUndefined()
    expect(removedRow.rawDiff).toBeUndefined()
  })

  test("a forwarded-only frame (synthesized) → `added`", () => {
    // Arrange
    const upstream = [frame("ping", "{}")]
    const forwarded = [frame("ping", "{}"), frame("synthetic", "{}")]

    // Act
    const rows = diffSseFrames(upstream, forwarded)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "added"])
    const addedRow = rows[1]
    expect(addedRow.type).toBe("synthetic")
    expect(addedRow.forwarded).toEqual(frame("synthetic", "{}"))
    expect(addedRow.upstream).toBeUndefined()
    expect(addedRow.rawDiff).toBeUndefined()
  })
})

// ── Rich unified line+word diff: diffLinesRich ──

describe("diffLinesRich", () => {
  test("paired del→add: line-level rows + intra-line word highlights + correct gutter", () => {
    // Arrange: middle line changes a single word; surrounding lines unchanged.
    const a = "line one\nline two\nline three"
    const b = "line one\nline TWO\nline three"

    // Act
    const rows = diffLinesRich(a, b)

    // Assert: same / del / add / same in order.
    expect(rows.map((r) => r.kind)).toEqual(["same", "del", "add", "same"])

    const [same1, del, add, same2] = rows
    // First unchanged line: oldNo=1, newNo=1.
    expect(same1).toMatchObject({ kind: "same", text: "line one", oldNo: 1, newNo: 1 })
    // Removed side keeps the old line number, has no newNo.
    expect(del).toMatchObject({ kind: "del", text: "line two", oldNo: 2 })
    expect(del.newNo).toBeUndefined()
    // Added side keeps the new line number, has no oldNo.
    expect(add).toMatchObject({ kind: "add", text: "line TWO", newNo: 2 })
    expect(add.oldNo).toBeUndefined()
    // Trailing unchanged line continues numbering on both sides.
    expect(same2).toMatchObject({ kind: "same", text: "line three", oldNo: 3, newNo: 3 })

    // Intra-line word highlights: del carries the removed word, add the added one.
    expect(del.words).toBeDefined()
    expect(del.words!.some((p) => p.value.includes("two"))).toBe(true)
    expect(del.words!.every((p) => !p.added)).toBe(true)
    expect(add.words).toBeDefined()
    expect(add.words!.some((p) => p.value.includes("TWO"))).toBe(true)
    expect(add.words!.every((p) => !p.removed)).toBe(true)
  })

  test("pure addition: appended line → lone `add` with newNo and no oldNo/words", () => {
    // Arrange
    const a = "alpha"
    const b = "alpha\nbeta"

    // Act
    const rows = diffLinesRich(a, b)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "add"])
    expect(rows[0]).toMatchObject({ kind: "same", text: "alpha", oldNo: 1, newNo: 1 })
    expect(rows[1]).toMatchObject({ kind: "add", text: "beta", newNo: 2 })
    expect(rows[1].oldNo).toBeUndefined()
    expect(rows[1].words).toBeUndefined()
  })

  test("pure deletion: removed line → lone `del` with oldNo and no newNo/words", () => {
    // Arrange
    const a = "alpha\nbeta"
    const b = "alpha"

    // Act
    const rows = diffLinesRich(a, b)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "del"])
    expect(rows[0]).toMatchObject({ kind: "same", text: "alpha", oldNo: 1, newNo: 1 })
    expect(rows[1]).toMatchObject({ kind: "del", text: "beta", oldNo: 2 })
    expect(rows[1].newNo).toBeUndefined()
    expect(rows[1].words).toBeUndefined()
  })

  test("identical input: all `same` with parallel gutter numbering", () => {
    // Arrange
    const text = "one\ntwo\nthree"

    // Act
    const rows = diffLinesRich(text, text)

    // Assert
    expect(rows.map((r) => r.kind)).toEqual(["same", "same", "same"])
    expect(rows.map((r) => [r.oldNo, r.newNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })
})

// ── diffStats ──

describe("diffStats", () => {
  test("counts each AlignKind independently", () => {
    // Arrange
    const rows = [
      { kind: "same" as const },
      { kind: "same" as const },
      { kind: "added" as const },
      { kind: "removed" as const },
      { kind: "modified" as const },
      { kind: "modified" as const },
    ]

    // Act
    const stats = diffStats(rows)

    // Assert
    expect(stats).toEqual({ same: 2, added: 1, removed: 1, modified: 2 })
  })

  test("empty rows → all zero", () => {
    // Arrange / Act
    const stats = diffStats([])

    // Assert
    expect(stats).toEqual({ same: 0, added: 0, removed: 0, modified: 0 })
  })
})
