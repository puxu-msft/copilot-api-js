/**
 * Truncation marker utilities.
 */

/** Minimal truncate result info needed for usage adjustment and markers */
export interface TruncateResultInfo {
  wasTruncated: boolean
  originalTokens?: number
  compactedTokens?: number
  removedMessageCount?: number
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 * Works with both OpenAI and Anthropic truncate results.
 */
export function createTruncationMarker(result: TruncateResultInfo): string {
  if (!result.wasTruncated) return ""

  const { originalTokens, compactedTokens, removedMessageCount } = result

  if (originalTokens === undefined || compactedTokens === undefined || removedMessageCount === undefined) {
    return `\n\n---\n[Auto-truncated: conversation history was reduced to fit context limits]`
  }

  const reduction = originalTokens - compactedTokens
  const percentage = Math.round((reduction / originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${removedMessageCount} messages removed, `
    + `${originalTokens} → ${compactedTokens} tokens (${percentage}% reduction)]`
  )
}
