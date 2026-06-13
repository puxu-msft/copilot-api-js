/**
 * Unit tests for the [RETRY-n] TUI emission from `executeRequestPipeline`.
 *
 * Verifies that:
 *   - Every retry-eligible failure triggers `TuiRenderer.onRequestRetry` once
 *     with the correct `RetryInfo` (attempt index, strategy, status, error,
 *     waitMs, learning flag).
 *   - Emission happens AFTER the budget gate — a budget-exhausted attempt
 *     produces no retry line for the discarded action.
 *   - Aborted strategies, first-attempt successes, and pipelines without a
 *     `requestContext` do NOT trigger the hook.
 *
 * The TUI renderer is the seam — we install a recording renderer via
 * `tuiLogger.setRenderer()` and assert against the captured events.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  FormatAdapter,
  RetryStrategy,
} from "~/lib/request/pipeline"
import type {
  //
  RetryInfo,
  TuiLogEntry,
  TuiRenderer,
} from "~/lib/tui"

import { createRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { tuiLogger } from "~/lib/tui"

interface TestPayload {
  model: string
  marker?: string
}

interface RecordedRetry {
  entryId: string
  info: RetryInfo
}

interface RecordingRenderer extends TuiRenderer {
  retries: Array<RecordedRetry>
}

function createRecordingRenderer(): RecordingRenderer {
  const retries: Array<RecordedRetry> = []
  return {
    retries,
    onRequestStart: () => {},
    onRequestUpdate: () => {},
    onRequestRetry: (entry: TuiLogEntry, info: RetryInfo) => {
      retries.push({ entryId: entry.id, info: { ...info } })
    },
    onRequestComplete: () => {},
    destroy: () => {},
  }
}

function makeAdapter(executeFn: FormatAdapter<TestPayload>["execute"]): FormatAdapter<TestPayload> {
  return {
    format: "anthropic-messages",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    execute: executeFn,
    logPayloadSize: () => {},
  }
}

/** Trivial retry strategy that succeeds on the second attempt. */
function alwaysRetry(name: string, opts: { waitMs?: number; learning?: boolean } = {}): RetryStrategy<TestPayload> {
  return {
    name,
    canHandle: () => true,
    handle: async (_error, payload) => ({
      action: "retry",
      payload,
      ...(opts.waitMs !== undefined && { waitMs: opts.waitMs }),
      ...(opts.learning !== undefined && { learning: opts.learning }),
    }),
  }
}

/** Strategy that aborts on every error. */
function alwaysAbort(name: string): RetryStrategy<TestPayload> {
  return {
    name,
    canHandle: () => true,
    handle: async (error) => ({ action: "abort", error }),
  }
}

const basePayload: TestPayload = { model: "gpt-test" }

// ─── Fixture setup ───

let recording: RecordingRenderer
let priorRenderer: TuiRenderer | null = null

beforeEach(() => {
  recording = createRecordingRenderer()
  // Hold onto whatever renderer was installed (test harness may have one) and
  // restore in afterEach so we don't leak between tests.
  priorRenderer = (tuiLogger as unknown as { renderer: TuiRenderer | null }).renderer
  tuiLogger.setRenderer(recording)
})

afterEach(() => {
  tuiLogger.clear()
  tuiLogger.setRenderer(priorRenderer)
})

// ─── Tests ───

