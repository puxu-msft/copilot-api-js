/**
 * Component tests for auto-truncate retry strategy.
 *
 * Tests: createAutoTruncateStrategy (canHandle + handle)
 */

import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type {
  //
  RetryContext,
  SanitizeResult,
} from "~/lib/request/pipeline"
import type {
  //
  TruncateOptions,
  TruncateResult,
} from "~/lib/request/strategies/auto-truncate"

import {
  //
  factorAt,
  getLearnedLimits,
  resetAllLimitsForTesting,
} from "~/lib/auto-truncate"
import { HTTPError } from "~/lib/error"
import { createAutoTruncateStrategy } from "~/lib/request/strategies/auto-truncate"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { autoRestoreState } from "../helpers/state-fixture"

type TestPayload = { messages: Array<{ role: string; content: string }> }

function makeStrategy(overrides?: {
  isEnabled?: () => boolean
  truncateResult?: Partial<TruncateResult<TestPayload>>
  sanitizeResult?: Partial<SanitizeResult<TestPayload>>
  gptCount?: number
}) {
  const defaultPayload: TestPayload = { messages: [{ role: "user", content: "truncated" }] }

  const truncate = mock(
    async (_p: TestPayload, _m: any, _o: TruncateOptions): Promise<TruncateResult<TestPayload>> => ({
      wasTruncated: true,
      payload: defaultPayload,
      removedMessageCount: 2,
      originalTokens: 10000,
      compactedTokens: 5000,
      processingTimeMs: 50,
      ...overrides?.truncateResult,
    }),
  )

  const resanitize = mock(
    (payload: TestPayload): SanitizeResult<TestPayload> => ({
      payload,
      blocksRemoved: 0,
      systemReminderRemovals: 0,
      ...overrides?.sanitizeResult,
    }),
  )

  // gpt-tokenizer count of the failing payload — the strategy uses this both as
  // the calibration sample and to convert the reported limit into gpt caliber.
  const countTokens = mock(async (_p: TestPayload, _m: any): Promise<number> => overrides?.gptCount ?? 5000)

  const strategy = createAutoTruncateStrategy<TestPayload>({
    truncate,
    resanitize,
    countTokens,
    isEnabled: overrides?.isEnabled ?? (() => true),
    label: "test",
  })

  return { strategy, truncate, resanitize, countTokens }
}

function make413Error(): ApiError {
  const raw = new HTTPError("Too large", 413, "")
  return { type: "payload_too_large", status: 413, raw, message: "payload too large" }
}

function makeTokenLimitError(): ApiError {
  // Body must carry the OpenAI `code` (or Anthropic `type`) for tryParseAndLearnLimit
  // to recognize it as a learnable token-limit error and enter the conversion branch.
  const body = JSON.stringify({
    error: { code: "model_max_prompt_tokens_exceeded", message: "prompt token count of 135355 exceeds the limit of 128000" },
  })
  const raw = new HTTPError("Token limit", 400, body)
  return { type: "token_limit", status: 400, raw, message: "token limit", tokenLimit: 128000, tokenCurrent: 135355 }
}

function makeContext(overrides?: Partial<RetryContext<TestPayload>>): RetryContext<TestPayload> {
  return {
    attempt: 0,
    originalPayload: { messages: [{ role: "user", content: "original" }] },
    model: mockModel("claude-sonnet-4"),
    maxRetries: 3,
    ...overrides,
  }
}

afterEach(() => {
  resetAllLimitsForTesting()
})

// ─── canHandle ───

describe("createAutoTruncateStrategy - canHandle", () => {
  test("returns false when isEnabled() returns false", () => {
    const { strategy } = makeStrategy({ isEnabled: () => false })
    expect(strategy.canHandle(make413Error())).toBe(false)
  })

  test("returns true for payload_too_large when enabled", () => {
    const { strategy } = makeStrategy()
    expect(strategy.canHandle(make413Error())).toBe(true)
  })

  test("returns true for token_limit when enabled", () => {
    const { strategy } = makeStrategy()
    expect(strategy.canHandle(makeTokenLimitError())).toBe(true)
  })

  test("returns false for rate_limited", () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "rate_limited",
      status: 429,
      raw: new HTTPError("Rate limited", 429, ""),
      message: "rate limited",
    }
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("returns false for server_error", () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "server_error",
      status: 500,
      raw: new HTTPError("Server error", 500, ""),
      message: "server error",
    }
    expect(strategy.canHandle(error)).toBe(false)
  })
})

// ─── handle ───

