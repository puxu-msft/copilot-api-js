import { describe, expect, test } from "bun:test"

import {
  categoryTtlMs,
  entryExpiresAt,
  entryStatus,
  isEntryActive,
  type LearnedEntryMeta,
  NEGOTIATION_CATEGORIES,
} from "~/lib/anthropic/negotiation-lifecycle"

const DAY = 86_400_000
function meta(over: Partial<LearnedEntryMeta> = {}): LearnedEntryMeta {
  return { firstLearnedAt: 0, lastConfirmedAt: 0, ...over }
}

describe("negotiation-lifecycle", () => {
  test("NEGOTIATION_CATEGORIES has all 10", () => {
    expect(NEGOTIATION_CATEGORIES.length).toBe(10)
    expect(new Set(NEGOTIATION_CATEGORIES).size).toBe(10)
  })

  test("default TTL is 30d for an unconfigured category", () => {
    expect(categoryTtlMs("features")).toBe(30 * DAY)
  })

  test("active within TTL, expired past it", () => {
    const m = meta({ lastConfirmedAt: 0 })
    expect(isEntryActive(m, "features", 29 * DAY)).toBe(true)
    expect(isEntryActive(m, "features", 31 * DAY)).toBe(false)
  })

  test("pinned is always active + status pinned + no expiry", () => {
    const m = meta({ pinned: true, lastConfirmedAt: 0 })
    expect(isEntryActive(m, "features", 999 * DAY)).toBe(true)
    expect(entryStatus(m, "features", 999 * DAY)).toBe("pinned")
    expect(entryExpiresAt(m, "features")).toBeNull()
  })

  test("manuallyExpired is dead + status manually_expired (pin overrides)", () => {
    expect(isEntryActive(meta({ manuallyExpired: true }), "features", 0)).toBe(false)
    expect(entryStatus(meta({ manuallyExpired: true }), "features", 0)).toBe("manually_expired")
    // pin wins over manuallyExpired
    expect(isEntryActive(meta({ manuallyExpired: true, pinned: true }), "features", 0)).toBe(true)
  })

  test("entryStatus active vs expired by time", () => {
    expect(entryStatus(meta(), "features", 10 * DAY)).toBe("active")
    expect(entryStatus(meta(), "features", 40 * DAY)).toBe("expired")
  })
})
