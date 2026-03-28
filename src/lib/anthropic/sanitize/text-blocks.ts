import { removeSystemReminderTags } from "~/lib/system-prompt"

/**
 * Remove system-reminder tags from text blocks in an array.
 * Drops blocks whose text becomes empty after sanitization.
 * Returns the original array reference if nothing changed.
 */
export function sanitizeTextBlocksInArray<T extends { type: string }>(
  blocks: Array<T>,
  getText: (block: T) => string | undefined,
  setText: (block: T, text: string) => T,
): { blocks: Array<T>; modified: boolean } {
  let modified = false
  const result: Array<T> = []

  for (const block of blocks) {
    const text = getText(block)
    if (text !== undefined) {
      const sanitized = removeSystemReminderTags(text)
      if (sanitized !== text) {
        modified = true
        if (sanitized) {
          result.push(setText(block, sanitized))
        }
        continue
      }
    }
    result.push(block)
  }

  return { blocks: modified ? result : blocks, modified }
}
