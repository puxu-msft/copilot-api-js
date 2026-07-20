import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/retry-types"

import {
  //
  isAnthropicBetaUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import {
  //
  createUnsupportedBetaRetryStrategy,
  enumerateExclusionSubsets,
  parseUnsupportedBetas,
} from "~/lib/request/strategies/unsupported-beta-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4.7-1m-internal" },
  model: undefined,
}

function unsupportedBetaError(message = "unsupported beta header(s): context-1m-2025-08-07"): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ error: { message } }) },
  } as unknown as ApiError
}

/**
 * The laconic upstream form: `{"message":"invalid beta flag"}` with no list of
 * offending tokens. Our own outer wrapper message ("Failed to create Anthropic
 * messages") does NOT contain the upstream text — it lives only in the
 * HTTPError responseText, mirroring production (client.ts throws HTTPError).
 */
function invalidBetaFlagError(): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: "HTTP 400: Failed to create Anthropic messages",
    raw: new HTTPError("Failed to create Anthropic messages", 400, JSON.stringify({ message: "invalid beta flag" })),
  } as unknown as ApiError
}

describe("enumerateExclusionSubsets", () => {
  test("enumerates non-empty subsets by ascending size, in candidate order", () => {
    expect(enumerateExclusionSubsets(["a", "b", "c"])).toEqual([["a"], ["b"], ["c"], ["a", "b"], ["a", "c"], ["b", "c"], ["a", "b", "c"]])
  })

  test("respects the limit cap", () => {
    expect(enumerateExclusionSubsets(["a", "b", "c", "d"], 3)).toEqual([["a"], ["b"], ["c"]])
  })

  test("returns empty for empty candidates", () => {
    expect(enumerateExclusionSubsets([])).toEqual([])
  })
})

describe("parseUnsupportedBetas", () => {
  test("extracts a single beta token", () => {
    expect(parseUnsupportedBetas("unsupported beta header(s): context-1m-2025-08-07")).toEqual(["context-1m-2025-08-07"])
  })

  test("extracts multiple beta tokens", () => {
    expect(parseUnsupportedBetas("unsupported beta header(s): a, b, c")).toEqual(["a", "b", "c"])
  })

  test("returns empty for unrelated messages", () => {
    expect(parseUnsupportedBetas("Invalid request body")).toEqual([])
  })
})

describe("createUnsupportedBetaRetryStrategy", () => {
  test("has the expected name", () => {
    expect(createUnsupportedBetaRetryStrategy<TestPayload>().name).toBe("unsupported-beta-retry")
  })

  test("canHandle matches unsupported-beta errors", () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    expect(strategy.canHandle(unsupportedBetaError())).toBe(true)
  })

  test("canHandle ignores unrelated 400 errors", () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    const err = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: something else",
      raw: {},
    } as unknown as ApiError
    expect(strategy.canHandle(err)).toBe(false)
  })

  test("handle marks each beta unsupported and requests a retry", async () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4.7-1m-internal" }
    const action = await strategy.handle(unsupportedBetaError("unsupported beta header(s): context-1m-2025-08-07, foo"), payload, retryContext)
    expect(action.action).toBe("retry")
    expect(isAnthropicBetaUnsupported(payload.model, "context-1m-2025-08-07")).toBe(true)
    expect(isAnthropicBetaUnsupported(payload.model, "foo")).toBe(true)
    expect(isAnthropicBetaUnsupported(payload.model, "unrelated")).toBe(false)
  })

  test("retry action carries explicit prepareHints.excludeBetas (H4 regression guard)", async () => {
    // H4: previously the strategy only mutated the global negotiation cache,
    // relying on the adapter to re-prepare and re-read it on the next attempt.
    // That contract was implicit and easy to break by any future adapter
    // memoization. The fix returns an authoritative `prepareHints` payload
    // that flows through the pipeline → adapter → prepare without depending
    // on the cache existing or being read.
    const strategy = createUnsupportedBetaRetryStrategy<{ model: string }>()
    const payload = { model: "claude-opus-4.6" }
    const action = await strategy.handle(unsupportedBetaError("unsupported beta header(s): context-1m-2025-08-07, foo"), payload, retryContext)
    expect(action.action).toBe("retry")
    if (action.action !== "retry") return // type narrowing
    expect(action.prepareHints).toBeDefined()
    expect(action.prepareHints?.excludeBetas).toEqual(["context-1m-2025-08-07", "foo"])
  })

  // ─── Laconic `invalid beta flag` probing ───

  test("canHandle matches laconic invalid-beta-flag errors", () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    expect(strategy.canHandle(invalidBetaFlagError())).toBe(true)
  })

  test("invalid beta flag → probes exclusion subsets by ascending size (learning retries)", async () => {
    const candidates = ["clientA", "clientB"]
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>({
      getProbeCandidates: () => candidates,
    })
    const payload: TestPayload = { model: "claude-sonnet-4.6" }

    const a1 = await strategy.handle(invalidBetaFlagError(), payload, retryContext)
    expect(a1).toMatchObject({
      action: "retry",
      learning: true,
      prepareHints: { excludeBetas: ["clientA"] },
      meta: { probedBetas: ["clientA"] },
    })

    const a2 = await strategy.handle(invalidBetaFlagError(), payload, retryContext)
    expect(a2).toMatchObject({ action: "retry", prepareHints: { excludeBetas: ["clientB"] } })

    const a3 = await strategy.handle(invalidBetaFlagError(), payload, retryContext)
    expect(a3).toMatchObject({ action: "retry", prepareHints: { excludeBetas: ["clientA", "clientB"] } })

    // Enumeration exhausted → abort (no more subsets to try)
    const a4 = await strategy.handle(invalidBetaFlagError(), payload, retryContext)
    expect(a4.action).toBe("abort")
  })

  test("does not fixate during probing — only excludes via hints", async () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>({
      getProbeCandidates: () => ["x"],
    })
    const payload: TestPayload = { model: "probe-model" }

    await strategy.handle(invalidBetaFlagError(), payload, retryContext)

    // The probe must NOT touch the negotiation cache — fixation happens only
    // on onResolved when a probe is confirmed to have succeeded.
    expect(isAnthropicBetaUnsupported("probe-model", "x")).toBe(false)
  })

  test("onResolved fixates the located minimal set (all elements necessary)", async () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>({
      getProbeCandidates: () => ["x", "y"],
    })
    const payload: TestPayload = { model: "resolve-model" }

    // Simulate the pipeline: the probe that excluded {x,y} succeeded.
    await strategy.onResolved?.({ payload, meta: { probedBetas: ["x", "y"] }, attempt: 3 })

    expect(isAnthropicBetaUnsupported("resolve-model", "x")).toBe(true)
    expect(isAnthropicBetaUnsupported("resolve-model", "y")).toBe(true)
  })

  test("onResolved is a no-op when meta carries no probedBetas (explicit-list path)", async () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "noop-model" }

    await strategy.onResolved?.({ payload, meta: { strippedBetas: ["a"] }, attempt: 1 })

    // Explicit-list path already fixates inside handle; onResolved must not
    // act on non-probe meta.
    expect(isAnthropicBetaUnsupported("noop-model", "a")).toBe(false)
  })
})
