import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  formatDuration,
  formatNumber,
  formatTime,
  statusSignal,
} from "@/lib/format"

describe("format", () => {
  it("formatDuration ms→human", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(900)).toBe("900ms")
    expect(formatDuration(1200)).toBe("1.2s")
    expect(formatDuration(65_000)).toBe("1m5s")
  })

  it("statusSignal maps outcome to signal class", () => {
    expect(statusSignal("completed")).toBe("ok")
    expect(statusSignal("failed")).toBe("fail")
    expect(statusSignal("aborted")).toBe("fail")
    expect(statusSignal("streaming")).toBe("live")
    expect(statusSignal("rate_limited")).toBe("warn")
  })

  it("formatTime epoch ms → HH:MM:SS (local)", () => {
    const ts = new Date(2026, 0, 1, 9, 5, 3).getTime()
    expect(formatTime(ts)).toBe("09:05:03")
  })

  it("formatNumber compacts counts", () => {
    expect(formatNumber(undefined)).toBe("-")
    expect(formatNumber(null)).toBe("-")
    expect(formatNumber(250)).toBe("250")
    expect(formatNumber(1500)).toBe("1.5K")
    expect(formatNumber(2_400_000)).toBe("2.4M")
  })
})
