/**
 * Unit tests for the generalized per-frame synthetic-origin tag (`src/lib/pipeline/frame-origin.ts`)
 * and its hook-rewrite back-compat wrappers (`hooks/origin.ts`). The tag is record-layer metadata the
 * sink reads to mark `SseEventRecord.synthetic` on the forwarded track (richest-data-flow §3).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  readSyntheticKind,
  tagFrameSynthetic,
} from "~/lib/pipeline/frame-origin"
import {
  //
  tagFrameRewritten,
  wasFrameRewritten,
} from "~/lib/pipeline/hooks/origin"

describe("frame synthetic-origin tag", () => {
  test("round-trips a kind", () => {
    const f = tagFrameSynthetic({ data: "x" }, "refusal-recovery")
    expect(readSyntheticKind(f)).toBe("refusal-recovery")
  })

  test("round-trips hook-rewrite kind", () => {
    const f = tagFrameSynthetic({ data: "x" }, "hook-rewrite")
    expect(readSyntheticKind(f)).toBe("hook-rewrite")
  })

  test("an untagged frame reads undefined (a genuine real frame)", () => {
    expect(readSyntheticKind({ data: "x" })).toBeUndefined()
  })

  test("mutates + returns the SAME object (own Symbol key, invisible to JSON/toEqual on data)", () => {
    const frame = { event: "error", data: "y" }
    const tagged = tagFrameSynthetic(frame, "refusal-recovery")
    expect(tagged).toBe(frame)
    // the tag does not alter the wire-visible fields
    expect(tagged.event).toBe("error")
    expect(tagged.data).toBe("y")
  })

  test("the tag rides along an object spread (survives {...frame} reconstruction)", () => {
    const f = tagFrameSynthetic({ data: "x" }, "refusal-recovery")
    const spread = { ...f, data: "z" }
    expect(readSyntheticKind(spread)).toBe("refusal-recovery")
  })
})

describe("hook-rewrite back-compat wrappers", () => {
  test("tagFrameRewritten + wasFrameRewritten still work via the generalized primitive", () => {
    const f = tagFrameRewritten({ data: "x" })
    expect(wasFrameRewritten(f)).toBe(true)
    expect(readSyntheticKind(f)).toBe("hook-rewrite")
  })

  test("a refusal-recovery frame is NOT read as hook-rewritten", () => {
    const f = tagFrameSynthetic({ data: "x" }, "refusal-recovery")
    expect(wasFrameRewritten(f)).toBe(false)
  })

  test("an untagged frame is not hook-rewritten", () => {
    expect(wasFrameRewritten({ data: "x" })).toBe(false)
  })
})
