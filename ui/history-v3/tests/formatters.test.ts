/**
 * Tests for useFormatters composable — pure formatting functions.
 *
 * Covers: escapeHtml, highlightSearch, formatNumber, formatDuration, formatTime, formatDate
 */

import { describe, expect, test } from "bun:test"

// Import the composable — Vue reactivity works in plain Bun tests
import { useFormatters } from "../src/composables/useFormatters"

const { escapeHtml, highlightSearch, formatNumber, formatDuration, formatTime, formatDate } = useFormatters()

// ─── escapeHtml ───

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B")
  })

  test("escapes angle brackets", () => {
    expect(escapeHtml("<div>hello</div>")).toBe("&lt;div&gt;hello&lt;/div&gt;")
  })

  test("escapes double quotes", () => {
    expect(escapeHtml('key="value"')).toBe("key=&quot;value&quot;")
  })

  test("escapes all special characters together", () => {
    expect(escapeHtml('<a href="url">A & B</a>')).toBe("&lt;a href=&quot;url&quot;&gt;A &amp; B&lt;/a&gt;")
  })

  test("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("")
  })

  test("returns plain text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123")
  })

  test("preserves newlines and whitespace", () => {
    expect(escapeHtml("line1\nline2\ttab")).toBe("line1\nline2\ttab")
  })

  test("handles text with XML/HTML-like content from LLM responses", () => {
    const input = "<system-reminder>Use the <tool> tag for tool calls</system-reminder>"
    const result = escapeHtml(input)
    expect(result).toContain("&lt;system-reminder&gt;")
    expect(result).toContain("&lt;tool&gt;")
    expect(result).not.toContain("<system-reminder>")
  })

  test("handles markdown code blocks with angle brackets", () => {
    const input = "```typescript\nconst x: Array<string> = []\n```"
    const result = escapeHtml(input)
    expect(result).toContain("Array&lt;string&gt;")
  })
})

// ─── highlightSearch ───

describe("highlightSearch", () => {
  test("wraps matching text in mark tag", () => {
    const result = highlightSearch("hello world", "world")
    expect(result).toContain('<mark class="search-highlight">world</mark>')
  })

  test("is case-insensitive", () => {
    const result = highlightSearch("Hello World", "hello")
    expect(result).toContain('<mark class="search-highlight">Hello</mark>')
  })

  test("highlights all occurrences", () => {
    const result = highlightSearch("foo bar foo baz foo", "foo")
    const matches = result.match(/<mark class="search-highlight">/g)
    expect(matches).toHaveLength(3)
  })

  test("escapes HTML in non-matching text", () => {
    const result = highlightSearch("<div>hello</div>", "hello")
    expect(result).toContain("&lt;div&gt;")
    expect(result).toContain('<mark class="search-highlight">hello</mark>')
    expect(result).toContain("&lt;/div&gt;")
  })

  test("escapes HTML in matching text too", () => {
    // Searching for a string that contains HTML chars
    const result = highlightSearch("A & B and C & D", "& B")
    expect(result).toContain('<mark class="search-highlight">&amp; B</mark>')
  })

  test("returns escaped text when query is empty", () => {
    const result = highlightSearch("<b>bold</b>", "")
    expect(result).toBe("&lt;b&gt;bold&lt;/b&gt;")
  })

  test("handles regex special characters in query", () => {
    const result = highlightSearch("price is $100 (USD)", "$100")
    expect(result).toContain('<mark class="search-highlight">$100</mark>')
  })

  test("handles parentheses in query", () => {
    const result = highlightSearch("call foo(bar)", "foo(bar)")
    expect(result).toContain('<mark class="search-highlight">foo(bar)</mark>')
  })

  test("handles dot in query", () => {
    const result = highlightSearch("file.txt and file2txt", "file.txt")
    expect(result).toContain('<mark class="search-highlight">file.txt</mark>')
    // "file2txt" should NOT match because dot is escaped (not treated as regex wildcard)
    expect(result).not.toContain("file2txt</mark>")
  })

  test("preserves newlines", () => {
    const result = highlightSearch("line1\nline2", "line1")
    expect(result).toContain('<mark class="search-highlight">line1</mark>')
    expect(result).toContain("\n")
  })

  test("handles multiline content with tags", () => {
    const input = "Use <tool_use> block\nWith <result> tag"
    const result = highlightSearch(input, "tool_use")
    expect(result).toContain('<mark class="search-highlight">tool_use</mark>')
    expect(result).toContain("&lt;")
  })
})

// ─── formatNumber ───

describe("formatNumber", () => {
  test("returns dash for undefined", () => {
    expect(formatNumber(undefined)).toBe("-")
  })

  test("returns dash for null", () => {
    expect(formatNumber(null as unknown as undefined)).toBe("-")
  })

  test("returns number as string for small values", () => {
    expect(formatNumber(42)).toBe("42")
    expect(formatNumber(999)).toBe("999")
  })

  test("formats thousands with K suffix", () => {
    expect(formatNumber(1000)).toBe("1.0K")
    expect(formatNumber(1500)).toBe("1.5K")
    expect(formatNumber(15000)).toBe("15.0K")
    expect(formatNumber(999999)).toBe("1000.0K")
  })

  test("formats millions with M suffix", () => {
    expect(formatNumber(1000000)).toBe("1.0M")
    expect(formatNumber(2500000)).toBe("2.5M")
  })

  test("returns 0 for zero", () => {
    expect(formatNumber(0)).toBe("0")
  })
})

// ─── formatDuration ───

describe("formatDuration", () => {
  test("returns dash for undefined", () => {
    expect(formatDuration(undefined)).toBe("-")
  })

  test("returns dash for zero", () => {
    expect(formatDuration(0)).toBe("-")
  })

  test("formats milliseconds for values under 1000", () => {
    expect(formatDuration(50)).toBe("50ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  test("formats seconds for values >= 1000", () => {
    expect(formatDuration(1000)).toBe("1.0s")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(12345)).toBe("12.3s")
  })
})

// ─── formatTime ───

describe("formatTime", () => {
  test("formats timestamp as HH:MM:SS", () => {
    // Create a known timestamp
    const date = new Date(2024, 0, 15, 14, 30, 45) // Jan 15, 2024, 14:30:45
    const result = formatTime(date.getTime())
    expect(result).toBe("14:30:45")
  })

  test("pads single-digit hours/minutes/seconds", () => {
    const date = new Date(2024, 0, 1, 9, 5, 3) // 09:05:03
    const result = formatTime(date.getTime())
    expect(result).toBe("09:05:03")
  })
})

// ─── formatDate ───

describe("formatDate", () => {
  test("formats today's timestamp as time only", () => {
    const now = new Date()
    now.setHours(14, 30, 45)
    const result = formatDate(now.getTime())
    expect(result).toBe("14:30:45")
  })

  test("formats older timestamp with full date", () => {
    const old = new Date(2023, 5, 15, 14, 30, 45) // Jun 15, 2023
    const result = formatDate(old.getTime())
    expect(result).toContain("2023")
    expect(result).toContain("14:30:45")
  })
})
