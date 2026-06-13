import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessageContent,
  SseEventRecord,
} from "@/types"

import {
  //
  diffLinesRich,
  diffMessageList,
  diffSseFrames,
  diffStats,
  diffText,
} from "@/utils/block-diff"

function msg(role: string, content: string): MessageContent {
  return { role, content }
}
function frame(offsetMs: number, type: string, raw: string): SseEventRecord {
  return { offsetMs, type, raw }
}

describe("block-diff L3 (jsdiff leaf)", () => {
  test("word-level inline diff marks added/removed runs", () => {
    const parts = diffText("the quick brown fox", "the slow brown fox")
    const removed = parts.filter((p) => p.removed).map((p) => p.value.trim())
    const added = parts.filter((p) => p.added).map((p) => p.value.trim())
    expect(removed).toContain("quick")
    expect(added).toContain("slow")
    // unchanged words preserved
    expect(parts.some((p) => !p.added && !p.removed && p.value.includes("brown"))).toBe(true)
  })
})

describe("block-diff L1 (message list — attempt/rewrite axis)", () => {
  test("identical lists → all same", () => {
    const a = [msg("user", "hi"), msg("assistant", "yo")]
    const rows = diffMessageList(a, a)
    expect(rows.every((r) => r.kind === "same")).toBe(true)
  })

  test("truncation: a middle message removed is detected as removed (not modified-cascade)", () => {
    const left = [msg("user", "m1"), msg("user", "m2"), msg("user", "m3")]
    const right = [msg("user", "m1"), msg("user", "m3")]
    const rows = diffMessageList(left, right)
    expect(diffStats(rows)).toMatchObject({ removed: 1, same: 2, added: 0, modified: 0 })
    expect(rows.find((r) => r.kind === "removed")?.left?.content).toBe("m2")
  })

  test("same-role in-place change → modified with inline textDiff", () => {
    const left = [msg("user", "hello world")]
    const right = [msg("user", "hello there")]
    const rows = diffMessageList(left, right)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("modified")
    expect(rows[0].textDiff?.some((p) => p.removed && p.value.includes("world"))).toBe(true)
    expect(rows[0].textDiff?.some((p) => p.added && p.value.includes("there"))).toBe(true)
  })

  test("appended message → added", () => {
    const rows = diffMessageList([msg("user", "a")], [msg("user", "a"), msg("assistant", "b")])
    expect(diffStats(rows)).toMatchObject({ same: 1, added: 1 })
  })
})

describe("diffLinesRich (unified line+word diff for the modal)", () => {
  test("line numbers track old/new sides; same lines carry both", () => {
    const rows = diffLinesRich("a\nb\nc", "a\nB\nc")
    expect(rows.find((r) => r.text === "a")).toMatchObject({ kind: "same", oldNo: 1, newNo: 1 })
    const del = rows.find((r) => r.kind === "del")
    const add = rows.find((r) => r.kind === "add")
    expect(del?.oldNo).toBe(2)
    expect(del?.newNo).toBeUndefined()
    expect(add?.newNo).toBe(2)
    expect(add?.oldNo).toBeUndefined()
  })

  test("changed line carries word-level highlights (del=non-added, add=non-removed)", () => {
    const rows = diffLinesRich("the quick fox", "the slow fox")
    const del = rows.find((r) => r.kind === "del")
    const add = rows.find((r) => r.kind === "add")
    expect(del?.words?.some((p) => p.removed && p.value.includes("quick"))).toBe(true)
    expect(del?.words?.some((p) => p.added)).toBe(false)
    expect(add?.words?.some((p) => p.added && p.value.includes("slow"))).toBe(true)
    expect(add?.words?.some((p) => p.removed)).toBe(false)
  })
})

describe("block-diff L4 (SSE frame diff — upstream vs forwarded)", () => {
  test("a dropped (filtered) frame is detected", () => {
    const upstream = [frame(0, "message_start", "{}"), frame(5, "server_tool_use", "{x}"), frame(9, "message_stop", "{}")]
    const forwarded = [frame(0, "message_start", "{}"), frame(9, "message_stop", "{}")]
    const rows = diffSseFrames(upstream, forwarded)
    const dropped = rows.filter((r) => r.kind === "removed")
    expect(dropped).toHaveLength(1)
    expect(dropped[0].upstream?.type).toBe("server_tool_use")
  })

  test("a rewritten frame (same type, changed raw) → modified with rawDiff", () => {
    const upstream = [frame(0, "content_block_start", '{"signature":""}')]
    const forwarded = [frame(0, "content_block_start", '{"signature":"abc"}')]
    const rows = diffSseFrames(upstream, forwarded)
    expect(rows[0].kind).toBe("modified")
    expect(rows[0].rawDiff?.some((p) => p.added && p.value.includes("abc"))).toBe(true)
  })

  test("identical streams → all same", () => {
    const f = [frame(0, "a", "1"), frame(1, "b", "2")]
    expect(diffSseFrames(f, f).every((r) => r.kind === "same")).toBe(true)
  })

  test("frames compared by VERBATIM raw bytes (contract): byte-identical JSON → same; re-serialized key order → modified", () => {
    // `raw` is the verbatim upstream `data:` payload (types.ts), so equality is
    // byte-based. Same bytes → same, even though the bytes are JSON.
    const same = diffSseFrames([frame(0, "delta", '{"a":1,"b":2}')], [frame(0, "delta", '{"a":1,"b":2}')])
    expect(same[0].kind).toBe("same")
    // If a forwarding path re-stringifies with a different key order, the bytes
    // differ → surfaced as `modified` (correct: a real wire-level change to flag).
    const reordered = diffSseFrames([frame(0, "delta", '{"a":1,"b":2}')], [frame(0, "delta", '{"b":2,"a":1}')])
    expect(reordered[0].kind).toBe("modified")
  })
})
