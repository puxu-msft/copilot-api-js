import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { PreparedRequest } from "~/lib/pipeline/types"

import {
  //
  classifyServerExecutionRisk,
  createFrozenHedgePolicy,
  type HedgeEligibilityContext,
} from "~/lib/pipeline/generation/hedge-policy"

function wire(endpoint: PreparedRequest["url"], tools?: Array<Record<string, unknown>>): PreparedRequest {
  return {
    url: endpoint,
    headers: new Headers(),
    body: { model: "test-model", ...(tools && { tools }) },
    stream: true,
  }
}

function context(patch: Partial<HedgeEligibilityContext> = {}): HedgeEligibilityContext {
  // Primary has been physically dispatched; no secondary exists yet, so one hedge slot remains.
  return {
    nowMs: 300_000,
    primaryDispatchedAtMs: 0,
    wire: wire("/v1/messages"),
    semanticContentCommitted: false,
    winnerSelected: false,
    cancelled: false,
    settled: false,
    secondaryCandidates: 0,
    activeCandidates: 1,
    totalCandidates: 1,
    activeDispatches: 1,
    totalDispatches: 1,
    ...patch,
  }
}

function policy(overrides: Partial<Parameters<typeof createFrozenHedgePolicy>[0]> = {}) {
  return createFrozenHedgePolicy({
    enabled: true,
    thresholdMs: 300_000,
    maxSecondaryCandidates: 1,
    maxActiveCandidates: 2,
    maxTotalCandidates: 5,
    maxActiveDispatches: 2,
    maxTotalDispatches: 16,
    cleanupMarginMs: 10_000,
    responseHeaderTimeoutMs: 600_000,
    requestDeadlineAtMs: 1_200_000,
    ...overrides,
  })
}

describe("fast-retry hedge policy", () => {
  test("starts at the threshold measured from physical dispatch, not admission queue time", () => {
    const frozen = policy()

    expect(frozen.evaluate(context({ nowMs: 299_999 })).reason).toBe("threshold-not-reached")
    expect(frozen.evaluate(context({ nowMs: 300_000 }))).toMatchObject({ eligible: true, thresholdAtMs: 300_000 })
    // The request may have spent 100s in admission before physical dispatch; only the latter
    // starts the hedge clock, while the absolute request deadline still applies independently.
    expect(frozen.evaluate(context({ nowMs: 400_000, primaryDispatchedAtMs: 100_000 }))).toMatchObject({ eligible: true, thresholdAtMs: 400_000 })
    expect(frozen.evaluate(context({ primaryDispatchedAtMs: undefined }))).toMatchObject({ eligible: false, reason: "primary-not-dispatched" })
  })

  test("synthetic scaffold does not count as semantic progress, while a committed block does", () => {
    const frozen = policy()

    expect(frozen.evaluate(context({ syntheticScaffoldSent: true })).eligible).toBe(true)
    expect(frozen.evaluate(context({ syntheticScaffoldSent: true, semanticContentCommitted: true }))).toMatchObject({
      eligible: false,
      reason: "semantic-content-committed",
    })
  })

  test("rejects completed, cancelled, won, or exhausted generation topology", () => {
    const frozen = policy()

    expect(frozen.evaluate(context({ winnerSelected: true })).reason).toBe("winner-selected")
    expect(frozen.evaluate(context({ cancelled: true })).reason).toBe("generation-cancelled")
    expect(frozen.evaluate(context({ settled: true })).reason).toBe("generation-settled")
    expect(frozen.evaluate(context({ secondaryCandidates: 1 })).reason).toBe("secondary-budget-exhausted")
    expect(frozen.evaluate(context({ activeCandidates: 2 })).reason).toBe("active-candidate-budget-exhausted")
    expect(frozen.evaluate(context({ totalCandidates: 5 })).reason).toBe("total-candidate-budget-exhausted")
    expect(frozen.evaluate(context({ activeDispatches: 2 })).reason).toBe("active-dispatch-budget-exhausted")
    expect(frozen.evaluate(context({ totalDispatches: 16 })).reason).toBe("total-dispatch-budget-exhausted")
  })

  test("requires enough absolute request-deadline budget and treats zero timeout as disabled", () => {
    expect(policy({ requestDeadlineAtMs: 910_000 }).evaluate(context())).toMatchObject({ eligible: false, reason: "insufficient-deadline-budget" })
    expect(policy({ requestDeadlineAtMs: 910_001 }).evaluate(context()).eligible).toBe(true)
    expect(policy({ requestDeadlineAtMs: 0 }).evaluate(context()).eligible).toBe(true)
    expect(policy({ responseHeaderTimeoutMs: 0, expectedHedgeCompletionMs: 120_000 }).evaluate(context()).eligible).toBe(true)
    expect(() => policy({ responseHeaderTimeoutMs: 0, requestDeadlineAtMs: 0 })).toThrow(/finite hedge completion budget/i)
  })

  test("snapshots construction input instead of observing later config mutation", () => {
    const config = {
      enabled: true,
      thresholdMs: 300_000,
      maxSecondaryCandidates: 1,
      maxActiveCandidates: 2,
      maxTotalCandidates: 5,
      maxActiveDispatches: 2,
      maxTotalDispatches: 16,
      cleanupMarginMs: 10_000,
      responseHeaderTimeoutMs: 600_000,
      requestDeadlineAtMs: 1_200_000,
    }
    const frozen = createFrozenHedgePolicy(config)
    config.thresholdMs = 1
    config.maxSecondaryCandidates = 0

    expect(frozen.thresholdMs).toBe(300_000)
    expect(frozen.evaluate(context())).toMatchObject({ eligible: true, thresholdAtMs: 300_000 })
  })

  test("rejects invalid frozen policy limits at construction", () => {
    expect(() => policy({ thresholdMs: Number.NaN })).toThrow(/thresholdMs.*finite nonnegative/i)
    expect(() => policy({ maxSecondaryCandidates: 1.5 })).toThrow(/maxSecondaryCandidates.*nonnegative integer/i)
    expect(() => policy({ expectedHedgeCompletionMs: -1 })).toThrow(/hedge completion budget|expectedHedgeCompletionMs/i)
  })
})

