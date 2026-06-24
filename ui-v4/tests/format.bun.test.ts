import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  formatBytes,
  formatDuration,
  formatElapsed,
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

  it("formatElapsed always renders +<seconds>s, never minutes", () => {
    expect(formatElapsed(0)).toBe("+0.0s")
    expect(formatElapsed(1200)).toBe("+1.2s")
    expect(formatElapsed(123_400)).toBe("+123.4s")
    expect(formatElapsed(90_000)).toBe("+90.0s")
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

  it("formatBytes compacts sizes with B/KB/MB suffix", () => {
    expect(formatBytes(undefined)).toBe("")
    expect(formatBytes(0)).toBe("0B")
    expect(formatBytes(900)).toBe("900B")
    expect(formatBytes(1023)).toBe("1023B")
    expect(formatBytes(1024)).toBe("1.0KB")
    expect(formatBytes(1536)).toBe("1.5KB")
    expect(formatBytes(1_048_575)).toBe("1024.0KB")
    expect(formatBytes(1_048_576)).toBe("1.0MB")
    expect(formatBytes(2_516_582)).toBe("2.4MB")
  })
})
