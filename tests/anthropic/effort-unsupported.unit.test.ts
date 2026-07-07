/**
 * Reactive-upstream-rejection feature B — the ZERO-support reasoning-effort
 * variant. Some models 400 with `... does not support reasoning effort` and NO
 * `supported values:[...]` list (distinct from the whitelist variant handled by
 * parseInvalidEffortError). We learn the model into the `effortUnsupported`
 * membership set (Task 6) and, on re-preparation, `clampEffortLevel` strips
 * `output_config.effort` entirely before the whitelist/clamp logic.
 *
 * The unchanged effort-learning retry strategy drives the reactive loop: its
 * `learn` leg (extended `learnEffortsFromError`) returns true → retry →
 * re-prepare strips. This suite covers the parse branch, the learn extension,
 * and the clamp-strip via the public prepareAnthropicRequest entry (clampEffortLevel
 * is module-private — driven through the `clamp-effort` prepare step, never exported).
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  clearAnthropicFeatureNegotiationForTests,
  isEffortUnsupported,
  markEffortUnsupported,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  ANTHROPIC_PREPARE_STEPS,
  learnEffortsFromError,
  parseEffortUnsupportedError,
  prepareAnthropicRequest,
  type PrepareStep,
} from "~/lib/anthropic/request-preparation"
import { HTTPError } from "~/lib/error"
import { createEffortLearningRetryStrategy } from "~/lib/request/strategies/effort-learning-retry"

// Real upstream body (RFC §3.3 empirical req_1783390118141_26): zero-support wording, no supported list.
const ZERO_SUPPORT_BODY = JSON.stringify({
  error: {
    message: 'output_config.effort "high" was provided, but model claude-haiku-4.5 does not support reasoning effort',
    code: "invalid_reasoning_effort",
  },
})

// The whitelist variant (handled by parseInvalidEffortError) — NOT this branch.
const WHITELIST_BODY = JSON.stringify({
  error: { message: 'output_config.effort "high" is not supported by model claude-opus-4.7; supported values: [medium]', code: "invalid_reasoning_effort" },
})

// Isolate the clamp-effort step via the DI seam — avoids cache-control /
// build-headers (which read runtime state/token). buildWirePayload still
// deep-clones output_config, so the input payload is never mutated.
const clampStep = ANTHROPIC_PREPARE_STEPS.find((s) => s.name === "clamp-effort") as PrepareStep
const clampOnly: ReadonlyArray<PrepareStep> = [clampStep]

function effortPayload(model = "claude-haiku-4.5"): MessagesPayload {
  return {
    model,
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "high" },
  } as MessagesPayload
}

afterEach(() => {
  clearAnthropicFeatureNegotiationForTests()
})

describe("parseEffortUnsupportedError", () => {
  test("extracts the model from the zero-support variant", () => {
    expect(parseEffortUnsupportedError(ZERO_SUPPORT_BODY)).toBe("claude-haiku-4.5")
  })

  test("returns null for the whitelist variant (has supported values)", () => {
    // The whitelist branch is parseInvalidEffortError's job, not this one.
    expect(parseEffortUnsupportedError(WHITELIST_BODY)).toBeNull()
  })

  test("returns null for an unrelated 400", () => {
    expect(parseEffortUnsupportedError(JSON.stringify({ error: { message: "messages: Field required" } }))).toBeNull()
  })

  test("returns null when the code is present but the wording is absent", () => {
    expect(parseEffortUnsupportedError(JSON.stringify({ error: { message: "something else", code: "invalid_reasoning_effort" } }))).toBeNull()
  })
})

describe("learnEffortsFromError — zero-support branch", () => {
  test("learns the zero-support model into the effortUnsupported set", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(learnEffortsFromError(ZERO_SUPPORT_BODY)).toBe(true)
    expect(isEffortUnsupported("claude-haiku-4.5")).toBe(true)
  })

  test("still learns the whitelist variant (existing branch untouched)", () => {
    clearAnthropicFeatureNegotiationForTests()
    // Whitelist variant must NOT mark the model unsupported — it records a whitelist.
    expect(learnEffortsFromError(WHITELIST_BODY)).toBe(true)
    expect(isEffortUnsupported("claude-opus-4.7")).toBe(false)
  })

  test("returns false for an unlearnable 400 (no loop)", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(learnEffortsFromError(JSON.stringify({ error: { message: "Extra inputs are not permitted" } }))).toBe(false)
  })
})

describe("clampEffortLevel — zero-support strip (via prepareAnthropicRequest)", () => {
  test("strips output_config.effort when the model is effort-unsupported", () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    const { wire } = prepareAnthropicRequest(effortPayload(), undefined, clampOnly)
    expect((wire.output_config as { effort?: string } | undefined)?.effort).toBeUndefined()
  })

  test("drops output_config entirely when effort was its only key", () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    const { wire } = prepareAnthropicRequest(effortPayload(), undefined, clampOnly)
    expect(wire.output_config).toBeUndefined()
  })

  test("keeps other output_config keys when only effort is stripped", () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    const payload = {
      ...effortPayload(),
      output_config: { effort: "high", format: { type: "json_schema", schema: {} } },
    } as MessagesPayload
    const { wire } = prepareAnthropicRequest(payload, undefined, clampOnly)
    expect(wire.output_config).toEqual({ format: { type: "json_schema", schema: {} } })
  })

  test("leaves output_config.effort intact for a still-supported model", () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    const { wire } = prepareAnthropicRequest(effortPayload("claude-opus-4-6"), undefined, clampOnly)
    expect((wire.output_config as { effort?: string }).effort).toBe("high")
  })
})

describe("reactive closed loop — learn zero-support then re-prepare strips", () => {
  test("learnEffortsFromError(ZERO_SUPPORT_BODY) → prepareAnthropicRequest strips effort (deterministic 10×)", () => {
    for (let i = 0; i < 10; i++) {
      clearAnthropicFeatureNegotiationForTests()
      // Pre-learn: effort passes through (nothing learned yet).
      const before = prepareAnthropicRequest(effortPayload(), undefined, clampOnly)
      expect((before.wire.output_config as { effort?: string }).effort).toBe("high")

      // The retry strategy's `learn` leg on the first-400 zero-support body.
      expect(learnEffortsFromError(ZERO_SUPPORT_BODY)).toBe(true)
      expect(isEffortUnsupported("claude-haiku-4.5")).toBe(true)

      // Re-preparation on the retried attempt: the strip removes output_config.effort.
      const after = prepareAnthropicRequest(effortPayload(), undefined, clampOnly)
      expect(after.wire.output_config).toBeUndefined()
    }
  })
})

// Composition seam: feature B routes through the UNCHANGED effort-learning retry
// strategy, whose canHandle gates on the body containing `invalid_reasoning_effort`.
// A positive sample proves the seam is real (empirical-verification: canHandle
// actually fires on the zero-support body), not merely assumed.
describe("effort-learning strategy composition seam", () => {
  test("effort-learning strategy canHandle fires on the zero-support body (composition seam)", () => {
    const strategy = createEffortLearningRetryStrategy({ learn: () => true })
    const err = { type: "bad_request" as const, status: 400, message: "HTTP 400", raw: new HTTPError("boom", 400, ZERO_SUPPORT_BODY, "claude-haiku-4.5") }
    expect(strategy.canHandle(err)).toBe(true)
  })
})
