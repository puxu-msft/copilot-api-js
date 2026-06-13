/**
 * Anti-drift guard for the status presentation single-source (status-meta.ts).
 *
 * The old aborted/interrupted "degrade to pending" bug existed because color/
 * icon lived in parallel if-chains and a new state silently fell through to the
 * fallback. These tests + the `satisfies Record<RequestLifecycleState,…>` in
 * status-meta.ts ensure every lifecycle state has a DISTINCT, non-fallback
 * presentation, so adding a state without configuring it fails loudly.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  LIFECYCLE_STATES,
  STATUS_META,
  statusMeta,
} from "@/utils/status-meta"

describe("status-meta single source", () => {
  test("covers all 7 lifecycle states", () => {
    expect(LIFECYCLE_STATES.sort()).toEqual(["aborted", "completed", "executing", "failed", "interrupted", "pending", "streaming"])
  })

  test("aborted / interrupted have their OWN color (regression: they used to degrade to pending/secondary)", () => {
    expect(statusMeta("aborted").color).toBe("aborted")
    expect(statusMeta("interrupted").color).toBe("interrupted")
    // Distinct from each other, from pending, and from failed.
    const distinct = new Set([statusMeta("aborted").color, statusMeta("interrupted").color, statusMeta("pending").color, statusMeta("failed").color])
    expect(distinct.size).toBe(4)
  })

  test("every state has a non-empty distinct icon", () => {
    const icons = LIFECYCLE_STATES.map((s) => STATUS_META[s].icon)
    expect(icons.every((i) => i.startsWith("mdi-"))).toBe(true)
    expect(new Set(icons).size).toBe(icons.length)
  })

  test("active vs terminal classification", () => {
    const active = LIFECYCLE_STATES.filter((s) => STATUS_META[s].active)
    const terminal = LIFECYCLE_STATES.filter((s) => !STATUS_META[s].active)
    expect(active.sort()).toEqual(["executing", "pending", "streaming"])
    expect(terminal.sort()).toEqual(["aborted", "completed", "failed", "interrupted"])
  })

  test("unknown / undefined state falls back to pending (defensive)", () => {
    expect(statusMeta(undefined)).toBe(STATUS_META.pending)
    expect(statusMeta("bogus")).toBe(STATUS_META.pending)
  })
})
