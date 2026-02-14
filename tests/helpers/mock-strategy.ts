/**
 * Mock RetryStrategy factory for pipeline testing.
 */

import { mock } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryAction, RetryContext, RetryStrategy } from "~/lib/request/pipeline"

/**
 * Create a mock RetryStrategy with controllable behavior.
 *
 * By default, canHandle returns false and handle returns abort.
 */
export function createMockStrategy<TPayload>(overrides?: Partial<RetryStrategy<TPayload>>): RetryStrategy<TPayload> {
  return {
    name: "mock-strategy",
    canHandle: mock((_error: ApiError) => false),
    handle: mock(
      async (
        error: ApiError,
        _payload: TPayload,
        _context: RetryContext<TPayload>,
      ): Promise<RetryAction<TPayload>> => ({
        action: "abort",
        error,
      }),
    ),
    ...overrides,
  }
}

/**
 * Create a strategy that always handles with retry, returning the given payload.
 */
export function createRetryStrategy<TPayload>(
  newPayload: TPayload,
  meta?: Record<string, unknown>,
): RetryStrategy<TPayload> {
  return createMockStrategy({
    name: "retry-strategy",
    canHandle: mock(() => true),
    handle: mock(async () => ({
      action: "retry" as const,
      payload: newPayload,
      meta,
    })),
  })
}

/**
 * Create a strategy that handles specific error types.
 */
export function createTypedStrategy<TPayload>(
  errorTypes: Array<string>,
  action: RetryAction<TPayload>,
): RetryStrategy<TPayload> {
  return createMockStrategy({
    name: `typed-strategy-${errorTypes.join("+")}`,
    canHandle: mock((error: ApiError) => errorTypes.includes(error.type)),
    handle: mock(async () => action),
  })
}
