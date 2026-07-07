import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { HTTPError } from "~/lib/error"
import { createSystemRejectRetryStrategy } from "~/lib/request/strategies/system-reject-retry"

// The REAL upstream error string (positive sample — proves canHandle touches target).
const SYSTEM_REJECT_BODY = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: 'Unexpected role "system". The Messages API accepts a top-level system parameter, not inline system messages.',
  },
})

function rejectError(body = SYSTEM_REJECT_BODY): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: "HTTP 400: Failed to create Anthropic messages",
    raw: new HTTPError("boom", 400, body, "claude-sonnet-4.6"),
  }
}

const baseline: MessagesPayload = {
  model: "claude-sonnet-4.6",
  max_tokens: 100,
  messages: [{ role: "system", content: "ctx" } as never, { role: "user", content: "hi" }],
} as MessagesPayload

const ctx: RetryContext<MessagesPayload> = { attempt: 0, maxRetries: 3, originalPayload: baseline, model: undefined }

describe("createSystemRejectRetryStrategy", () => {
  test('canHandle matches the real Unexpected role "system" 400 (positive sample)', () => {
    const s = createSystemRejectRetryStrategy({
      resanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0, stats: {} as never }),
      mark: () => {},
    })
    expect(s.canHandle(rejectError())).toBe(true)
    expect(s.canHandle(rejectError(JSON.stringify({ error: { message: "something else" } })))).toBe(false)
  })

  test("handle: marks the model, re-sanitizes the PRE-S3 baseline, retries with meta.sanitization", async () => {
    const marked: Array<string> = []
    // Fake resanitize: proves the strategy feeds originalPayload (not currentPayload)
    // and forwards the resulting payload + stats.
    const resanitize = (p: MessagesPayload) => ({
      payload: { ...p, messages: p.messages.filter((m) => (m as { role: string }).role !== "system") },
      blocksRemoved: 0,
      systemReminderRemovals: 0,
      stats: { inlineSystemConverted: 1 } as never,
    })
    const s = createSystemRejectRetryStrategy({ resanitize, mark: (m) => marked.push(m) })
    const currentPayload = { ...baseline, messages: [{ role: "user", content: "already-mutated" }] } as MessagesPayload
    const res = await s.handle(rejectError(), currentPayload, ctx)
    expect(res.action).toBe("retry")
    expect(marked).toEqual(["claude-sonnet-4.6"])
    const retry = res as unknown as { payload: MessagesPayload; meta: { sanitization: unknown } }
    // fed the BASELINE (2 msgs → 1 after system strip), NOT currentPayload (1 msg "already-mutated")
    expect(retry.payload.messages).toHaveLength(1)
    expect((retry.payload.messages[0] as { content: string }).content).toBe("hi")
    expect(retry.meta.sanitization).toEqual({ inlineSystemConverted: 1 })
  })
})
