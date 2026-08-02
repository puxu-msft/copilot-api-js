import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { resolveRefusalDetail } from "~/lib/history/entry-view"

function entryWith(stopDetails: unknown) {
  return {
    attempts: [
      {
        upstreamResponse: {
          success: true,
          stopReason: "refusal",
          stopDetails,
        },
      },
    ],
  } as never
}

describe("resolveRefusalDetail", () => {
  test("preserves named, explicitly uncategorized, and missing category provenance", () => {
    expect(resolveRefusalDetail(entryWith({ category: "cyber", explanation: "A complete diagnostic explanation." }))).toEqual({
      category: "cyber",
      categoryProvenance: "named",
      explanation: "A complete diagnostic explanation.",
      invalid: false,
    })
    expect(resolveRefusalDetail(entryWith({ category: null, explanation: "No named category matched." }))).toEqual({
      category: "uncategorized",
      categoryProvenance: "uncategorized",
      explanation: "No named category matched.",
      invalid: false,
    })
    expect(resolveRefusalDetail(entryWith({ explanation: "Legacy upstream omitted category." }))).toEqual({
      category: "unknown",
      categoryProvenance: "unknown",
      explanation: "Legacy upstream omitted category.",
      invalid: false,
    })
  })

  test("reads only the final upstream response and surfaces malformed details", () => {
    const entry = {
      attempts: [
        { upstreamResponse: { success: true, stopDetails: { category: "old", explanation: "old" } } },
        { upstreamResponse: { success: true, stopDetails: { category: 42, explanation: ["bad"] } } },
      ],
    } as never

    expect(resolveRefusalDetail(entry)).toEqual({
      category: "unknown",
      categoryProvenance: "unknown",
      explanation: undefined,
      invalid: true,
    })
  })

  test("returns undefined only when raw stopDetails are absent", () => {
    expect(resolveRefusalDetail({ attempts: [] } as never)).toBeUndefined()
    expect(resolveRefusalDetail(entryWith(undefined))).toBeUndefined()
    expect(resolveRefusalDetail(entryWith(null))).toBeUndefined()
  })
})
