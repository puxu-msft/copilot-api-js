/** Parse token limit info from error message text. */
export function parseTokenLimitError(message: string): {
  current: number
  limit: number
} | null {
  const openaiMatch = message.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)
  if (openaiMatch) {
    return {
      current: Number.parseInt(openaiMatch[1], 10),
      limit: Number.parseInt(openaiMatch[2], 10),
    }
  }

  const anthropicMatch = message.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)
  if (anthropicMatch) {
    return {
      current: Number.parseInt(anthropicMatch[1], 10),
      limit: Number.parseInt(anthropicMatch[2], 10),
    }
  }

  return null
}

/** Extract retry_after from JSON response body. */
export function extractRetryAfterFromBody(responseText: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object") {
      if ("retry_after" in parsed && typeof (parsed as Record<string, unknown>).retry_after === "number") {
        return (parsed as { retry_after: number }).retry_after
      }

      if ("error" in parsed) {
        const err = (parsed as { error: unknown }).error
        if (
          err
          && typeof err === "object"
          && "retry_after" in err
          && typeof (err as Record<string, unknown>).retry_after === "number"
        ) {
          return (err as { retry_after: number }).retry_after
        }
      }
    }
  } catch {
    // Not JSON
  }

  return undefined
}

/** Check if a 503 response body indicates upstream provider rate limiting. */
export function isUpstreamRateLimited(responseText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error
      if (err && typeof err === "object") {
        const errObj = err as Record<string, unknown>
        if (typeof errObj.code === "string" && errObj.code.includes("rate")) return true
        if (typeof errObj.message === "string") {
          const msg = errObj.message.toLowerCase()
          if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) return true
        }
      }
    }
  } catch {
    const lower = responseText.toLowerCase()
    if (lower.includes("rate limit") || lower.includes("too many requests")) return true
  }

  return false
}

/** Try to extract token limit info from a JSON error response body. */
export function extractTokenLimitFromResponseText(responseText: string): {
  current: number
  limit: number
} | null {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error
      if (
        err
        && typeof err === "object"
        && "message" in err
        && typeof (err as Record<string, unknown>).message === "string"
      ) {
        return parseTokenLimitError((err as { message: string }).message)
      }
    }
  } catch {
    // Not JSON
  }

  return null
}
