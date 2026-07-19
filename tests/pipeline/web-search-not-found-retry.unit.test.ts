import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { HTTPError } from "~/lib/error"
import { createWebSearchNotFoundRetryStrategy } from "~/lib/request/strategies/web-search-not-found-retry"

// The REAL raw upstream body (positive sample — proves canHandle touches target).
// Single quotes are NOT JSON-escaped, so the responseText literally contains
// `Tool 'web_search' not found in provided tools` (verified via node probe).
const WEB_SEARCH_NOT_FOUND_BODY = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Tool 'web_search' not found in provided tools",
  },
})

// The deferred-tool strategy's DISTINCT wording — must NOT collide (RFC §1 gap C vs G).
const DEFERRED_TOOL_BODY = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Tool reference 'web_search' not found in available tools",
  },
})

function notFoundError(body = WEB_SEARCH_NOT_FOUND_BODY): ApiError {
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
  messages: [
    // A prior-turn server_tool_use{web_search} block that the re-sanitize arm downgrades.
    { role: "assistant", content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }] as never },
    { role: "user", content: "hi" },
  ],
} as MessagesPayload

const ctx: RetryContext<MessagesPayload> = { attempt: 0, maxRetries: 3, originalPayload: baseline, model: undefined }

describe("createWebSearchNotFoundRetryStrategy", () => {
  test("canHandle matches the real `Tool '…' not found in provided tools` 400 (positive sample)", () => {
    const s = createWebSearchNotFoundRetryStrategy({
      resanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0, stats: {} as never }),
      mark: () => {},
    })
    expect(s.canHandle(notFoundError())).toBe(true)
  })

  test("canHandle is FALSE for the deferred-tool wording (no C/G collision)", () => {
    const s = createWebSearchNotFoundRetryStrategy({
      resanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0, stats: {} as never }),
      mark: () => {},
    })
    expect(s.canHandle(notFoundError(DEFERRED_TOOL_BODY))).toBe(false)
  })

  test("canHandle is FALSE for an unrelated 400", () => {
    const s = createWebSearchNotFoundRetryStrategy({
      resanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0, stats: {} as never }),
      mark: () => {},
    })
    expect(s.canHandle(notFoundError(JSON.stringify({ error: { message: "something else" } })))).toBe(false)
  })

  test("handle: marks the model, re-sanitizes the PRE-S3 baseline, retries with meta.sanitization", async () => {
    const marked: Array<string> = []
    // Fake resanitize: proves the strategy feeds originalPayload (not currentPayload)
    // and forwards the resulting payload + stats. Here it strips the server_tool_use turn.
    const resanitize = (p: MessagesPayload) => ({
      payload: { ...p, messages: p.messages.filter((m) => (m as { role: string }).role !== "assistant") },
      blocksRemoved: 0,
      systemReminderRemovals: 0,
      stats: { serverToolDowngraded: 1 } as never,
    })
    const s = createWebSearchNotFoundRetryStrategy({ resanitize, mark: (m) => marked.push(m) })
    const currentPayload = { ...baseline, messages: [{ role: "user", content: "already-mutated" }] } as MessagesPayload
    const res = await s.handle(notFoundError(), currentPayload, ctx)
    expect(res.action).toBe("retry")
    expect(marked).toEqual(["claude-sonnet-4.6"])
    const retry = res as unknown as { payload: MessagesPayload; meta: { sanitization: unknown } }
    // fed the BASELINE (2 msgs → 1 after assistant strip), NOT currentPayload (1 msg "already-mutated")
    expect(retry.payload.messages).toHaveLength(1)
    expect((retry.payload.messages[0] as { content: string }).content).toBe("hi")
    expect(retry.meta.sanitization).toEqual({ serverToolDowngraded: 1 })
  })
})
