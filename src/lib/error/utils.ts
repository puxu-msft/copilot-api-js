/**
 * Parse the `Retry-After` HTTP response header.
 * Supports both formats per RFC 7231:
 *   - Seconds: `Retry-After: 120` → 120
 *   - HTTP-date: `Retry-After: Fri, 31 Dec 2025 23:59:59 GMT` → seconds from now
 * Returns undefined if header is missing or unparseable.
 */
export function parseRetryAfterHeader(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined

  const value = headers.get("retry-after")
  if (!value) return undefined

  // Try as seconds (integer)
  const seconds = Number.parseInt(value, 10)
  if (!Number.isNaN(seconds) && String(seconds) === value.trim()) {
    return seconds > 0 ? seconds : undefined
  }

  // Try as HTTP-date
  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now()
    const deltaSec = Math.ceil(deltaMs / 1000)
    return deltaSec > 0 ? deltaSec : undefined
  }

  return undefined
}

/**
 * Strip Bun's unhelpful verbose hint from error messages.
 * Bun appends "For more information, pass `verbose: true` in the second argument to fetch()"
 * to socket/network errors — this is an implementation detail, not useful to the user.
 */
function stripBunVerboseHint(message: string): string {
  return message.replace(/\s*For more information, pass `verbose: true`.*$/i, "")
}

/**
 * Format error message including cause chain, with Bun noise stripped.
 * Surfaces error.cause details (e.g. underlying socket/TLS reason) inline.
 */
export function formatErrorWithCause(error: Error): string {
  let msg = stripBunVerboseHint(error.message)
  if (error.cause instanceof Error && error.cause.message && error.cause.message !== error.message) {
    msg += ` (cause: ${stripBunVerboseHint(error.cause.message)})`
  }
  return msg
}

/** Extract error message with fallback. For HTTPError, extracts the actual API error response. */
export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) {
    if ("responseText" in error && typeof (error as { responseText: unknown }).responseText === "string") {
      const responseText = (error as { responseText: string }).responseText
      const status = "status" in error ? (error as { status: number }).status : undefined
      try {
        const parsed = JSON.parse(responseText) as { error?: { message?: string; type?: string } }
        if (parsed.error?.message) {
          return status ? `HTTP ${status}: ${parsed.error.message}` : parsed.error.message
        }
      } catch {
        if (responseText.length > 0 && responseText.length < 500) {
          return status ? `HTTP ${status}: ${responseText}` : responseText
        }
      }
      return status ? `HTTP ${status}: ${error.message}` : error.message
    }

    return formatErrorWithCause(error)
  }

  return fallback
}
