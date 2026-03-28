/**
 * System-reminder tag detection, rewriting, and removal.
 *
 * Claude Code injects `<system-reminder>` tags into tool results and user
 * messages. Each tag always occupies its own line:
 *   \n<system-reminder>\n...content...\n</system-reminder>
 *
 * This module:
 * - Defines all known system-reminder content types
 * - Provides configurable rewriting (transform, keep, or remove tags)
 * - Processes tags at the start/end of text content
 *
 * Rewriting is controlled by `state.rewriteSystemReminders`:
 * - `false` — keep all tags unchanged (default)
 * - `true`  — remove all tags
 * - `Array<CompiledRewriteRule>` — rewrite rules evaluated top-down,
 *   first match wins. If replacement produces the original content, tag is
 *   kept unchanged. If replacement produces an empty string, tag is removed.
 *   Otherwise, tag content is replaced with the result.
 */

import { state } from "../state"

// ============================================================================
// Tag Constants
// ============================================================================

/** Opening tag — always appears on its own line */
export const OPEN_TAG = "<system-reminder>"

/** Closing tag — always appears on its own line */
export const CLOSE_TAG = "</system-reminder>"

// ============================================================================
// Tag Parsing Types
// ============================================================================

/** A parsed system-reminder tag found at a text boundary. */
export interface ParsedSystemReminderTag {
  /** The inner content between `<system-reminder>` and `</system-reminder>` */
  content: string
  /** Start position of the tag in the original text (the `\n` before `<system-reminder>`) */
  tagStart: number
  /** End position of the tag (exclusive), i.e. the range is [tagStart, tagEnd) */
  tagEnd: number
}

/**
 * Extract trailing `<system-reminder>` tags from text.
 *
 * Scans backwards from the end, collecting each tag that sits on its own
 * lines at the text boundary. Returns them outermost-first and the position
 * where main (non-tag) content ends.
 *
 * Used by both:
 * - `removeSystemReminderTags` (filter by content, then rebuild)
 * - `compressToolResultContent` (extract all, generate summaries)
 */
export function extractTrailingSystemReminderTags(text: string): {
  mainContentEnd: number
  tags: Array<ParsedSystemReminderTag>
} {
  const tags: Array<ParsedSystemReminderTag> = []
  let scanEnd = text.length

  while (true) {
    const currentTagEnd = scanEnd

    // Skip trailing whitespace/newlines (charCode: \n=10, space=32, \t=9, \r=13)
    let end = scanEnd
    while (end > 0) {
      const c = text.codePointAt(end - 1)
      if (c !== 10 && c !== 32 && c !== 9 && c !== 13) break
      end--
    }

    // Must end with </system-reminder>
    if (end < CLOSE_TAG.length) break
    if (text.slice(end - CLOSE_TAG.length, end) !== CLOSE_TAG) break

    const closeTagStart = end - CLOSE_TAG.length

    // </system-reminder> must be at line start (preceded by \n)
    if (closeTagStart === 0 || text[closeTagStart - 1] !== "\n") break

    // Find matching \n<system-reminder>\n before it
    const openSearch = "\n" + OPEN_TAG + "\n"
    const openPos = text.lastIndexOf(openSearch, closeTagStart)
    if (openPos === -1) break

    // Extract inner content
    const innerStart = openPos + openSearch.length
    const innerEnd = closeTagStart - 1 // the \n before </system-reminder>
    if (innerStart > innerEnd) break

    const content = text.slice(innerStart, innerEnd)
    tags.push({ content, tagStart: openPos, tagEnd: currentTagEnd })

    scanEnd = openPos
  }

  return { mainContentEnd: scanEnd, tags }
}

/**
 * Extract leading `<system-reminder>` tags from text.
 *
 * Scans forward from the start, collecting each tag that begins at the text
 * boundary (possibly preceded by whitespace). Returns tags in order and the
 * position where main (non-tag) content starts.
 *
 * Leading tags use the format:
 *   [whitespace]<system-reminder>\n...content...\n</system-reminder>[\n|EOF]
 *
 * Note: The first tag may start without a preceding `\n` (beginning of text).
 */
export function extractLeadingSystemReminderTags(text: string): {
  mainContentStart: number
  tags: Array<ParsedSystemReminderTag>
} {
  const tags: Array<ParsedSystemReminderTag> = []
  let scanStart = 0

  while (true) {
    const currentTagStart = scanStart

    // Skip leading whitespace (charCode: space=32, \t=9, \r=13)
    let start = scanStart
    while (start < text.length) {
      const c = text.codePointAt(start)
      if (c !== 32 && c !== 9 && c !== 13) break
      start++
    }

    // Must start with <system-reminder>
    if (start + OPEN_TAG.length > text.length) break
    if (text.slice(start, start + OPEN_TAG.length) !== OPEN_TAG) break

    const afterOpen = start + OPEN_TAG.length
    if (afterOpen >= text.length || text[afterOpen] !== "\n") break

    // Find closing tag: \n</system-reminder> followed by \n or EOF
    const closeNeedle = "\n" + CLOSE_TAG
    let searchFrom = afterOpen
    let closePos = -1
    while (true) {
      const pos = text.indexOf(closeNeedle, searchFrom)
      if (pos === -1) break
      const afterClose = pos + closeNeedle.length
      if (afterClose >= text.length || text[afterClose] === "\n") {
        closePos = pos
        break
      }
      searchFrom = pos + 1
    }
    if (closePos === -1) break

    const content = text.slice(afterOpen + 1, closePos)

    // tagEnd: skip past \n</system-reminder> and any trailing newlines
    let endPos = closePos + closeNeedle.length
    while (endPos < text.length && text[endPos] === "\n") endPos++

    tags.push({ content, tagStart: currentTagStart, tagEnd: endPos })
    scanStart = endPos
  }

  return { mainContentStart: scanStart, tags }
}

