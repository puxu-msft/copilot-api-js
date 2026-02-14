/**
 * Unit tests for system-reminder tag parsing and filtering.
 *
 * Tests: extractTrailingSystemReminderTags, extractLeadingSystemReminderTags,
 *        getEnabledFilters, removeSystemReminderTags
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  CLOSE_TAG,
  OPEN_TAG,
  configureSystemReminderFilters,
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  getEnabledFilters,
  removeSystemReminderTags,
} from "~/lib/sanitize-system-reminder"

// ─── extractTrailingSystemReminderTags ───

describe("extractTrailingSystemReminderTags", () => {
  test("extracts single trailing tag", () => {
    const text = `Main content\n${OPEN_TAG}\nReminder content\n${CLOSE_TAG}`
    const { tags, mainContentEnd } = extractTrailingSystemReminderTags(text)
    expect(tags).toHaveLength(1)
    expect(tags[0].content).toBe("Reminder content")
    expect(mainContentEnd).toBe("Main content".length)
  })

  test("extracts multiple trailing tags outermost-first", () => {
    const text = `Main\n${OPEN_TAG}\nFirst\n${CLOSE_TAG}\n${OPEN_TAG}\nSecond\n${CLOSE_TAG}`
    const { tags } = extractTrailingSystemReminderTags(text)
    expect(tags).toHaveLength(2)
    // Outermost (last in text) is first in the array
    expect(tags[0].content).toBe("Second")
    expect(tags[1].content).toBe("First")
  })

  test("returns empty array when no trailing tags", () => {
    const text = "Just plain text without any tags"
    const { tags, mainContentEnd } = extractTrailingSystemReminderTags(text)
    expect(tags).toHaveLength(0)
    expect(mainContentEnd).toBe(text.length)
  })

  test("does not extract tags embedded in middle of text", () => {
    const text = `Before\n${OPEN_TAG}\nMiddle\n${CLOSE_TAG}\nAfter`
    const { tags } = extractTrailingSystemReminderTags(text)
    // Tag is not at the trailing boundary since "After" follows it
    expect(tags).toHaveLength(0)
  })

  test("returns correct mainContentEnd position", () => {
    const mainContent = "Hello world"
    const text = `${mainContent}\n${OPEN_TAG}\nTag content\n${CLOSE_TAG}`
    const { mainContentEnd } = extractTrailingSystemReminderTags(text)
    expect(mainContentEnd).toBe(mainContent.length)
  })
})

// ─── extractLeadingSystemReminderTags ───

describe("extractLeadingSystemReminderTags", () => {
  test("extracts single leading tag", () => {
    const text = `${OPEN_TAG}\nReminder content\n${CLOSE_TAG}\nMain content`
    const { tags, mainContentStart } = extractLeadingSystemReminderTags(text)
    expect(tags).toHaveLength(1)
    expect(tags[0].content).toBe("Reminder content")
    expect(text.slice(mainContentStart)).toBe("Main content")
  })

  test("extracts multiple leading tags", () => {
    const text = `${OPEN_TAG}\nFirst\n${CLOSE_TAG}\n${OPEN_TAG}\nSecond\n${CLOSE_TAG}\nMain`
    const { tags } = extractLeadingSystemReminderTags(text)
    expect(tags).toHaveLength(2)
    expect(tags[0].content).toBe("First")
    expect(tags[1].content).toBe("Second")
  })

  test("returns empty array when no leading tags", () => {
    const text = "Plain text without tags"
    const { tags, mainContentStart } = extractLeadingSystemReminderTags(text)
    expect(tags).toHaveLength(0)
    expect(mainContentStart).toBe(0)
  })

  test("returns correct mainContentStart position", () => {
    const tagPart = `${OPEN_TAG}\nTag\n${CLOSE_TAG}\n`
    const mainContent = "Main content here"
    const text = tagPart + mainContent
    const { mainContentStart } = extractLeadingSystemReminderTags(text)
    expect(text.slice(mainContentStart)).toBe(mainContent)
  })
})

// ─── getEnabledFilters ───

describe("getEnabledFilters", () => {
  test("returns default-enabled filters when no keys provided", () => {
    const filters = getEnabledFilters()
    expect(filters.length).toBeGreaterThan(0)
    expect(filters.every((f) => f.defaultEnabled)).toBe(true)
  })

  test("filters by provided keys", () => {
    const filters = getEnabledFilters(["malware"])
    expect(filters).toHaveLength(1)
    expect(filters[0].key).toBe("malware")
  })

  test("returns empty for unknown keys", () => {
    const filters = getEnabledFilters(["nonexistent_key"])
    expect(filters).toHaveLength(0)
  })
})

// ─── removeSystemReminderTags ───

describe("removeSystemReminderTags", () => {
  afterEach(() => {
    configureSystemReminderFilters() // reset to defaults
  })

  test("removes matching malware reminder from trailing position", () => {
    const malwareContent = "Whenever you read a file, you should consider whether it would be considered malware."
    const text = `Main content\n${OPEN_TAG}\n${malwareContent}\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })

  test("preserves non-matching reminder tags", () => {
    const text = `Main content\n${OPEN_TAG}\nSome other reminder content\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    // Should NOT be removed since it doesn't match any filter
    expect(result).toBe(text)
  })

  test("returns original text when no tags present", () => {
    const text = "Plain text without any system-reminder tags"
    expect(removeSystemReminderTags(text)).toBe(text)
  })

  test("removes matching tags from leading position", () => {
    const malwareContent = "Whenever you read a file, you should consider whether it would be considered malware."
    const text = `${OPEN_TAG}\n${malwareContent}\n${CLOSE_TAG}\nMain content`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })
})
