/**
 * P1.4 — O10 (max_completion_tokens auto-fill) extracted from the inline CC
 * handler step into a named, testable function. Asserts byte-equivalence with
 * the prior inline logic (the oracle) across the token-field presence matrix.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { fillMaxCompletionTokens } from "~/lib/openai/request-preparation"
import { isNullish } from "~/lib/utils"

function payload(extra: Partial<ChatCompletionsPayload>): ChatCompletionsPayload {
  return { model: "gpt-5", messages: [{ role: "user", content: "hi" }], ...extra } as unknown as ChatCompletionsPayload
}

function modelWithLimit(maxOutput: number | undefined): Model {
  return { id: "gpt-5", capabilities: { limits: { max_output_tokens: maxOutput } } } as unknown as Model
}

/** The exact prior inline logic — the byte-equivalence oracle. */
function oracle(p: ChatCompletionsPayload, selectedModel: Model | undefined): ChatCompletionsPayload {
  const hasMaxTokens = !isNullish(p.max_tokens) || !isNullish(p.max_completion_tokens)
  return hasMaxTokens ? p : { ...p, max_completion_tokens: selectedModel?.capabilities?.limits?.max_output_tokens }
}

describe("fillMaxCompletionTokens (O10)", () => {
  const model = modelWithLimit(4096)

  test("fills max_completion_tokens from model limit when neither field is present", () => {
    const p = payload({})
    const result = fillMaxCompletionTokens(p, model)
    expect(result.max_completion_tokens).toBe(4096)
    expect(result).toEqual(oracle(p, model))
  })

  test("passthrough (same ref) when max_tokens is present", () => {
    const p = payload({ max_tokens: 100 })
    const result = fillMaxCompletionTokens(p, model)
    expect(result).toBe(p)
    expect(result).toEqual(oracle(p, model))
  })

  test("passthrough (same ref) when max_completion_tokens is present", () => {
    const p = payload({ max_completion_tokens: 200 })
    const result = fillMaxCompletionTokens(p, model)
    expect(result).toBe(p)
    expect(result).toEqual(oracle(p, model))
  })

  test("fills with undefined when no model is resolved (matches inline behavior)", () => {
    const p = payload({})
    const result = fillMaxCompletionTokens(p, undefined)
    expect(result.max_completion_tokens).toBeUndefined()
    expect("max_completion_tokens" in result).toBe(true)
    expect(result).toEqual(oracle(p, undefined))
  })

  test("does not mutate the input payload when filling", () => {
    const p = payload({})
    fillMaxCompletionTokens(p, model)
    expect("max_completion_tokens" in p).toBe(false)
  })
})
