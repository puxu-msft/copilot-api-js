/**
 * Mock FormatAdapter factory for pipeline testing.
 */

import { mock } from "bun:test"

import type { FormatAdapter } from "~/lib/request/pipeline"
import type { SanitizeResult } from "~/lib/request/retry-types"

/**
 * Create a mock FormatAdapter with controllable behavior.
 */
export function createMockAdapter<TPayload>(overrides?: Partial<FormatAdapter<TPayload>>): FormatAdapter<TPayload> {
  return {
    format: "anthropic-messages",
    sanitize: mock(
      (payload: TPayload): SanitizeResult<TPayload> => ({
        payload,
        blocksRemoved: 0,
        systemReminderRemovals: 0,
      }),
    ),
    execute: mock(async (_payload: TPayload) => ({
      result: { ok: true },
      queueWaitMs: 0,
    })),
    logPayloadSize: mock(() => {}),
    ...overrides,
  }
}