describe("server execution risk", () => {
  test("classifies Anthropic server tools without blocking client-executed builtins or custom tools", () => {
    for (const type of ["web_search_20250305", "web_fetch_20250910", "code_execution_20250825", "tool_search_tool_regex_20251119"]) {
      expect(classifyServerExecutionRisk(wire("/v1/messages", [{ type }]))).toMatchObject({ kind: "server-executed", toolType: type })
    }
    for (const type of ["text_editor_20250728", "computer_20250124", "bash_20250124", "memory_20250818"]) {
      expect(classifyServerExecutionRisk(wire("/v1/messages", [{ type }]))).toEqual({ kind: "none" })
    }
    expect(classifyServerExecutionRisk(wire("/v1/messages", [{ name: "Edit", input_schema: { type: "object" } }]))).toEqual({ kind: "none" })
    expect(classifyServerExecutionRisk(wire("/v1/messages", [{ type: "future_builtin_20990101" }]))).toMatchObject({ kind: "unknown-api-tool" })
  })

  test("classifies Responses builtins from target wire while allowing function and custom tools", () => {
    for (const type of ["web_search", "file_search", "code_interpreter"]) {
      expect(classifyServerExecutionRisk(wire("/responses", [{ type }]))).toMatchObject({ kind: "server-executed", toolType: type })
      expect(classifyServerExecutionRisk(wire("ws:/responses", [{ type }]))).toMatchObject({ kind: "server-executed", toolType: type })
    }
    expect(
      classifyServerExecutionRisk(
        wire("/responses", [
          { type: "function", name: "lookup" },
          { type: "custom", name: "apply_patch" },
        ]),
      ),
    ).toEqual({
      kind: "none",
    })
    expect(classifyServerExecutionRisk(wire("/responses", [{ type: "future_builtin" }]))).toMatchObject({ kind: "unknown-api-tool" })
  })

  test("allows Chat Completions functions and conservatively rejects unknown typed or target tools", () => {
    expect(classifyServerExecutionRisk(wire("/chat/completions", [{ type: "function", function: { name: "lookup" } }]))).toEqual({ kind: "none" })
    expect(classifyServerExecutionRisk(wire("/chat/completions", [{ type: "future_builtin" }]))).toMatchObject({ kind: "unknown-api-tool" })
    expect(classifyServerExecutionRisk(wire("/future/generate", [{ type: "future_builtin" }]))).toMatchObject({ kind: "unknown-api-tool" })
  })

  test("blocks risky tools by default and preserves the diagnostic when explicitly allowed", () => {
    const risky = context({ wire: wire("/responses", [{ type: "web_search" }]) })

    expect(policy().evaluate(risky)).toMatchObject({ eligible: false, reason: "server-execution-risk", serverExecutionRisk: { kind: "server-executed" } })
    expect(policy({ allowServerTools: true }).evaluate(risky)).toMatchObject({ eligible: true, serverExecutionRisk: { kind: "server-executed" } })
  })
})
