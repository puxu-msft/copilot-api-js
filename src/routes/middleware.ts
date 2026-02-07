/**
 * Route-level middleware for error handling.
 */

import type { Context } from "hono"

import { forwardError } from "~/lib/error"

type Handler = (c: Context) => Promise<Response> | Response

/**
 * Wrap a route handler with standard error handling.
 * Eliminates the repeated try/catch + forwardError pattern in route files.
 */
export function withErrorHandler(handler: Handler): (c: Context) => Promise<Response> {
  return async (c: Context) => {
    try {
      return await handler(c)
    } catch (error) {
      return forwardError(c, error)
    }
  }
}
