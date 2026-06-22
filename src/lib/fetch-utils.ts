import type { HeadersCapture } from "~/lib/context/request"

import { state } from "./state"

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"])

/**
 * Convert a Headers object to a Record for history persistence.
 *
 * RFC history-http-header-capture Phase 1: History 存**原始未脱敏**头（operator
 * 决策；richest-data-flow "后端存储必须完整"）。脱敏不再发生在捕获点——
 * `sanitizeHeadersForHistory` 仅保留给 betaProbe（只读 anthropic-beta，零泄漏）。
 */
export function captureInboundHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
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
  // RFC Phase 1: History 存原始未脱敏头（见 captureInboundHeaders 注释）。
  capture.request = requestHeaders
  capture.response = Object.fromEntries(response.headers.entries())
}

/** Redact sensitive header values. Retained for betaProbe (reads only anthropic-beta); NOT used on the History capture path (Phase 1 stores raw). */
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
