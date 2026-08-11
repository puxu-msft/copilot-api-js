import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

describe("hasDeliveredSemanticContent", () => {
  test("returns false when no session exists before a candidate is ready", () => {
    expect(hasDeliveredSemanticContent(undefined)).toBe(false)
  })

  test("returns false when a ready session has not emitted a real content delta", () => {
    expect(hasDeliveredSemanticContent({ hasEmittedRealClientContent: false })).toBe(false)
  })

  test("returns true after a real content delta even when content_block_stop has not arrived", () => {
    const session = {
      hasEmittedRealClientContent: true,
      boundary: { result: null },
    }

    expect(hasDeliveredSemanticContent(session)).toBe(true)
  })

  test("returns false when only content_block_start has been emitted", () => {
    expect(hasDeliveredSemanticContent({ hasEmittedRealClientContent: false })).toBe(false)
  })
})
