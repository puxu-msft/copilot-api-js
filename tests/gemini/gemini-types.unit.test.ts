/**
 * Contract tests for the Gemini ↔ OpenAI type conversion layer. These
 * exercise the conversion modules directly (no HTTP); HTTP-level coverage
 * lives in tests/gemini/gemini.http.test.ts.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { GenerateContentRequest } from "~/types/api/gemini"
import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"

import {
  //
  convertGeminiRequestToOpenAI,
  convertOpenAIResponseToGemini,
} from "~/lib/gemini"

describe("convertGeminiRequestToOpenAI", () => {
  test("translates a text-only user turn", () => {
    const body: GenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams

    expect(out.model).toBe("gpt-4o")
    expect(out.messages).toEqual([{ role: "user", content: "hello" }])
    expect(out.stream).toBe(false)
  })

  test("includes systemInstruction as a system message", () => {
    const body: GenerateContentRequest = {
      systemInstruction: { role: "user", parts: [{ text: "Be terse." }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams

    expect(out.messages[0]).toEqual({ role: "system", content: "Be terse." })
  })

  test("converts inlineData to an image_url content part", () => {
    const body: GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "BASE64DATA" } }],
        },
      ],
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams
    const msg = out.messages[0]
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as Array<{ type: string; image_url?: { url: string }; text?: string }>
    expect(parts[1].type).toBe("image_url")
    expect(parts[1].image_url?.url).toBe("data:image/png;base64,BASE64DATA")
  })

  test("converts functionCall + functionResponse with explicit ids", () => {
    const body: GenerateContentRequest = {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "call_1", name: "lookup", response: { ok: true } } }],
        },
      ],
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams
    expect(out.messages[0].role).toBe("assistant")
    expect(out.messages[0].tool_calls?.[0].id).toBe("call_1")
    expect(out.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true}',
    })
  })

  test("pairs functionResponse without id via FIFO (langchain-google-genai style)", () => {
    const body: GenerateContentRequest = {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }, { functionCall: { name: "lookup", args: { q: "y" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "lookup", response: { v: 1 } } }, { functionResponse: { name: "lookup", response: { v: 2 } } }],
        },
      ],
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams
    const toolCalls = out.messages[0].tool_calls
    expect(toolCalls).toBeDefined()
    expect(toolCalls?.[0].id).toBeTruthy()
    expect(toolCalls?.[1].id).toBeTruthy()
    expect(toolCalls?.[0].id).not.toBe(toolCalls?.[1].id)
    expect(out.messages[1].tool_call_id).toBe(toolCalls?.[0].id)
    expect(out.messages[2].tool_call_id).toBe(toolCalls?.[1].id)
  })

  test("maps generationConfig fields to OpenAI fields", () => {
    const body: GenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        temperature: 0.5,
        topP: 0.9,
        maxOutputTokens: 256,
        stopSequences: ["\nEND"],
      },
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.max_completion_tokens).toBe(256)
    expect(out.stop).toEqual(["\nEND"])
  })

  test("maps toolConfig.functionCallingConfig.mode to tool_choice", () => {
    const body: GenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      // The SDK types `mode` as an enum; client code wires strings on the
      // JSON line. Cast through unknown to mimic the runtime wire shape.
      toolConfig: { functionCallingConfig: { mode: "ANY" as unknown as never } },
    }
    const { payload: out, droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    void droppedParams
    expect(out.tool_choice).toBe("required")
  })

  test("reports droppedParams for unsupported top-level keys", () => {
    const body = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      safetySettings: [{ category: "x", threshold: "y" }],
      responseSchema: { type: "object" },
      cachedContent: "abc",
      thinkingConfig: { thinkingBudget: 1024 },
    } as unknown as GenerateContentRequest
    const { droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    expect(droppedParams).toEqual(["safetySettings", "responseSchema", "cachedContent", "thinkingConfig"])
  })

  test("droppedParams is empty when no lossy fields present", () => {
    const body: GenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }
    const { droppedParams } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    expect(droppedParams).toEqual([])
  })

  test("extractTextFromContent emits placeholders for non-text systemInstruction parts", () => {
    const body: GenerateContentRequest = {
      systemInstruction: {
        role: "user",
        parts: [{ text: "Be helpful." }, { inlineData: { mimeType: "image/png", data: "abc" } }, { fileData: { fileUri: "gs://bucket/file" } }],
      },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }
    const { payload: out } = convertGeminiRequestToOpenAI(body, { model: "gpt-4o", stream: false })
    expect(out.messages[0].role).toBe("system")
    const content = out.messages[0].content as string
    expect(content).toContain("Be helpful.")
    expect(content).toContain("[inline data dropped: image/png]")
    expect(content).toContain("[file data dropped: gs://bucket/file]")
  })
})

describe("convertOpenAIResponseToGemini", () => {
  const baseResponse: ChatCompletionResponse = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello world" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  }

  test("emits a candidate with text part and STOP finishReason", () => {
    const out = convertOpenAIResponseToGemini(baseResponse, "gpt-4o")
    expect(out.candidates?.[0].content?.role).toBe("model")
    expect(out.candidates?.[0].content?.parts).toEqual([{ text: "Hello world" }])
    expect(out.candidates?.[0].finishReason as string).toBe("STOP")
  })

  test("emits functionCall parts for tool_calls", () => {
    const r: ChatCompletionResponse = {
      ...baseResponse,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    }
    const out = convertOpenAIResponseToGemini(r, "gpt-4o")
    const parts = out.candidates?.[0].content?.parts
    expect(parts?.[0].functionCall?.name).toBe("lookup")
    expect(parts?.[0].functionCall?.args).toEqual({ q: "x" })
    // tool_calls maps to STOP (Gemini lacks a tool-call-specific finish reason)
    expect(out.candidates?.[0].finishReason as string).toBe("STOP")
  })

  test("usageMetadata splits cached and reasoning tokens", () => {
    const r: ChatCompletionResponse = {
      ...baseResponse,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 175,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 25 },
      },
    }
    const out = convertOpenAIResponseToGemini(r, "gpt-4o")
    expect(out.usageMetadata.promptTokenCount).toBe(80) // 100 − 20
    expect(out.usageMetadata.candidatesTokenCount).toBe(50)
    expect(out.usageMetadata.cachedContentTokenCount).toBe(20)
    expect(out.usageMetadata.thoughtsTokenCount).toBe(25)
    expect(out.usageMetadata.totalTokenCount).toBe(175)
  })
})