describe("executeRequestPipeline → [RETRY-n] TUI emission", () => {
  test("emits a single retry event with correct RetryInfo when one retry succeeds", async () => {
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    let callCount = 0
    const adapter = makeAdapter(
      mock(async (p: TestPayload) => {
        callCount++
        if (callCount === 1) throw new HTTPError("Network reset", 502, "")
        return { result: { ok: true, marker: p.marker }, queueWaitMs: 0 }
      }),
    )

    const result = await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("network-retry", { waitMs: 1000 })],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      requestContext: reqCtx,
    })

    expect(result.totalRetries).toBe(1)
    expect(recording.retries).toHaveLength(1)
    const [evt] = recording.retries
    expect(evt.entryId).toBe(tuiLogId)
    expect(evt.info).toEqual({
      attempt: 1,
      strategyName: "network-retry",
      statusCode: 502,
      error: expect.stringContaining("Network reset"),
      waitMs: 1000,
      learning: false,
    })
  })

  test("emits one retry event per attempt across multiple distinct strategies", async () => {
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        // First two attempts fail with different errors; third succeeds.
        if (callCount === 1) throw new HTTPError("ECONNRESET", 502, "")
        if (callCount === 2) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    // Strategy 1 handles only 502; strategy 2 handles only 413. Each fires once.
    const strat1: RetryStrategy<TestPayload> = {
      name: "network-retry",
      canHandle: (e) => e.status === 502,
      handle: async (_e, p) => ({ action: "retry", payload: p, waitMs: 1000 }),
    }
    const strat2: RetryStrategy<TestPayload> = {
      name: "auto-truncate",
      canHandle: (e) => e.status === 413,
      handle: async (_e, p) => ({ action: "retry", payload: p }),
    }

    const result = await executeRequestPipeline({
      adapter,
      strategies: [strat1, strat2],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 5,
      requestContext: reqCtx,
    })

    expect(result.totalRetries).toBe(2)
    expect(recording.retries).toHaveLength(2)
    expect(recording.retries[0].info.attempt).toBe(1)
    expect(recording.retries[0].info.strategyName).toBe("network-retry")
    expect(recording.retries[0].info.statusCode).toBe(502)
    expect(recording.retries[1].info.attempt).toBe(2)
    expect(recording.retries[1].info.strategyName).toBe("auto-truncate")
    expect(recording.retries[1].info.statusCode).toBe(413)
  })

  test("learning-probe retries carry learning:true", async () => {
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("invalid beta flag", 400, JSON.stringify({ message: "invalid beta flag" }))
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("unsupported-beta-retry", { learning: true })],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 0, // learning retries draw from a separate budget
      requestContext: reqCtx,
    })

    expect(recording.retries).toHaveLength(1)
    expect(recording.retries[0].info.learning).toBe(true)
    expect(recording.retries[0].info.strategyName).toBe("unsupported-beta-retry")
  })

  test("first-attempt success emits no retry event", async () => {
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    const adapter = makeAdapter(mock(async () => ({ result: "ok", queueWaitMs: 0 })))

    await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("would-retry")],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      requestContext: reqCtx,
    })

    expect(recording.retries).toHaveLength(0)
  })

  test("abort action emits no retry event", async () => {
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    const adapter = makeAdapter(
      mock(async () => {
        throw new HTTPError("Forbidden", 403, "")
      }),
    )

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [alwaysAbort("token-refresh")],
        payload: basePayload,
        originalPayload: basePayload,
        model: undefined,
        maxRetries: 3,
        requestContext: reqCtx,
      }),
    ).rejects.toThrow("Forbidden")

    expect(recording.retries).toHaveLength(0)
  })

  test("missing requestContext suppresses retry events", async () => {
    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Network reset", 502, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    const result = await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("network-retry")],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      // requestContext intentionally omitted (mirrors web_search internal hops)
    })

    expect(result.totalRetries).toBe(1)
    expect(recording.retries).toHaveLength(0)
  })

  test("budget-exhausted retry produces no extra retry event", async () => {
    // Strategy always wants to retry, but maxRetries=1 lets exactly 1 retry through.
    // We send 3 failing executes:
    //   exec 0: fails → strategy says retry, budget allows (normalRetries 0→1) → emit [RETRY-1]
    //   exec 1: fails → strategy says retry, budget exhausted → break, NO emit
    // So we expect exactly 1 emission, and the final error propagates.
    const manager = createRequestContextManager()
    const tuiLogId = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "gpt-test" })
    const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
    reqCtx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })

    const executeFn = mock(async () => {
      throw new HTTPError("Network reset", 502, "")
    })
    const adapter = makeAdapter(executeFn)

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [alwaysRetry("network-retry")],
        payload: basePayload,
        originalPayload: basePayload,
        model: undefined,
        maxRetries: 1,
        requestContext: reqCtx,
      }),
    ).rejects.toThrow("Network reset")

    // 1 initial + 1 retry = 2 calls (budget exhausted before a 3rd)
    expect(executeFn).toHaveBeenCalledTimes(2)
    // Only the accepted retry emitted; the budget-rejected one did not.
    expect(recording.retries).toHaveLength(1)
    expect(recording.retries[0].info.attempt).toBe(1)
  })
})
