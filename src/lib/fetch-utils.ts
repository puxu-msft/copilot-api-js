import type { HeadersCapture } from "~/lib/context/request"

import { state } from "~/lib/state"

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"])

/**
 * Create an AbortSignal for fetch timeout if configured.
 * Controls the time from request start to receiving response headers.
 * Returns undefined if fetchTimeout is 0 (disabled).
 */
export function createFetchSignal(): AbortSignal | undefined {
  return state.fetchTimeout > 0 ? AbortSignal.timeout(state.fetchTimeout * 1000) : undefined
}

/**
 * Populate a HeadersCapture object with request and response headers.
 * Should be called immediately after fetch(), before !response.ok check,
 * so headers are captured even for error responses.
 */
export function captureHttpHeaders(
  capture: HeadersCapture,
  requestHeaders: Record<string, string>,
  response: Response,
): void {
  capture.request = sanitizeHeadersForHistory(requestHeaders)
  capture.response = Object.fromEntries(response.headers.entries())
}

/** Return a copy of headers safe to persist in history/error artifacts. */
export function sanitizeHeadersForHistory(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "***" : value,
    ]),
  )
}
