/**
 * P2.6 / C2 — anthropic-messages codec + strategies unit tests.
 *
 * Pure-function surface (no manager/state runtime): identity translateOut /
 * renderResponse, the Anthropic-shaped error frame, and the 15-strategy ordered
 * assembly (RFC §12.9). `parse` (which needs the runtime) is covered in the
 * sibling `.it.test`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClassifiedStreamError,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type { SanitizeResult } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"

const NO_PREPROCESS = { strippedReadTagCount: 0, dedupedToolCallCount: 0 }

function makeCodec() {
  return createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: NO_PREPROCESS })
}

const fakeEnv = { body: { model: "claude-sonnet-4", messages: [] } } as unknown as RequestEnvelope

describe("anthropic codec — identity S2/S6", () => {
  test("translateOut is identity (bypass-direct, no translation)", () => {
    const codec = makeCodec()
    expect(codec.translateOut(fakeEnv)).toBe(fakeEnv)
  })

  test("renderResponse forwards the upstream frame verbatim", () => {
    const codec = makeCodec()
    const frame: UpstreamFrame = { data: '{"type":"content_block_delta"}', event: "content_block_delta" }
    expect(codec.renderResponse(frame, fakeEnv)).toBe(frame)
  })

  test("renderResponseNonStreaming forwards the upstream response verbatim", () => {
    const codec = makeCodec()
    const upstream = { id: "msg_1", type: "message", content: [] }
    expect(codec.renderResponseNonStreaming(upstream, fakeEnv)).toBe(upstream)
  })
})

describe("anthropic codec — formatError (Anthropic-shaped, double-typed)", () => {
  const cases: Array<[ClassifiedStreamError, string, string]> = [
    ["idle-timeout", "timeout_error", "Stream idle timeout"],
    ["shutdown", "overloaded_error", "Server is shutting down"],
    ["client-abort", "api_error", "Client disconnected"],
    ["other", "api_error", "Stream error"],
  ]

  for (const [kind, type, message] of cases) {
    test(`${kind} → { type: "error", error: { type: "${type}", message } }`, () => {
      const codec = makeCodec()
      const frame = codec.formatError(kind, fakeEnv)
      expect(frame.event).toBe("error")
      expect(JSON.parse(frame.data!)).toEqual({ type: "error", error: { type, message } })
    })
  }
})

describe("anthropic codec — createResponseAccumulator", () => {
  test("returns a fresh Anthropic stream accumulator (streamError control signal present in shape)", () => {
    const codec = makeCodec()
    const acc = codec.createResponseAccumulator()
    expect(acc.model).toBe("")
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
  })
})

describe("anthropic codec — prepareWire tool-field stripping", () => {
  // The codec's prepareWire is the S4 last-mile that maps env.prepareHints.* into
  // prepareAnthropicRequest opts. This closes the seam for excludeToolFields
  // (codec.ts) — asserting the per-attempt hint threads all the way to the wire,
  // alongside the always-on built-in default strip.
  function envWithTools(tools: unknown, prepareHints: Record<string, unknown> = {}): RequestEnvelope {
    return {
      model: undefined,
      body: { model: "claude-sonnet-4", max_tokens: 16, messages: [], tools },
      prepareHints,
    } as unknown as RequestEnvelope
  }

  test("built-in default strips eager_input_streaming through prepareWire", () => {
    const codec = makeCodec()
    const prepared = codec.prepareWire(envWithTools([{ name: "Read", input_schema: {}, eager_input_streaming: true }]))
    const tools = (prepared.body as { tools: Array<Record<string, unknown>> }).tools
    expect(tools[0].eager_input_streaming).toBeUndefined()
  })

  test("prepareHints.excludeToolFields threads to the wire (codec mapping)", () => {
    const codec = makeCodec()
    const prepared = codec.prepareWire(envWithTools([{ name: "Read", input_schema: {}, future_x: 1 }], { excludeToolFields: ["future_x"] }))
    const tools = (prepared.body as { tools: Array<Record<string, unknown>> }).tools
    expect(tools[0].future_x).toBeUndefined()
    expect(tools[0].name).toBe("Read")
  })
})

describe("buildAnthropicStrategies", () => {
  const stubResanitize = (p: MessagesPayload): SanitizeResult<MessagesPayload> => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 })
  const baseline = { model: "claude-sonnet-4", messages: [], max_tokens: 100 } as unknown as MessagesPayload

  test("yields the 15 strategies in order (9 shared-with-legacy incl. poisoned-thinking-retry + v4-only server-error-retry + tool-field-rejection + server-tool-rejection + structured-outputs-rejection + system-reject-retry + web-search-not-found-retry, RFC §12.9)", () => {
    const strategies = buildAnthropicStrategies({
      originalPayload: baseline,
      resanitize: stubResanitize,
      model: undefined,
      maxRetries: 5,
      betaProbe: createBetaProbe(undefined),
    })
    expect(strategies.map((s) => s.name)).toEqual([
      "network-retry",
      "server-error-retry",
      "token-refresh",
      "effort-learning",
      "tool-field-rejection-retry",
      "body-field-rejection-retry",
      "legacy-thinking-retry",
      "poisoned-thinking-retry",
      "unsupported-beta-retry",
      "server-tool-rejection-retry",
      "structured-outputs-rejection-retry",
      "system-reject-retry",
      "web-search-not-found-retry",
      "deferred-tool-retry",
      "auto-truncate",
    ])
  })

  test("threads the SAME betaProbe so unsupported-beta can read its candidates", () => {
    // Record an outbound beta on the shared probe, then confirm the candidates are
    // visible (the unsupported-beta strategy closes over `betaProbe.getCandidates`).
    const betaProbe = createBetaProbe("client-beta")
    betaProbe.recordOutbound({ "anthropic-beta": "client-beta,injected-beta" })
    const strategies = buildAnthropicStrategies({ originalPayload: baseline, resanitize: stubResanitize, model: undefined, maxRetries: 5, betaProbe })
    expect(strategies.find((s) => s.name === "unsupported-beta-retry")).toBeDefined()
    expect(betaProbe.getCandidates()).toEqual(["client-beta", "injected-beta"]) // client betas first (suspicion order)
  })
})
