import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"

describe("@ai-sdk/openai smoke (Phase 5 delta-sensitive-consumer e2e dependency)", () => {
  test("createOpenAI(...).responses(modelId) returns a LanguageModelV4-shaped model", () => {
    const provider = createOpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" })
    const model = provider.responses("gpt-5")
    expect(model.specificationVersion).toBe("v4")
    expect(typeof model.doStream).toBe("function")
    expect(typeof model.doGenerate).toBe("function")
  })
})
