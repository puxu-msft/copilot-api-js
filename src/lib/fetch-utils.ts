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
