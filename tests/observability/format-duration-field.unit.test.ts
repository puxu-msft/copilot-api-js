import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  formatDurationField,
  resolveDurationColorMs,
} from "~/lib/observability/projections/format"

describe("formatDurationField", () => {
  it("retries=0 → 单值 total，与 formatDuration 一致（零回归）", () => {
    expect(formatDurationField({ lastMs: 45_200, totalMs: 621_900, retries: 0 })).toBe("621.9s")
    // lastMs 即便给了也忽略
    expect(formatDurationField({ lastMs: undefined, totalMs: 621_900, retries: 0 })).toBe("621.9s")
  })

  it("retries>=1 且 lastMs 有效 → last/total(N)", () => {
    expect(formatDurationField({ lastMs: 45_200, totalMs: 621_900, retries: 2 })).toBe("45.2s/621.9s(2)")
  })

  it("retries>=1 但 lastMs 无效（undefined/0/>total）→ 兜底 total(N)，不崩", () => {
    expect(formatDurationField({ lastMs: undefined, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
    expect(formatDurationField({ lastMs: 0, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
    expect(formatDurationField({ lastMs: 700_000, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
  })
})

describe("resolveDurationColorMs", () => {
  it("retries=0 → totalMs（着色零回归）", () => {
    expect(resolveDurationColorMs({ lastMs: 45_200, totalMs: 621_900, retries: 0 })).toBe(621_900)
  })

  it("retries>=1 且 lastMs 有效 → lastMs（按 last 着色）", () => {
    expect(resolveDurationColorMs({ lastMs: 45_200, totalMs: 621_900, retries: 2 })).toBe(45_200)
  })

  it("retries>=1 但 lastMs 无效 → totalMs 兜底", () => {
    expect(resolveDurationColorMs({ lastMs: undefined, totalMs: 621_900, retries: 2 })).toBe(621_900)
  })
})
