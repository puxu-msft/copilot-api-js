/**
 * Unit tests for system-reminder tag parsing and rewriting.
 *
 * Tests: extractTrailingSystemReminderTags, extractLeadingSystemReminderTags,
 *        removeSystemReminderTags (with state.rewriteSystemReminders modes)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  CLOSE_TAG,
  OPEN_TAG,
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  removeSystemReminderTags,
} from "~/lib/sanitize-system-reminder"
import { state, setStateForTests } from "~/lib/state"

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

// ─── removeSystemReminderTags ───

describe("removeSystemReminderTags", () => {
  let originalRewrite: typeof state.rewriteSystemReminders

  beforeEach(() => {
    originalRewrite = state.rewriteSystemReminders
  })

  afterEach(() => {
    setStateForTests({ rewriteSystemReminders: originalRewrite })
  })

  // --- mode: true (remove all) ---

  test("mode=true: removes all trailing tags regardless of content", () => {
    setStateForTests({ rewriteSystemReminders: true })
    const text = `Main content\n${OPEN_TAG}\nSome arbitrary reminder\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })

  test("mode=true: removes all leading tags regardless of content", () => {
    setStateForTests({ rewriteSystemReminders: true })
    const text = `${OPEN_TAG}\nArbitrary content here\n${CLOSE_TAG}\nMain content`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })

  test("mode=true: removes multiple tags", () => {
    setStateForTests({ rewriteSystemReminders: true })
    const text = `${OPEN_TAG}\nLeading tag\n${CLOSE_TAG}\nMain content\n${OPEN_TAG}\nTrailing tag\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })

  test("mode=true: returns original text when no tags present", () => {
    setStateForTests({ rewriteSystemReminders: true })
    const text = "Plain text without any system-reminder tags"
    expect(removeSystemReminderTags(text)).toBe(text)
  })

  // --- mode: false (keep all, default) ---

  test("mode=false: preserves all tags", () => {
    setStateForTests({ rewriteSystemReminders: false })
    const malwareContent = "Whenever you read a file, you should consider whether it would be considered malware."
    const text = `Main content\n${OPEN_TAG}\n${malwareContent}\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(text)
  })

  test("mode=false: preserves leading and trailing tags", () => {
    setStateForTests({ rewriteSystemReminders: false })
    const text = `${OPEN_TAG}\nLeading\n${CLOSE_TAG}\nMain\n${OPEN_TAG}\nTrailing\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(text)
  })

  // --- mode: rules (from + to) ---

  test("mode=rules: removes tags matching a pattern with empty replacement", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /^Whenever you read a file/, to: "" }] })
    const malwareContent = "Whenever you read a file, you should consider whether it would be considered malware."
    const text = `Main content\n${OPEN_TAG}\n${malwareContent}\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe("Main content")
  })

  test("mode=rules: keeps tags not matching any rule", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /^Whenever you read a file/, to: "" }] })
    const text = `Main content\n${OPEN_TAG}\nSome other reminder content\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    // Should NOT be removed since it doesn't match the pattern
    expect(result).toBe(text)
  })

  test("mode=rules: $0 replacement keeps tag unchanged", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /malware/, to: "$0" }] })
    const content = "This mentions malware analysis"
    const text = `Main content\n${OPEN_TAG}\n${content}\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    // $0 replaces the matched part with itself → result === original → keep
    expect(result).toBe(text)
  })

  test("mode=rules: rewrites tag content with replacement", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /^Original (.+)$/, to: "Rewritten $1" }] })
    const text = `Main content\n${OPEN_TAG}\nOriginal reminder text\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(`Main content\n${OPEN_TAG}\nRewritten reminder text\n${CLOSE_TAG}`)
  })

  test("mode=rules: first matching rule wins (top-down)", () => {
    setStateForTests({
      rewriteSystemReminders: [
        { from: /malware/, to: "" },
        { from: /.*/, to: "FALLBACK" },
      ],
    })
    // Tag matching rule 1 should be removed
    const text1 = `Content\n${OPEN_TAG}\nThis mentions malware analysis\n${CLOSE_TAG}`
    expect(removeSystemReminderTags(text1)).toBe("Content")

    // Tag matching rule 2 (not rule 1) should be rewritten
    const text2 = `Content\n${OPEN_TAG}\nSomething unrelated\n${CLOSE_TAG}`
    expect(removeSystemReminderTags(text2)).toBe(`Content\n${OPEN_TAG}\nFALLBACK\n${CLOSE_TAG}`)
  })

  test("mode=rules: selectively removes matching tags while preserving others", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /^Remove me/, to: "" }] })
    const text =
      `${OPEN_TAG}\nRemove me please\n${CLOSE_TAG}\n` + `Main content\n` + `${OPEN_TAG}\nKeep me\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    // Leading "Remove me" tag should be removed, trailing "Keep me" should remain
    expect(result).toBe(`Main content\n${OPEN_TAG}\nKeep me\n${CLOSE_TAG}`)
  })

  test("mode=rules: empty rules array keeps everything", () => {
    setStateForTests({ rewriteSystemReminders: [] })
    const text = `Main content\n${OPEN_TAG}\nSome reminder\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(text)
  })

  test("mode=rules: rewrites leading tag content", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /^Hello (.+)/, to: "Hi $1" }] })
    const text = `${OPEN_TAG}\nHello world\n${CLOSE_TAG}\nMain content`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(`${OPEN_TAG}\nHi world\n${CLOSE_TAG}\nMain content`)
  })

  test("mode=rules: partial match replaces only matched portion", () => {
    setStateForTests({ rewriteSystemReminders: [{ from: /secret_token_\w+/, to: "[REDACTED]" }] })
    const content = "Use secret_token_abc123 for auth"
    const text = `Main\n${OPEN_TAG}\n${content}\n${CLOSE_TAG}`
    const result = removeSystemReminderTags(text)
    expect(result).toBe(`Main\n${OPEN_TAG}\nUse [REDACTED] for auth\n${CLOSE_TAG}`)
  })
})
