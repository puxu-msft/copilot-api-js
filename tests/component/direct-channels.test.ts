/**
 * Fixture-based regression tests for all 3 direct channels.
 *
 * These tests use real API response data captured from Copilot API.
 * They verify that our response structure expectations match reality,
 * and that fixture data remains structurally valid as code evolves.
 */

import { describe, expect, test } from "bun:test"

import { loadFixturePair, loadFollowupPair } from "../helpers/fixtures"

// ============================================================================
// Anthropic Messages
// ============================================================================

describe("fixtures: anthropic-messages", () => {
  describe("simple", () => {
    const { request, response } = loadFixturePair("anthropic-messages", "simple")

    test("request has required fields", () => {
      expect(request).toHaveProperty("model")
      expect(request).toHaveProperty("max_tokens")
      expect(request).toHaveProperty("messages")
      expect(request.messages).toBeArrayOfSize(1)
      expect(request.messages[0].role).toBe("user")
    })

    test("response has Anthropic message structure", () => {
      expect(response.type).toBe("message")
      expect(response.role).toBe("assistant")
      expect(response.stop_reason).toBe("end_turn")
      expect(response.model).toBeString()
      expect(response.id).toMatch(/^msg_/)
    })

    test("response has content array with text block", () => {
      expect(response.content).toBeArray()
      expect(response.content.length).toBeGreaterThanOrEqual(1)
      const textBlock = response.content.find((b: any) => b.type === "text")
      expect(textBlock).toBeDefined()
      expect(textBlock.text).toBeString()
    })

    test("response has usage data", () => {
      expect(response.usage).toBeDefined()
      expect(response.usage.input_tokens).toBeNumber()
      expect(response.usage.output_tokens).toBeNumber()
    })
  })

  describe("tool-use", () => {
    const { response } = loadFixturePair("anthropic-messages", "tool-use")

    test("response contains tool_use block", () => {
      expect(response.stop_reason).toBe("tool_use")
      const toolUseBlock = response.content.find((b: any) => b.type === "tool_use")
      expect(toolUseBlock).toBeDefined()
      expect(toolUseBlock.name).toBe("get_weather")
      expect(toolUseBlock.id).toBeString()
      expect(toolUseBlock.input).toBeObject()
    })

    test("tool_use has valid input", () => {
      const toolUseBlock = response.content.find((b: any) => b.type === "tool_use")
      expect(toolUseBlock.input).toHaveProperty("location")
    })
  })

  describe("tool-use follow-up", () => {
    const { request, response } = loadFollowupPair("anthropic-messages", "tool-use")

    test("follow-up request contains tool_result", () => {
      const lastMsg = request.messages.at(-1)
      expect(lastMsg.role).toBe("user")
      expect(Array.isArray(lastMsg.content)).toBe(true)
      const toolResult = lastMsg.content.find((b: any) => b.type === "tool_result")
      expect(toolResult).toBeDefined()
      expect(toolResult.tool_use_id).toBeString()
    })

    test("follow-up response is end_turn with text", () => {
      expect(response.stop_reason).toBe("end_turn")
      const textBlock = response.content.find((b: any) => b.type === "text")
      expect(textBlock).toBeDefined()
      expect(textBlock.text).toBeString()
    })
  })
})

// ============================================================================
// OpenAI Chat Completions
// ============================================================================

