import { describe, expect, mock, test } from "bun:test"

import type { TuiLogEntry } from "~/lib/tui/types"

// ─── Force picocolors to always emit ANSI codes ───
// In non-TTY environments (test runners), picocolors is a no-op (all functions
// return input unchanged). This makes color assertions meaningless — e.g.
// `pc.dim(x) === x`, so `result.toContain(pc.dim("+200"))` only checks text
// presence, not color. We mock picocolors to always emit real ANSI codes so
// that strip() actually strips, and color assertions actually verify colors.
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is synchronous in Bun test runtime
mock.module("picocolors", () => {
  const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`
  return {
    default: {
      cyan: wrap(36, 39),
      dim: wrap(2, 22),
    },
  }
})

// Must import AFTER mock.module (Bun auto-hoists mock.module above imports)
import pc from "picocolors"

import { formatBytes, formatDuration, formatNumber, formatStreamInfo, formatTime, formatTokens } from "~/lib/tui/format"

/** Strip ANSI escape codes to get plain text content */
// eslint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
const strip = (s: string) => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

// =============================================================================
// formatTime
// =============================================================================

describe("formatTime", () => {
  test("formats hours, minutes, seconds with zero-padding", () => {
    expect(formatTime(new Date(2024, 0, 1, 9, 5, 3))).toBe("09:05:03")
  })

  test("formats double-digit values", () => {
    expect(formatTime(new Date(2024, 0, 1, 14, 23, 45))).toBe("14:23:45")
  })

  test("handles midnight", () => {
    expect(formatTime(new Date(2024, 0, 1, 0, 0, 0))).toBe("00:00:00")
  })
})

// =============================================================================
// formatDuration
// =============================================================================

describe("formatDuration", () => {
  test("shows milliseconds for values under 1000", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("shows seconds with one decimal for values >= 1000", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(12345)).toBe("12.3s")
  })
})

// =============================================================================
// formatNumber
// =============================================================================

describe("formatNumber", () => {
  test("returns raw number for values under 1000", () => {
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(42)).toBe("42")
    expect(formatNumber(999)).toBe("999")
  })

  test("formats thousands with K suffix", () => {
    expect(formatNumber(1000)).toBe("1.0K")
    expect(formatNumber(1500)).toBe("1.5K")
    expect(formatNumber(999999)).toBe("1000.0K")
  })

  test("formats millions with M suffix", () => {
    expect(formatNumber(1000000)).toBe("1.0M")
    expect(formatNumber(2500000)).toBe("2.5M")
  })
})

// =============================================================================
// formatBytes
// =============================================================================

describe("formatBytes", () => {
  test("returns raw bytes for values under 1KB", () => {
    expect(formatBytes(0)).toBe("0B")
    expect(formatBytes(512)).toBe("512B")
    expect(formatBytes(1023)).toBe("1023B")
  })

  test("formats kilobytes with KB suffix", () => {
    expect(formatBytes(1024)).toBe("1.0KB")
    expect(formatBytes(1536)).toBe("1.5KB")
    expect(formatBytes(45678)).toBe("44.6KB")
  })

  test("formats megabytes with MB suffix", () => {
    expect(formatBytes(1048576)).toBe("1.0MB")
    expect(formatBytes(2621440)).toBe("2.5MB")
  })
})

// =============================================================================
// formatStreamInfo
// =============================================================================

describe("formatStreamInfo", () => {
  const base: TuiLogEntry = {
    id: "test",
    method: "POST",
    path: "/v1/messages",
    startTime: Date.now(),
    status: "streaming",
  }

  test("returns empty string when no stream bytes", () => {
    expect(formatStreamInfo(base)).toBe("")
  })

  test("formats bytes and events", () => {
    expect(formatStreamInfo({ ...base, streamBytesIn: 12600, streamEventsIn: 42 })).toBe(" ↓12.3KB 42ev")
  })

  test("includes block type when present", () => {
    expect(formatStreamInfo({ ...base, streamBytesIn: 1024, streamEventsIn: 10, streamBlockType: "thinking" })).toBe(
      " ↓1.0KB 10ev [thinking]",
    )
  })

  test("defaults events to 0 when undefined", () => {
    expect(formatStreamInfo({ ...base, streamBytesIn: 512 })).toBe(" ↓512B 0ev")
  })
})

// =============================================================================
// formatTokens
// =============================================================================

describe("formatTokens", () => {
  // Sanity check: mock is active and strip() actually strips something
  test("mock is active — pc.cyan produces ANSI codes", () => {
    const colored = pc.cyan("test")
    expect(colored).not.toBe("test")
    expect(strip(colored)).toBe("test")
  })

  test("returns dash when both input and output are undefined", () => {
    expect(formatTokens()).toBe("-")
    expect(formatTokens(undefined, undefined)).toBe("-")
  })

  test("formats basic input/output with arrows", () => {
    expect(strip(formatTokens(1500, 500))).toBe("↑1.5K ↓500")
  })

  test("formats with cache read tokens", () => {
    expect(strip(formatTokens(12500, 1200, 300))).toBe("↑12.5K+300 ↓1.2K")
  })

  test("formats with cache creation tokens", () => {
    expect(strip(formatTokens(12500, 1200, undefined, 5000))).toBe("↑12.5K+5.0K ↓1.2K")
  })

  test("formats with both cache read and creation", () => {
    expect(strip(formatTokens(12500, 1200, 300, 5000))).toBe("↑12.5K+300+5.0K ↓1.2K")
  })

  test("defaults to 0 when input or output is undefined", () => {
    expect(strip(formatTokens(undefined, 500))).toBe("↑0 ↓500")
    expect(strip(formatTokens(1000, undefined))).toBe("↑1.0K ↓0")
  })

  // ─── Color assertions (verified by mock) ───

  test("input/output tokens have no ANSI color codes", () => {
    const result = formatTokens(1000, 500)
    // With mock active, if pc.cyan were used, result would contain ANSI codes
    // and would NOT equal its stripped form. This verifies no color wrapping.
    expect(result).toBe(strip(result))
    expect(result).toBe("↑1.0K ↓500")
  })

  test("cache read uses dim (not cyan)", () => {
    const result = formatTokens(1000, 500, 200)
    expect(result).toContain(pc.dim("+200"))
    // Verify it's actually dim, not cyan
    expect(result).not.toContain(pc.cyan("+200"))
  })

  test("cache creation uses cyan (not dim)", () => {
    const result = formatTokens(1000, 500, undefined, 300)
    expect(result).toContain(pc.cyan("+300"))
    // Verify it's actually cyan, not dim
    expect(result).not.toContain(pc.dim("+300"))
  })

  test("cache read and creation use different colors", () => {
    const result = formatTokens(1000, 500, 200, 300)
    // cache read = dim
    expect(result).toContain(pc.dim("+200"))
    expect(result).not.toContain(pc.cyan("+200"))
    // cache creation = cyan
    expect(result).toContain(pc.cyan("+300"))
    expect(result).not.toContain(pc.dim("+300"))
  })
})
