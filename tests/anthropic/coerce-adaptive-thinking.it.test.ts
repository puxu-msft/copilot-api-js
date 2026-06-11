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

/** Model whose metadata declares adaptive thinking. */
function adaptiveModel(id = "claude-opus-4-7"): Model {
  return mockModel(id, {
    vendor: "Anthropic",
    capabilities: {
      family: "claude",
      type: "chat",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 64000, max_prompt_tokens: 180000 },
      supports: { adaptive_thinking: true },
    } as Model["capabilities"],
  })
}

function enabledThinkingPayload(model: string, budget = 10000): MessagesPayload {
  return {
    model,
    max_tokens: 64000,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    thinking: { type: "enabled", budget_tokens: budget },
  }
}

describe("coerceAdaptiveThinking", () => {
  test("basic (default): coerce enabled→adaptive, drops budget_tokens, no effort", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = adaptiveModel()
    const prepared = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-7"), { resolvedModel: model })

    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
    expect(prepared.wire.output_config).toBeUndefined()
  })

  test("name-fallback: rewrites even when metadata lacks adaptive_thinking (opus-4-8)", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    // mockModel without supports.adaptive_thinking → relies on name fallback
    const model = mockModel("claude-opus-4-8", { vendor: "Anthropic" })
    const prepared = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-8"), { resolvedModel: model })

    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
  })

  test("best_effort: maps budget→effort (low/medium/high)", () => {
    setStateForTests({ coerceAdaptiveThinking: "best_effort" })
    const model = adaptiveModel()

    const low = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-7", 4000), { resolvedModel: model })
    expect((low.wire.output_config as { effort?: string }).effort).toBe("low")

    const medium = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-7", 10000), { resolvedModel: model })
    expect((medium.wire.output_config as { effort?: string }).effort).toBe("medium")

    const high = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-7", 30000), { resolvedModel: model })
    expect((high.wire.output_config as { effort?: string }).effort).toBe("high")

    expect(low.wire.thinking).toEqual({ type: "adaptive" })
  })

  test("best_effort: does NOT override client-sent explicit effort", () => {
    setStateForTests({ coerceAdaptiveThinking: "best_effort" })
    const model = adaptiveModel()
    const payload = enabledThinkingPayload("claude-opus-4-7", 30000)
    payload.output_config = { effort: "low" }

    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })
    // client's "low" preserved (not overwritten by budget-derived "high")
    expect((prepared.wire.output_config as { effort?: string }).effort).toBe("low")
  })

  test("false: passes enabled thinking through unchanged", () => {
    setStateForTests({ coerceAdaptiveThinking: false })
    const model = adaptiveModel()
    const prepared = prepareAnthropicRequest(enabledThinkingPayload("claude-opus-4-7"), { resolvedModel: model })

    expect(prepared.wire.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })

  test("non-adaptive model: not rewritten", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = mockModel("claude-sonnet-4", { vendor: "Anthropic" })
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 8000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 4000 },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })

    // budget clamped to < max_tokens but type stays enabled (no coercion)
    expect((prepared.wire.thinking as { type: string }).type).toBe("enabled")
  })

  test("metadata precedence: positive max_thinking_budget (no adaptive flag) is NOT coerced even for opus-4-6 name", () => {
    // A model whose metadata positively declares budget-based thinking must be
    // respected predictively — name fallback only fills metadata gaps, never
    // overrides a positive enabled-thinking signal. The reactive retry strategy
    // is the safety net if upstream still rejects.
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = mockModel("claude-opus-4.6", {
      vendor: "Anthropic",
      capabilities: {
        type: "chat",
        supports: { min_thinking_budget: 2048, max_thinking_budget: 4096 },
      } as Model["capabilities"],
    })
    const payload: MessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 8192,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 3000 },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })
    expect((prepared.wire.thinking as { type: string }).type).toBe("enabled")
  })

  test("already adaptive: no-op", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = adaptiveModel()
    const payload: MessagesPayload = {
      model: "claude-opus-4-7",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "adaptive" },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })
    expect(prepared.wire.thinking).toEqual({ type: "adaptive" })
  })

  test("disabled thinking: no-op", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = adaptiveModel()
    const payload: MessagesPayload = {
      model: "claude-opus-4-7",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "disabled" },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })
    expect(prepared.wire.thinking).toEqual({ type: "disabled" })
  })

  test("preserves display field when rewriting", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = adaptiveModel()
    const payload: MessagesPayload = {
      model: "claude-opus-4-7",
      max_tokens: 64000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 10000, display: "omitted" },
    }
    const prepared = prepareAnthropicRequest(payload, { resolvedModel: model })
    expect(prepared.wire.thinking).toEqual({ type: "adaptive", display: "omitted" })
  })

  test("does not mutate the caller's payload", () => {
    setStateForTests({ coerceAdaptiveThinking: "basic" })
    const model = adaptiveModel()
    const payload = enabledThinkingPayload("claude-opus-4-7")
    prepareAnthropicRequest(payload, { resolvedModel: model })
    // caller payload retains original enabled shape (wire was deep-cloned)
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })
})
