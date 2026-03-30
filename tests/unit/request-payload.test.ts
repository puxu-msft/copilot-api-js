import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { logPayloadSizeInfo, logPayloadSizeInfoAnthropic } from "~/lib/request/payload"

function createNoopLog() {
  return Object.assign((..._: Array<any>) => {}, { raw: (..._: Array<any>) => {} })
}

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    vendor: "OpenAI",
    object: "model",
    model_picker_enabled: true,
    preview: false,
    version: "gpt-4o",
    capabilities: {
      type: "chat",
      tokenizer: "o200k_base",
      limits: {
        max_prompt_tokens: 128000,
        max_output_tokens: 4096,
        max_context_window_tokens: 128000,
      },
    },
    ...overrides,
  } as Model
}

function getLoggedLines(infoSpy: ReturnType<typeof spyOn>): Array<string> {
  return infoSpy.mock.calls.map((call: Array<unknown>) => call.map((item) => String(item)).join(" "))
}

describe("request payload logging", () => {
  let infoSpy: ReturnType<typeof spyOn>
  let debugSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    const noop = createNoopLog()
    infoSpy = spyOn(consola, "info").mockImplementation(noop)
    debugSpy = spyOn(consola, "debug").mockImplementation(noop)
  })

  afterEach(() => {
    infoSpy.mockRestore()
    debugSpy.mockRestore()
  })

  test("logs OpenAI payload diagnostics including token estimate, images, and large messages", async () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abcd" } },
          ],
        },
        {
          role: "assistant",
          content: "x".repeat(60001),
        },
      ],
    }

    await logPayloadSizeInfo(payload, createModel())

    const lines = getLoggedLines(infoSpy)
    expect(lines.some((line) => line.includes("413 Request Entity Too Large"))).toBe(true)
    expect(lines.some((line) => line.includes("Request body size:"))).toBe(true)
    expect(lines.some((line) => line.includes("Estimated tokens:"))).toBe(true)
    expect(lines.some((line) => line.includes("Images: 1"))).toBe(true)
    expect(lines.some((line) => line.includes("Large messages (>50KB): 1"))).toBe(true)
    expect(lines.some((line) => line.includes("Remove or resize large images"))).toBe(true)
    expect(debugSpy).not.toHaveBeenCalled()
  })

  test("logs OpenAI payload diagnostics without model-specific token estimation", async () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "small request" }],
    }

    await logPayloadSizeInfo(payload, undefined, 1234)

    const lines = getLoggedLines(infoSpy)
    expect(lines.some((line) => line.includes("Request body size: 1 KB (1,234 bytes)"))).toBe(true)
    expect(lines.some((line) => line.includes("Estimated tokens:"))).toBe(false)
    expect(lines.some((line) => line.includes("Images:"))).toBe(false)
    expect(lines.some((line) => line.includes("Large messages (>50KB):"))).toBe(false)
  })

  test("logs Anthropic payload size and model limits", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
      tools: [
        {
          name: "lookup_weather",
          description: "Look up weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
      system: "system prompt",
    }

    logPayloadSizeInfoAnthropic(payload, createModel({ id: "claude-sonnet-4.6", vendor: "Anthropic" }))

    const lines = getLoggedLines(infoSpy)
    expect(lines.some((line) => line.includes("[Anthropic 413] Payload size:"))).toBe(true)
    expect(lines.some((line) => line.includes("messages: 1, tools: 1"))).toBe(true)
    expect(lines.some((line) => line.includes("Model limits: context=128000, prompt=128000, output=4096"))).toBe(true)
  })
})
