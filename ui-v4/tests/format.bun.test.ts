import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  formatDuration,
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
})
