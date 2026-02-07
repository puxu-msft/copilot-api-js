import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"

describe("HTTPError", () => {
  test("should create error with status and response text", () => {
    const error = new HTTPError("Test error", 400, "Bad request")

    expect(error.message).toBe("Test error")
    expect(error.status).toBe(400)
    expect(error.responseText).toBe("Bad request")
    expect(error.modelId).toBeUndefined()
  })

  test("should create error with model ID", () => {
    const error = new HTTPError("Token limit", 400, '{"error":"too long"}', "claude-sonnet-4")

    expect(error.modelId).toBe("claude-sonnet-4")
    expect(error.status).toBe(400)
  })

  test("should create error from Response", async () => {
    const response = new Response("Server error body", { status: 500 })
    const error = await HTTPError.fromResponse("Server error", response, "gpt-4o")

    expect(error.status).toBe(500)
    expect(error.responseText).toBe("Server error body")
    expect(error.modelId).toBe("gpt-4o")
  })

  test("should be an instance of Error", () => {
    const error = new HTTPError("test", 400, "body")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(HTTPError)
  })
})

describe("Error message formats", () => {
  test("OpenAI token limit error format should be parseable", () => {
    // Test the format that parseTokenLimitError handles internally
    const openaiMessage = "prompt token count of 135355 exceeds the limit of 128000"
    const match = openaiMessage.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)

    expect(match).not.toBeNull()
    expect(Number.parseInt(match![1], 10)).toBe(135355)
    expect(Number.parseInt(match![2], 10)).toBe(128000)
  })

  test("Anthropic token limit error format should be parseable", () => {
    const anthropicMessage = "prompt is too long: 208598 tokens > 200000 maximum"
    const match = anthropicMessage.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)

    expect(match).not.toBeNull()
    expect(Number.parseInt(match![1], 10)).toBe(208598)
    expect(Number.parseInt(match![2], 10)).toBe(200000)
  })

  test("should not match unrelated error messages", () => {
    const unrelatedMessage = "Invalid API key"
    const openaiMatch = unrelatedMessage.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)
    const anthropicMatch = unrelatedMessage.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)

    expect(openaiMatch).toBeNull()
    expect(anthropicMatch).toBeNull()
  })
})
