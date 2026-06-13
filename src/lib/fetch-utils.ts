import type { HeadersCapture } from "~/lib/context/request"

import { state } from "./state"

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"])

/** Convert a Headers object to a sanitized Record for history persistence. */
export function captureInboundHeaders(headers: Headers): Record<string, string> {
  return sanitizeHeadersForHistory(Object.fromEntries(headers.entries()))
}

/**
 * Create an AbortSignal for fetch timeout if configured.
 * Controls the time from request start to receiving response headers.
 * Returns undefined if fetchTimeout is 0 (disabled).
 */
export function createFetchSignal(): AbortSignal | undefined {
  return state.fetchTimeout > 0 ? AbortSignal.timeout(state.fetchTimeout * 1000) : undefined
}

/**
 * Bun's native `fetch` enforces a built-in 300s timeout (connection → response
 * headers) that fires independently of any `signal` we pass and CANNOT be
 * lengthened — Bun aborts on whichever fires first, so a large `timeouts.response_header`
 * is silently capped at 300s and surfaces as `TimeoutError: "The operation
 * timed out."`. Spreading this into the upstream fetch init disables that
 * built-in clock so our application-level `createFetchSignal()` (driven by
 * `timeouts.response_header`) is the single source of truth.
 *
 * Spread (not a literal field) so TypeScript's excess-property check doesn't
 * reject `timeout` on the standard `RequestInit`. Inert on Node — unknown
 * RequestInit fields are ignored there.
 */
export const DISABLE_BUILTIN_FETCH_TIMEOUT = { timeout: false } as const

/**
 * Populate a HeadersCapture object with request and response headers.
 * Should be called immediately after fetch(), before !response.ok check,
 * so headers are captured even for error responses.
 */
export function captureHttpHeaders(capture: HeadersCapture, requestHeaders: Record<string, string>, response: Response): void {
  capture.request = sanitizeHeadersForHistory(requestHeaders)
  capture.response = Object.fromEntries(response.headers.entries())
}

/** Return a copy of headers safe to persist in history/error artifacts. */
export function sanitizeHeadersForHistory(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "***" : value]))
}

/**
 * Case-insensitive header lookup over a plain Record.
 * Use this whenever an HTTP/WS header may have been written with arbitrary
 * casing (clients are inconsistent) and you need a single canonical answer
 * without building a normalized map per call.
 */
export function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}
