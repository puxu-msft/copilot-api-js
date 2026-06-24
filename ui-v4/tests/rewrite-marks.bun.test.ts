import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageContent } from "@/lib/content/types"

import { deriveRewriteMarks } from "@/lib/diff/rewrite-marks"

const msg = (role: string, content: string): MessageContent => ({ role, content })

describe("deriveRewriteMarks", () => {
  test("absent side → empty result", () => {
    expect(deriveRewriteMarks(undefined, [msg("user", "a")])).toEqual({})
    expect(deriveRewriteMarks([msg("user", "a")], undefined)).toEqual({})
  })

  test("identical lists → all marks undefined, index-aligned to message counts", () => {
    const m = [msg("user", "a"), msg("assistant", "b")]
    const { inboundMarks, effectiveMarks } = deriveRewriteMarks(m, m)
    expect(inboundMarks).toEqual([undefined, undefined])
    expect(effectiveMarks).toEqual([undefined, undefined])
  })

  test("same-role changed content → both legs marked `modified` at the same index", () => {
    const inbound = [msg("user", "hi"), msg("assistant", "old answer")]
    const effective = [msg("user", "hi"), msg("assistant", "new answer")]
    const { inboundMarks, effectiveMarks } = deriveRewriteMarks(inbound, effective)
    expect(inboundMarks).toEqual([undefined, "modified"])
    expect(effectiveMarks).toEqual([undefined, "modified"])
  })

  test("distinct-role drop + add → `removed` on inbound, `added` on effective, no misalignment", () => {
    // inbound has a `system` message effective lacks; effective has a `tool`
    // message inbound lacks → the aligner does NOT pair them (different roles),
    // so they surface as a real removed + added (not an in-place modified).
    const inbound = [msg("user", "a"), msg("assistant", "old"), msg("system", "gone")]
    const effective = [msg("user", "a"), msg("assistant", "new"), msg("tool", "added")]
    const { inboundMarks, effectiveMarks } = deriveRewriteMarks(inbound, effective)
    // rows: same(user) / modified(assistant) / removed(system) / added(tool)
    expect(inboundMarks).toEqual([undefined, "modified", "removed"])
    expect(effectiveMarks).toEqual([undefined, "modified", "added"])
    // each result aligns 1:1 with its leg's message count
    expect(inboundMarks?.length).toBe(inbound.length)
    expect(effectiveMarks?.length).toBe(effective.length)
  })

  test("pure addition (effective longer, distinct trailing role) marks only effective", () => {
    const inbound = [msg("user", "a")]
    const effective = [msg("user", "a"), msg("assistant", "extra")]
    const { inboundMarks, effectiveMarks } = deriveRewriteMarks(inbound, effective)
    expect(inboundMarks).toEqual([undefined])
    expect(effectiveMarks).toEqual([undefined, "added"])
  })

  test("pure removal (inbound longer, distinct trailing role) marks only inbound", () => {
    const inbound = [msg("user", "a"), msg("assistant", "gone")]
    const effective = [msg("user", "a")]
    const { inboundMarks, effectiveMarks } = deriveRewriteMarks(inbound, effective)
    expect(inboundMarks).toEqual([undefined, "removed"])
    expect(effectiveMarks).toEqual([undefined])
  })
})
