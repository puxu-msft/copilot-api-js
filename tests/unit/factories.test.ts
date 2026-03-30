import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"

import {
  mockAnthropicPayload,
  mockApiError,
  mockHTTPError,
  mockRequestContext,
  mockResponsesPayload,
  mockServerToolPair,
  mockThinkingMessage,
  mockToolResultMessage,
  mockToolUseMessage,
} from "../helpers/factories"

describe("test factories", () => {
  test("mockAnthropicPayload returns a valid payload with overrides", () => {
    const payload = mockAnthropicPayload({ model: "claude-opus-4.6", stream: true })

    expect(payload.model).toBe("claude-opus-4.6")
    expect(payload.stream).toBe(true)
    expect(payload.max_tokens).toBe(1024)
    expect(payload.messages).toHaveLength(1)
  })

  test("mockToolUseMessage creates assistant tool_use blocks", () => {
    const message = mockToolUseMessage([{ id: "tool_1", name: "Bash", input: { cmd: "ls" } }])

    expect(message.role).toBe("assistant")
    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content[0]).toMatchObject({
      type: "tool_use",
      id: "tool_1",
      name: "Bash",
    })
  })

  test("mockToolResultMessage creates user tool_result blocks", () => {
    const message = mockToolResultMessage([{ tool_use_id: "tool_1", content: "done" }])

    expect(message.role).toBe("user")
    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool_1",
      content: "done",
    })
  })

  test("mockThinkingMessage creates thinking plus text blocks", () => {
    const message = mockThinkingMessage("internal reasoning", "final answer")

    expect(message.role).toBe("assistant")
    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "internal reasoning",
    })
    expect(message.content[1]).toMatchObject({
      type: "text",
      text: "final answer",
    })
  })

  test("mockServerToolPair creates matching assistant and user server-tool messages", () => {
    const pair = mockServerToolPair("web_search", { q: "Copilot" })

    expect(pair.assistant.role).toBe("assistant")
    expect(pair.user.role).toBe("user")
    expect(Array.isArray(pair.assistant.content)).toBe(true)
    expect(Array.isArray(pair.user.content)).toBe(true)
    expect(pair.assistant.content[0]).toMatchObject({
      type: "server_tool_use",
      name: "web_search",
    })
    expect(pair.user.content[0]).toMatchObject({
      type: "web_search_tool_result",
    })
  })

  test("mockResponsesPayload returns a valid payload with overrides", () => {
    const payload = mockResponsesPayload({ stream: true, input: [{ type: "message", role: "user", content: "Hi" }] })

    expect(payload.model).toBe("gpt-4o")
    expect(payload.stream).toBe(true)
    expect(Array.isArray(payload.input)).toBe(true)
  })

  test("mockHTTPError creates an HTTPError with body", () => {
    const error = mockHTTPError(429, "{\"error\":\"rate limited\"}")

    expect(error).toBeInstanceOf(HTTPError)
    expect(error.status).toBe(429)
    expect(error.responseText).toContain("rate limited")
  })

  test("mockApiError creates a structured ApiError", () => {
    const error = mockApiError("rate_limited", { retryAfter: 30, status: 429 })

    expect(error.type).toBe("rate_limited")
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe(30)
  })

  test("mockRequestContext creates a usable RequestContext", () => {
    const ctx = mockRequestContext()

    expect(ctx.id).toMatch(/^req_/)
    expect(ctx.endpoint).toBe("openai-chat-completions")
    expect(ctx.originalRequest?.model).toBe("gpt-4o")
    expect(ctx.state).toBe("pending")
  })
})
