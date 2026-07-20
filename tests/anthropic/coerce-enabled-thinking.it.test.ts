import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"

const originalState = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(originalState)
})

/**
 * Model whose metadata POSITIVELY declares budget-based (enabled-only) thinking:
 * `max_thinking_budget > 0` and NO `adaptive_thinking` flag. This is the gate
 * `modelRequiresEnabledThinking` fires on. `maxBudget` defaults large so effort
 * tiers survive adjustThinkingBudget's clamp; pass a small value to exercise it.
 */
function enabledOnlyModel(id = "claude-haiku-4.5", maxBudget = 60_000): Model {
  return mockModel(id, {
    vendor: "Anthropic",
    capabilities: {
      family: "claude",
      type: "chat",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 64000, max_prompt_tokens: 180000 },
      supports: { min_thinking_budget: 1024, max_thinking_budget: maxBudget },
    } as Model["capabilities"],
  })
}

function adaptivePayload(model: string, effort?: string): MessagesPayload {
  const payload: MessagesPayload = {
    model,
    max_tokens: 64000,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    thinking: { type: "adaptive" },
  }
  if (effort) payload.output_config = { effort }
  return payload
}

describe("coerceEnabledThinking (prepare-time adaptive→enabled)", () => {
  test("enabled-only model: coerce adaptive→enabled with default (medium) budget", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const prepared = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5"), { resolvedModel: enabledOnlyModel() })

    // no effort → medium default 24576, within [1024, 60000] and < max_tokens → unchanged
    expect(prepared.wire.thinking).toEqual({ type: "enabled", budget_tokens: 24576 })
  })

  test("maps output_config.effort → budget_tokens (low/medium/high) and drops effort", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = enabledOnlyModel()

    const low = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5", "low"), { resolvedModel: model })
    expect(low.wire.thinking).toEqual({ type: "enabled", budget_tokens: 8192 })
    expect(low.wire.output_config).toBeUndefined()

    const medium = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5", "medium"), { resolvedModel: model })
    expect((medium.wire.thinking as { budget_tokens: number }).budget_tokens).toBe(24576)

    const high = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5", "high"), { resolvedModel: model })
    expect((high.wire.thinking as { budget_tokens: number }).budget_tokens).toBe(32768)
  })

  test("adjustThinkingBudget clamps the synthesized budget to the model window", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    // small window: high effort (32768) must clamp down to max_thinking_budget=4096
    const prepared = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5", "high"), {
      resolvedModel: enabledOnlyModel("claude-haiku-4.5", 4096),
    })
    expect(prepared.wire.thinking).toEqual({ type: "enabled", budget_tokens: 4096 })
  })

  test("preserves other output_config fields while dropping effort", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const payload = adaptivePayload("claude-haiku-4.5", "high")
    payload.output_config = { effort: "high", format: { type: "json_schema", schema: {} } }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: enabledOnlyModel() })
    expect(prepared.wire.output_config).toEqual({ format: { type: "json_schema", schema: {} } })
  })

  test("preserves display when rewriting", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const payload: MessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "adaptive", display: "omitted" } as MessagesPayload["thinking"],
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: enabledOnlyModel() })
    expect(prepared.wire.thinking).toEqual({ type: "enabled", budget_tokens: 24576, display: "omitted" })
  })

  test("adaptive model (adaptive_thinking metadata): NOT coerced", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = mockModel("claude-opus-4-7", {
      vendor: "Anthropic",
      capabilities: {
        family: "claude",
        type: "chat",
        supports: { adaptive_thinking: true },
      } as Model["capabilities"],
    })
    const prepared = prepareAnthropicRequest(adaptivePayload("claude-opus-4-7"), { resolvedModel: model })
    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
  })

  test("silent metadata (no supports): abstains — reactive strategy is the net", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    // mockModel default has no capabilities.supports → modelRequiresEnabledThinking false
    const model = mockModel("claude-mystery", { vendor: "Anthropic" })
    const prepared = prepareAnthropicRequest(adaptivePayload("claude-mystery"), { resolvedModel: model })
    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
  })

  test("config false: passes adaptive thinking through unchanged", () => {
    setStateForTests({ coerceAdaptiveThinking: false })
    const prepared = prepareAnthropicRequest(adaptivePayload("claude-haiku-4.5", "high"), { resolvedModel: enabledOnlyModel() })
    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
    expect((prepared.wire.output_config as { effort?: string }).effort).toBe("high")
  })

  test("enabled thinking: no-op for this transform", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const payload: MessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 10000 },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: enabledOnlyModel() })
    expect(prepared.wire.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })

  test("disabled thinking: no-op", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const payload: MessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "disabled" },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: enabledOnlyModel() })
    expect(prepared.wire.thinking).toEqual({ type: "disabled" })
  })

  test("does not mutate the caller's payload", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const payload = adaptivePayload("claude-haiku-4.5", "high")
    prepareAnthropicRequest(payload, { resolvedModel: enabledOnlyModel() })
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config).toEqual({ effort: "high" })
  })
})