describe("createAutoTruncateStrategy - handle", () => {
  test("aborts when no model in context", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext({ model: undefined }))
    expect(result.action).toBe("abort")
  })

  test("aborts when raw error is not HTTPError", async () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "payload_too_large",
      status: 413,
      raw: new Error("not HTTPError"),
      message: "test",
    }
    const result = await strategy.handle(error, { messages: [] }, makeContext())
    expect(result.action).toBe("abort")
  })

  test("truncates from originalPayload (not current)", async () => {
    const { strategy, truncate } = makeStrategy()
    const original: TestPayload = { messages: [{ role: "user", content: "original long message" }] }
    const current: TestPayload = { messages: [{ role: "user", content: "current" }] }

    await strategy.handle(make413Error(), current, makeContext({ originalPayload: original }))

    expect(truncate).toHaveBeenCalledTimes(1)
    expect(truncate.mock.calls[0][0]).toBe(original)
  })

  test("aborts when truncation returns wasTruncated=false", async () => {
    const { strategy } = makeStrategy({
      truncateResult: { wasTruncated: false },
    })
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())
    expect(result.action).toBe("abort")
  })

  test("re-sanitizes truncated payload", async () => {
    const { strategy, resanitize } = makeStrategy()
    await strategy.handle(make413Error(), { messages: [] }, makeContext())
    expect(resanitize).toHaveBeenCalledTimes(1)
  })

  test("returns retry action with truncateResult in meta", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())

    expect(result.action).toBe("retry")
    if (result.action === "retry") {
      expect((result as any).meta!.truncateResult).toBeDefined()
      expect((result as any).meta!.truncateResult.wasTruncated).toBe(true)
    }
  })

  test("returns sanitization counts in meta", async () => {
    const { strategy } = makeStrategy({
      sanitizeResult: {
        blocksRemoved: 2,
        systemReminderRemovals: 1,
        stats: {
          totalBlocksRemoved: 2,
          orphanedToolUseCount: 1,
          orphanedToolResultCount: 1,
          fixedNameCount: 0,
          emptyTextBlocksRemoved: 0,
          systemReminderRemovals: 1,
        },
      },
    })
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())

    if (result.action === "retry") {
      expect((result as any).meta!.sanitization.totalBlocksRemoved).toBe(2)
      expect((result as any).meta!.sanitization.systemReminderRemovals).toBe(1)
      expect((result as any).meta!.sanitization.orphanedToolUseCount).toBe(1)
    }
  })

  test("returns attempt number in meta", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext({ attempt: 2 }))

    if (result.action === "retry") {
      expect((result as any).meta!.attempt).toBe(3) // attempt + 1
    }
  })
})

// ─── caliber conversion (the core口径 fix) ───

describe("createAutoTruncateStrategy - token caliber conversion", () => {
  // RETRY_FACTOR (0.9) lives in engine; assert against the formula, not a literal.
  const FACTOR = 0.9

  test("converts reported limit into gpt caliber using ratio = current/gptCount", async () => {
    // reported: current=135355, limit=128000 (from makeTokenLimitError, OpenAI format)
    // gptCount stub = 64000 → ratio ≈ 2.115 → target = floor(128000*0.9 / ratio)
    const gptCount = 64000
    const { strategy, truncate } = makeStrategy({ gptCount })
    await strategy.handle(makeTokenLimitError(), { messages: [{ role: "user", content: "x" }] }, makeContext())

    const opts = truncate.mock.calls[0][2]
    const ratio = 135355 / gptCount
    const expected = Math.floor((128000 * FACTOR) / ratio)
    expect(opts.targetTokenLimit).toBe(expected)
    // Sanity: converted target is in gpt caliber, well below the raw reported target.
    expect(opts.targetTokenLimit!).toBeLessThan(Math.floor(128000 * FACTOR))
  })

  test("counts the FAILING (current) payload, not the original, for the ratio", async () => {
    const { strategy, countTokens } = makeStrategy({ gptCount: 64000 })
    const current: TestPayload = { messages: [{ role: "user", content: "current failing" }] }
    const original: TestPayload = { messages: [{ role: "user", content: "original" }] }
    await strategy.handle(makeTokenLimitError(), current, makeContext({ originalPayload: original }))

    expect(countTokens).toHaveBeenCalledTimes(1)
    expect(countTokens.mock.calls[0][0]).toBe(current)
  })

  test("learns calibration factor = reportedCurrent / gptCount", async () => {
    const gptCount = 64000
    const { strategy } = makeStrategy({ gptCount })
    await strategy.handle(makeTokenLimitError(), { messages: [{ role: "user", content: "x" }] }, makeContext())

    const learned = getLearnedLimits("claude-sonnet-4")
    expect(learned).toBeDefined()
    // Size-aware model: the 400's (est, real) sample lands in its size bucket;
    // factorAt at that estimate ≈ 135355/64000 ≈ 2.115. liveSampleCount tracks
    // the single live learning event.
    expect(factorAt("claude-sonnet-4", gptCount)).toBeCloseTo(135355 / gptCount, 2)
    expect(learned!.liveSampleCount).toBe(1)
  })

  test("falls back to raw reported target when gptCount is 0", async () => {
    const { strategy, truncate } = makeStrategy({ gptCount: 0 })
    await strategy.handle(makeTokenLimitError(), { messages: [{ role: "user", content: "x" }] }, makeContext())

    const opts = truncate.mock.calls[0][2]
    expect(opts.targetTokenLimit).toBe(Math.floor(128000 * FACTOR))
  })

  test("uses state.autoTruncateTargetFactor (config-driven), not a hardcoded 0.9", async () => {
    autoRestoreState()
    setStateForTests({ autoTruncateTargetFactor: 0.8 })

    const gptCount = 64000
    const { strategy, truncate } = makeStrategy({ gptCount })
    await strategy.handle(makeTokenLimitError(), { messages: [{ role: "user", content: "x" }] }, makeContext())

    const opts = truncate.mock.calls[0][2]
    const ratio = 135355 / gptCount
    expect(opts.targetTokenLimit).toBe(Math.floor((128000 * 0.8) / ratio))
  })
})
