/**
 * Hub-and-spoke shared translation layer — request dispatch (T2.1, RFC §4.2).
 *
 * Verifies `translateRequestVia` routes each (sourceFormat × targetEndpoint) cell to the correct
 * translator (asserting the OUTPUT SHAPE, not re-testing the translators' internals — those have
 * their own suites), and that the response-side skeleton throws (translation legs are end-to-end
 * fail-fast until Phase 3/4).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  renderResponseVia,
  translateRequestVia,
} from "~/lib/pipeline/hub-translate"

const anthropicBody: MessagesPayload = {
  model: "claude-x",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
}
const ccBody: ChatCompletionsPayload = {
  model: "gpt-x",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
}
const responsesBody = { model: "gpt-x", instructions: "sys", input: "hi" } as unknown as ResponsesPayload

describe("translateRequestVia — forward legs (→ CC-canonical)", () => {
  test("anthropic → /chat/completions produces a CC body (system message + user)", () => {
    const out = translateRequestVia("anthropic", ENDPOINT.CHAT_COMPLETIONS, anthropicBody) as ChatCompletionsPayload
    expect(out.model).toBe("claude-x")
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" })
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("anthropic → /responses ALSO produces a CC body (the CC→Responses wire step stays in prepareWire)", () => {
    const out = translateRequestVia("anthropic", ENDPOINT.RESPONSES, anthropicBody) as ChatCompletionsPayload
    // Still CC-shaped (has `messages`, not Responses `input`).
    expect(Array.isArray(out.messages)).toBe(true)
    expect((out as unknown as { input?: unknown }).input).toBeUndefined()
  })

  test("openai-cc / gemini → CC leg is identity (already CC)", () => {
    expect(translateRequestVia("openai-cc", ENDPOINT.CHAT_COMPLETIONS, ccBody)).toBe(ccBody)
    expect(translateRequestVia("gemini", ENDPOINT.CHAT_COMPLETIONS, ccBody)).toBe(ccBody)
  })

  test("openai-responses → CC leg translates Responses → CC", () => {
    const out = translateRequestVia("openai-responses", ENDPOINT.CHAT_COMPLETIONS, responsesBody) as ChatCompletionsPayload
    expect(Array.isArray(out.messages)).toBe(true)
    // instructions → system message
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" })
  })
})

describe("translateRequestVia — reverse legs (→ /v1/messages)", () => {
  test("openai-cc → /v1/messages produces an Anthropic body (system extracted, user message)", () => {
    const out = translateRequestVia("openai-cc", ENDPOINT.MESSAGES, ccBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("gemini → /v1/messages shares the cc→anthropic translator (no gemini-held anthropic sub-codec)", () => {
    const out = translateRequestVia("gemini", ENDPOINT.MESSAGES, ccBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("openai-responses → /v1/messages two-hops Responses → CC → Anthropic", () => {
    const out = translateRequestVia("openai-responses", ENDPOINT.MESSAGES, responsesBody) as MessagesPayload
    expect(out.system).toBe("sys")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("anthropic → /v1/messages is defensive identity (the direct path never routes here)", () => {
    expect(translateRequestVia("anthropic", ENDPOINT.MESSAGES, anthropicBody)).toBe(anthropicBody)
  })
})

describe("renderResponseVia — response side is fail-fast (Phase 3/4)", () => {
  test("throws (translation legs stay end-to-end fail-fast until response translation lands)", () => {
    expect(() => renderResponseVia()).toThrow(/response-side translation is not wired/)
  })
})