// ============================================================================
// Rewrite Configuration
// ============================================================================

/**
 * Determine how to rewrite a system-reminder tag's content.
 *
 * Reads from `state.rewriteSystemReminders`:
 * - `true`  → return `""` (remove all tags)
 * - `false` → return `null` (keep all tags unchanged)
 * - `Array<CompiledRewriteRule>` → first matching rule wins (top-down):
 *   - `to: ""` → return `""` (remove the tag entirely)
 *   - `to: "$0"` (regex mode) → return `null` (keep unchanged, fast path)
 *   - Otherwise → apply replacement:
 *     - regex mode: `content.replace(from, to)` with capture group support
 *     - line mode: replace exact `from` substring with `to`
 *     - If result === original → return `null` (keep)
 *     - Otherwise → return the new content
 *   - If no rule matches → return `null` (keep)
 *
 * @returns `null` to keep original, `""` to remove, or a new content string
 */
function rewriteReminder(content: string): string | null {
  const rewrite = state.rewriteSystemReminders
  if (rewrite === true) return ""
  if (rewrite === false) return null

  for (const rule of rewrite) {
    const matched = rule.method === "line" ? content.includes(rule.from as string) : (rule.from as RegExp).test(content)

    // Reset lastIndex after test() in case of global flag
    if (rule.method !== "line") (rule.from as RegExp).lastIndex = 0

    if (!matched) continue

    // Empty replacement = remove the entire tag
    if (rule.to === "") return ""

    // $0 replacement in regex mode = keep tag unchanged (identity)
    if (rule.method !== "line" && rule.to === "$0") return null

    const result =
      rule.method === "line" ?
        content.replaceAll(rule.from as string, rule.to)
      : content.replace(rule.from as RegExp, rule.to)

    if (result === content) return null // replacement produced no change → keep
    return result
  }

  return null // no rule matched → keep
}

// ============================================================================
// Tag Removal
// ============================================================================

/**
 * Rewrite, remove, or keep `<system-reminder>` tags in text content.
 *
 * Only processes reminders that:
 * 1. Appear at the START or END of content (not embedded in code)
 * 2. Are separated from main content by newlines (indicating injection points)
 *
 * For each tag, `rewriteReminder(content)` decides the action:
 * - `null` → keep the tag unchanged
 * - `""` → remove the tag entirely
 * - new string → replace the tag's inner content
 *
 * This prevents accidental modification of system-reminder tags that appear
 * in tool_result content (e.g., when reading source files that contain
 * these tags as string literals or documentation).
 */
export function removeSystemReminderTags(text: string): string {
  let result = text
  let modified = false

  // Process trailing tags
  const trailing = extractTrailingSystemReminderTags(result)
  if (trailing.tags.length > 0) {
    let tail = ""
    for (const tag of trailing.tags) {
      const rewritten = rewriteReminder(tag.content)
      if (rewritten === null) {
        // Keep original
        tail += result.slice(tag.tagStart, tag.tagEnd)
      } else if (rewritten === "") {
        // Remove — don't append anything
        modified = true
      } else {
        // Replace content
        tail += `\n${OPEN_TAG}\n${rewritten}\n${CLOSE_TAG}`
        modified = true
      }
    }
    if (modified) {
      result = result.slice(0, trailing.mainContentEnd) + tail
    }
  }

  // Process leading tags
  const leading = extractLeadingSystemReminderTags(result)
  if (leading.tags.length > 0) {
    let head = ""
    let leadingModified = false
    for (const tag of leading.tags) {
      const rewritten = rewriteReminder(tag.content)
      if (rewritten === null) {
        // Keep original
        head += result.slice(tag.tagStart, tag.tagEnd)
      } else if (rewritten === "") {
        // Remove — don't append anything
        leadingModified = true
      } else {
        // Replace content
        head += `${OPEN_TAG}\n${rewritten}\n${CLOSE_TAG}\n`
        leadingModified = true
      }
    }
    if (leadingModified) {
      result = head + result.slice(leading.mainContentStart)
      modified = true
    }
  }

  if (!modified) return text

  // Only strip trailing newlines left behind by tag removal — never touch
  // leading whitespace (e.g. indentation in tool_result content like
  // "     1→const x = 1") to avoid false "rewritten" diffs.
  let end = result.length
  while (end > 0 && result[end - 1] === "\n") end--
  return end < result.length ? result.slice(0, end) : result
}
