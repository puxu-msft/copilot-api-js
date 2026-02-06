/**
 * System-reminder tag detection, filtering, and removal.
 *
 * Claude Code injects `<system-reminder>` tags into tool results and user
 * messages. Each tag always occupies its own line:
 *   \n<system-reminder>\n...content...\n</system-reminder>
 *
 * This module:
 * - Defines all known system-reminder content types
 * - Provides configurable filtering (which types to remove)
 * - Removes matching tags from the start/end of text content
 */

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

    // Skip trailing whitespace/newlines
    let end = scanEnd
    while (end > 0 && "\n \t\r".includes(text[end - 1])) end--

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

    // Skip leading whitespace
    let start = scanStart
    while (start < text.length && " \t\r".includes(text[start])) start++

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
// Filter Definitions
// ============================================================================

/**
 * A system-reminder filter type.
 *
 * `match` is a plain function using `startsWith` / `includes` instead of
 * RegExp — the content inside system-reminder tags has well-known structure,
 * so string methods are faster and more readable.
 */
export interface SystemReminderFilter {
  key: string
  description: string
  match: (content: string) => boolean
  defaultEnabled: boolean
}

/**
 * All known Claude Code system-reminder types.
 *
 * IMPORTANT: These patterns match content INSIDE `<system-reminder>` tags.
 * Content that appears directly in messages should NOT be in this list.
 */
export const SYSTEM_REMINDER_FILTERS: Array<SystemReminderFilter> = [
  {
    key: "malware",
    description: "Malware analysis reminder",
    match: (c) => c.startsWith("Whenever you read a file, you should consider whether it would be considered malware."),
    defaultEnabled: true,
  },
]

// ============================================================================
// Filter Configuration
// ============================================================================

/**
 * Get the list of currently enabled filters.
 * Can be customized via enabledFilterKeys parameter.
 */
export function getEnabledFilters(enabledFilterKeys?: Array<string>): Array<SystemReminderFilter> {
  if (enabledFilterKeys) {
    return SYSTEM_REMINDER_FILTERS.filter((f) => enabledFilterKeys.includes(f.key))
  }
  return SYSTEM_REMINDER_FILTERS.filter((f) => f.defaultEnabled)
}

// Current enabled filters (default: only malware)
let enabledFilters = getEnabledFilters()

/**
 * Configure which system-reminder filters are enabled.
 * Pass an array of filter keys to enable, or undefined to reset to defaults.
 */
export function configureSystemReminderFilters(filterKeys?: Array<string>): void {
  enabledFilters = getEnabledFilters(filterKeys)
}

/**
 * Check if a system-reminder content should be filtered out.
 * Only removes reminders that match currently enabled filters.
 */
function shouldFilterReminder(content: string): boolean {
  return enabledFilters.some((f) => f.match(content))
}

// ============================================================================
// Tag Removal
// ============================================================================

/**
 * Remove specific `<system-reminder>` tags from text content.
 *
 * Only removes reminders that:
 * 1. Match enabled filter patterns (default: malware)
 * 2. Appear at the START or END of content (not embedded in code)
 * 3. Are separated from main content by newlines (indicating injection points)
 *
 * This prevents accidental removal of system-reminder tags that appear
 * in tool_result content (e.g., when reading source files that contain
 * these tags as string literals or documentation).
 */
export function removeSystemReminderTags(text: string): string {
  let result = text
  let modified = false

  // Remove matching tags at the end
  const trailing = extractTrailingSystemReminderTags(result)
  if (trailing.tags.length > 0) {
    let tail = ""
    for (const tag of trailing.tags) {
      if (!shouldFilterReminder(tag.content)) {
        tail += result.slice(tag.tagStart, tag.tagEnd)
      }
    }
    const rebuilt = result.slice(0, trailing.mainContentEnd) + tail
    if (rebuilt.length < result.length) {
      result = rebuilt
      modified = true
    }
  }

  // Remove matching tags at the start
  const leading = extractLeadingSystemReminderTags(result)
  if (leading.tags.length > 0) {
    let head = ""
    for (const tag of leading.tags) {
      if (!shouldFilterReminder(tag.content)) {
        head += result.slice(tag.tagStart, tag.tagEnd)
      }
    }
    const rebuilt = head + result.slice(leading.mainContentStart)
    if (rebuilt.length < result.length) {
      result = rebuilt
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
