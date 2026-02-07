/**
 * Unit tests for truncation marker formatting.
 *
 * Split from: characterization/shared-utils.test.ts
 * Tests: createTruncationMarker
 */

import { describe, expect, test } from "bun:test"

import { type TruncateResultInfo, createTruncationMarker } from "~/routes/shared"

describe("createTruncationMarker", () => {
  test("returns empty string when wasCompacted is false", () => {
    const result: TruncateResultInfo = { wasCompacted: false }
    expect(createTruncationMarker(result)).toBe("")
  })

  test("returns generic marker when details are missing", () => {
    const result: TruncateResultInfo = { wasCompacted: true }
    const marker = createTruncationMarker(result)
    expect(marker).toContain("Auto-truncated")
    expect(marker).toContain("---")
  })

  test("returns detailed marker with all fields", () => {
    const result: TruncateResultInfo = {
      wasCompacted: true,
      originalTokens: 10000,
      compactedTokens: 5000,
      removedMessageCount: 3,
    }
    const marker = createTruncationMarker(result)
    expect(marker).toContain("3 messages removed")
    expect(marker).toContain("10000")
    expect(marker).toContain("5000")
    expect(marker).toContain("50%")
  })

  test("calculates reduction percentage correctly", () => {
    const result: TruncateResultInfo = {
      wasCompacted: true,
      originalTokens: 200,
      compactedTokens: 150,
      removedMessageCount: 1,
    }
    const marker = createTruncationMarker(result)
    // (200-150)/200 = 25%
    expect(marker).toContain("25%")
  })

  test("marker starts with newlines and separator", () => {
    const result: TruncateResultInfo = {
      wasCompacted: true,
      originalTokens: 100,
      compactedTokens: 50,
      removedMessageCount: 2,
    }
    const marker = createTruncationMarker(result)
    expect(marker.startsWith("\n\n---\n")).toBe(true)
  })
})