describe("fixtures: openai-chat-completions", () => {
  describe("simple", () => {
    const { request, response } = loadFixturePair("openai-chat-completions", "simple")

    test("request has required fields", () => {
      expect(request).toHaveProperty("model")
      expect(request).toHaveProperty("messages")
      expect(request.messages).toBeArrayOfSize(1)
      expect(request.messages[0].role).toBe("user")
    })

    test("response has Chat Completions structure", () => {
      expect(response).toHaveProperty("choices")
      expect(response.choices).toBeArrayOfSize(1)
      expect(response.id).toMatch(/^chatcmpl-/)
      expect(response.model).toBeString()
    })

    test("response choice has message with content", () => {
      const choice = response.choices[0]
      expect(choice.finish_reason).toBe("stop")
      expect(choice.message.role).toBe("assistant")
      expect(choice.message.content).toBeString()
    })

    test("response has usage data", () => {
      expect(response.usage).toBeDefined()
      expect(response.usage.prompt_tokens).toBeNumber()
      expect(response.usage.completion_tokens).toBeNumber()
    })

    test("response has Copilot-specific fields", () => {
      // Copilot adds content_filter_results and padding to messages
      const choice = response.choices[0]
      expect(choice).toHaveProperty("content_filter_results")
      expect(choice.message).toHaveProperty("padding")
    })
  })

  describe("tool-call", () => {
    const { response } = loadFixturePair("openai-chat-completions", "tool-call")

    test("response contains tool_calls", () => {
      const choice = response.choices[0]
      expect(choice.finish_reason).toBe("tool_calls")
      expect(choice.message.tool_calls).toBeArray()
      expect(choice.message.tool_calls.length).toBeGreaterThanOrEqual(1)
    })

    test("tool_call has valid structure", () => {
      const toolCall = response.choices[0].message.tool_calls[0]
      expect(toolCall.type).toBe("function")
      expect(toolCall.id).toBeString()
      expect(toolCall.function.name).toBe("get_weather")
      expect(toolCall.function.arguments).toBeString()
      // arguments should be valid JSON
      expect(() => JSON.parse(toolCall.function.arguments)).not.toThrow()
    })
  })

  describe("tool-call follow-up", () => {
    const { request, response } = loadFollowupPair("openai-chat-completions", "tool-call")

    test("follow-up request contains tool message", () => {
      const toolMsg = request.messages.find((m: any) => m.role === "tool")
      expect(toolMsg).toBeDefined()
      expect(toolMsg.tool_call_id).toBeString()
      expect(toolMsg.content).toBeString()
    })

    test("follow-up response is stop with content", () => {
      const choice = response.choices[0]
      expect(choice.finish_reason).toBe("stop")
      expect(choice.message.content).toBeString()
    })
  })
})

// ============================================================================
// OpenAI Responses
// ============================================================================

describe("fixtures: openai-responses", () => {
  describe("simple", () => {
    const { request, response } = loadFixturePair("openai-responses", "simple")

    test("request has required fields", () => {
      expect(request).toHaveProperty("model")
      expect(request).toHaveProperty("input")
      expect(request).toHaveProperty("max_output_tokens")
    })

    test("response has Responses structure", () => {
      expect(response.object).toBe("response")
      expect(response.status).toBe("completed")
      expect(response.model).toBeString()
      expect(response.id).toBeString()
    })

    test("response has output with message", () => {
      expect(response.output).toBeArray()
      expect(response.output.length).toBeGreaterThanOrEqual(1)
      const msg = response.output.find((item: any) => item.type === "message")
      expect(msg).toBeDefined()
      expect(msg.role).toBe("assistant")
      expect(msg.status).toBe("completed")
    })

    test("response message has output_text content", () => {
      const msg = response.output.find((item: any) => item.type === "message")
      expect(msg.content).toBeArray()
      const textContent = msg.content.find((c: any) => c.type === "output_text")
      expect(textContent).toBeDefined()
      expect(textContent.text).toBeString()
    })

    test("response has usage data", () => {
      expect(response.usage).toBeDefined()
      expect(response.usage.input_tokens).toBeNumber()
      expect(response.usage.output_tokens).toBeNumber()
    })
  })

  describe("function-call", () => {
    const { response } = loadFixturePair("openai-responses", "function-call")

    test("response contains function_call output item", () => {
      const funcCall = response.output.find((item: any) => item.type === "function_call")
      expect(funcCall).toBeDefined()
      expect(funcCall.name).toBe("get_weather")
      expect(funcCall.call_id).toBeString()
      expect(funcCall.arguments).toBeString()
      expect(() => JSON.parse(funcCall.arguments)).not.toThrow()
    })
  })

  describe("function-call follow-up", () => {
    const { request, response } = loadFollowupPair("openai-responses", "function-call")

    test("follow-up request contains function_call_output input", () => {
      const funcOutput = request.input.find((item: any) => item.type === "function_call_output")
      expect(funcOutput).toBeDefined()
      expect(funcOutput.call_id).toBeString()
      expect(funcOutput.output).toBeString()
    })

    test("follow-up response is completed with text", () => {
      expect(response.status).toBe("completed")
      const msg = response.output.find((item: any) => item.type === "message")
      expect(msg).toBeDefined()
      const textContent = msg.content.find((c: any) => c.type === "output_text")
      expect(textContent).toBeDefined()
      expect(textContent.text).toBeString()
    })
  })
})
